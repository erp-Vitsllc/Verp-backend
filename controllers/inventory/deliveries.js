import mongoose from 'mongoose';
import DeliveryOrder from '../../models/inventory/DeliveryOrder.js';
import InventoryItem from '../../models/inventory/InventoryItem.js';
import { escapeRegex } from '../../utils/regexHelper.js';
import { dubaiDateKey } from '../../utils/workOrderNumber.js';
import { httpError, sendError } from './http.js';
import {
    actorIsPurchaseOfficer,
    closeDeliveryApproval,
    findPurchaseOfficer,
    notifyDeliveryApproval,
} from './stockApproval.js';

const TYPES = new Set(['Project', 'Manual']);
const SCHEDULED = new Set(['Project']);

function clipLine(value, max) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clipBlock(value, max) {
    return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function presentDelivery(row) {
    return {
        id: String(row._id),
        deliveryNo: row.deliveryNo,
        deliveryType: row.deliveryType,
        status: row.status,
        doDate: row.doDate || '',
        projectName: row.projectName || '',
        workOrderId: row.workOrderId || '',
        workOrderNo: row.workOrderNo || '',
        customerId: row.customerId || '',
        customerName: row.customerName || '',
        deliveryAddress: row.deliveryAddress || '',
        contactPersonName: row.contactPersonName || '',
        contactNumber: row.contactNumber || '',
        note: row.note || '',
        lines: Array.isArray(row.lines) ? row.lines : [],
        createdAt: row.createdAt,
    };
}

function readLine(raw) {
    if (!raw || typeof raw !== 'object') throw httpError(400, 'Each delivery item needs a description.');
    const quantity = Number(raw.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999999) {
        throw httpError(400, 'Enter a whole quantity of at least 1.');
    }
    const description = clipLine(raw.description, 300);
    if (!description) throw httpError(400, 'Each delivery item needs a description.');
    const inventoryItemId = clipLine(raw.inventoryItemId, 40);
    if (!mongoose.isValidObjectId(inventoryItemId)) {
        throw httpError(400, 'Only items that are in stock can be added.');
    }
    return {
        categoryId: clipLine(raw.categoryId, 40),
        categoryName: clipLine(raw.categoryName, 120),
        subcategoryId: clipLine(raw.subcategoryId, 40),
        subcategoryName: clipLine(raw.subcategoryName, 120),
        itemOptionId: clipLine(raw.itemOptionId, 40),
        itemName: clipLine(raw.itemName, 160),
        brandId: clipLine(raw.brandId, 40),
        brandName: clipLine(raw.brandName, 120),
        modelNumber: clipLine(raw.modelNumber, 160),
        inventoryItemId,
        description,
        detail: clipLine(raw.detail, 300),
        quantity,
        unit: clipLine(raw.unit, 40),
    };
}

function readDelivery(body) {
    const deliveryType = clipLine(body?.deliveryType, 20);
    if (!TYPES.has(deliveryType)) throw httpError(400, 'Choose a delivery type.');
    const action = body?.action === 'draft' ? 'draft' : 'submit';
    const lines = Array.isArray(body?.lines) ? body.lines.map(readLine) : [];
    if (lines.length > 100) throw httpError(400, 'A delivery order can hold up to 100 items.');

    const customerName = clipLine(body?.customerName, 160);
    const customerId = clipLine(body?.customerId, 40);
    if (!customerId || !customerName) throw httpError(400, 'Choose a customer.');

    const doDate = clipLine(body?.doDate, 10);
    const projectName = clipLine(body?.projectName, 160);
    const deliveryAddress = clipBlock(body?.deliveryAddress, 500);
    const contactPersonName = clipLine(body?.contactPersonName, 160);
    const contactNumber = clipLine(body?.contactNumber, 40);
    const note = clipBlock(body?.note, 1000);

    if (action === 'submit') {
        if (SCHEDULED.has(deliveryType)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(doDate) || Number.isNaN(new Date(`${doDate}T00:00:00`).getTime())) {
                throw httpError(400, 'Choose a delivery date.');
            }
            if (!projectName) throw httpError(400, 'Enter a project name.');
        }
        if (!deliveryAddress) throw httpError(400, 'Enter the delivery address.');
        if (!contactPersonName) throw httpError(400, 'Choose a contact person.');
        if (contactNumber.replace(/\D/g, '').length < 6) throw httpError(400, 'Enter a contact number.');
        if (!lines.length) throw httpError(400, 'Add at least one delivery item.');
    }

    return {
        action,
        deliveryType,
        doDate,
        projectName: SCHEDULED.has(deliveryType) ? projectName : '',
        workOrderId: SCHEDULED.has(deliveryType) ? clipLine(body?.workOrderId, 40) : '',
        workOrderNo: SCHEDULED.has(deliveryType) ? clipLine(body?.workOrderNo, 40) : '',
        customerId,
        customerName,
        deliveryAddress,
        contactPersonName,
        contactNumber,
        note,
        lines,
    };
}

async function allocateDeliveryNo() {
    const year = dubaiDateKey().slice(2, 4);
    const prefix = `DO-${year}`;
    const latest = await DeliveryOrder.findOne({ deliveryNo: new RegExp(`^${escapeRegex(prefix)}\\d+$`) })
        .sort({ deliveryNo: -1 })
        .select('deliveryNo')
        .lean();
    const current = latest ? Number(String(latest.deliveryNo).slice(prefix.length)) : 0;
    let sequence = Number.isFinite(current) ? current + 1 : 1;
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const deliveryNo = `${prefix}${String(sequence).padStart(4, '0')}`;
        const exists = await DeliveryOrder.exists({ deliveryNo });
        if (!exists) return deliveryNo;
        sequence += 1;
    }
    throw httpError(500, 'Could not allocate a delivery number.');
}

function lineTotals(lines) {
    const totals = new Map();
    (lines || []).forEach((line) => {
        const id = String(line.inventoryItemId || '');
        totals.set(id, (totals.get(id) || 0) + Number(line.quantity || 0));
    });
    return totals;
}

async function quantityWaitingOnOtherDeliveries(exceptId = '') {
    const filter = {
        status: { $in: ['Submitted', 'Confirming'] },
        stockApplied: { $ne: true },
    };
    if (exceptId && mongoose.isValidObjectId(exceptId)) filter._id = { $ne: exceptId };
    const rows = await DeliveryOrder.find(filter).select('lines.inventoryItemId lines.quantity').lean();
    const totals = new Map();
    rows.forEach((row) => {
        (row.lines || []).forEach((line) => {
            const id = String(line.inventoryItemId || '');
            if (!id) return;
            totals.set(id, (totals.get(id) || 0) + Number(line.quantity || 0));
        });
    });
    return totals;
}

async function assertDeliverable(lines, checkQuantity, exceptId = '') {
    const totals = lineTotals(lines);
    if (!totals.size) return;
    const [items, waiting] = await Promise.all([
        InventoryItem.find({ _id: { $in: [...totals.keys()] } })
            .select('description availableQuantity pendingStock')
            .lean(),
        checkQuantity ? quantityWaitingOnOtherDeliveries(exceptId) : Promise.resolve(new Map()),
    ]);
    const byId = new Map(items.map((item) => [String(item._id), item]));
    for (const [id, quantity] of totals) {
        const item = byId.get(id);
        const onHand = Number(item?.availableQuantity) || 0;
        if (!item || item.pendingStock || onHand <= 0) {
            throw httpError(400, 'Only items that are in stock can be added.');
        }
        if (!checkQuantity) continue;
        const held = waiting.get(id) || 0;
        if (onHand - held < quantity) {
            const name = item.description || 'An item';
            if (held > 0) {
                throw httpError(400, `${name} has ${onHand} in stock and ${held} already waiting on another delivery.`);
            }
            throw httpError(400, `${name} only has ${onHand} in stock.`);
        }
    }
}

async function changeStock(lines, direction) {
    const totals = lineTotals(lines);
    const applied = [];
    try {
        for (const [id, quantity] of totals) {
            if (!mongoose.isValidObjectId(id) || quantity < 1) {
                throw httpError(400, 'Only items that are in stock can be added.');
            }
            const filter = direction < 0
                ? { _id: id, pendingStock: { $ne: true }, availableQuantity: { $gte: quantity } }
                : { _id: id };
            const item = await InventoryItem.findOneAndUpdate(
                filter,
                { $inc: { availableQuantity: direction * quantity } },
                { new: true },
            ).select('description availableQuantity pendingStock');
            if (!item) {
                const existing = await InventoryItem.findById(id).select('description availableQuantity pendingStock').lean();
                if (!existing || existing.pendingStock) throw httpError(400, 'Only items that are in stock can be added.');
                throw httpError(400, `${existing.description || 'An item'} only has ${existing.availableQuantity || 0} in stock.`);
            }
            applied.push({ id, quantity });
        }
    } catch (error) {
        for (const row of applied.reverse()) {
            await InventoryItem.updateOne({ _id: row.id }, { $inc: { availableQuantity: -direction * row.quantity } });
        }
        throw error;
    }
}

export async function viewerIsPurchasingOfficer(req) {
    const officer = await findPurchaseOfficer();
    return actorIsPurchaseOfficer(req, officer);
}

export async function listDeliveries(req, res) {
    try {
        const [rows, purchasingOfficer] = await Promise.all([
            DeliveryOrder.find().sort({ createdAt: -1 }).limit(300).lean(),
            viewerIsPurchasingOfficer(req),
        ]);
        res.json({
            deliveries: rows.map(presentDelivery),
            purchasingOfficer,
        });
    } catch (error) {
        sendError(res, error);
    }
}

export async function createDelivery(req, res) {
    let payload = null;
    let reduced = false;
    try {
        payload = readDelivery(req.body);
        const officer = await findPurchaseOfficer();
        const purchasingOfficer = actorIsPurchaseOfficer(req, officer);
        const submitting = payload.action === 'submit';
        if (payload.lines.length) await assertDeliverable(payload.lines, submitting);
        if (submitting && purchasingOfficer) {
            await changeStock(payload.lines, -1);
            reduced = true;
        } else if (submitting && !officer) {
            throw httpError(400, 'Assign an active Purchase Officer on the flowchart before submitting a delivery.');
        }
        const status = !submitting ? 'Draft' : (purchasingOfficer ? 'Confirmed' : 'Submitted');
        const doDate = /^\d{4}-\d{2}-\d{2}$/.test(payload.doDate) ? payload.doDate : dubaiDateKey();
        const senderName = clipLine(req.user?.name, 160);

        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const deliveryNo = await allocateDeliveryNo();
                const row = await DeliveryOrder.create({
                    deliveryNo,
                    deliveryType: payload.deliveryType,
                    status,
                    doDate,
                    projectName: payload.projectName,
                    workOrderId: payload.workOrderId,
                    workOrderNo: payload.workOrderNo,
                    customerId: payload.customerId,
                    customerName: payload.customerName,
                    deliveryAddress: payload.deliveryAddress,
                    contactPersonName: payload.contactPersonName,
                    contactNumber: payload.contactNumber,
                    note: payload.note,
                    lines: payload.lines,
                    stockApplied: reduced,
                    approverName: purchasingOfficer && submitting ? (officer?.employeeName || senderName) : '',
                    createdBy: String(req.user?.id || ''),
                    createdByName: senderName,
                });
                if (status === 'Submitted') {
                    await notifyDeliveryApproval({ delivery: row, officer, senderName });
                }
                res.status(201).json({ delivery: presentDelivery(row), purchasingOfficer });
                return;
            } catch (error) {
                if (error?.code === 11000 && attempt < 2) continue;
                throw error;
            }
        }
    } catch (error) {
        if (reduced && payload?.lines) {
            try {
                await changeStock(payload.lines, 1);
            } catch (restoreError) {
                console.error('Could not restore delivery stock:', restoreError);
            }
        }
        sendError(res, error);
    }
}

export async function approveDelivery(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Delivery order was not found.');
        const officer = await findPurchaseOfficer();
        if (!actorIsPurchaseOfficer(req, officer)) {
            throw httpError(403, 'Only the purchase officer can approve this delivery.');
        }
        const claimed = await DeliveryOrder.findOneAndUpdate(
            { _id: req.params.id, stockApplied: { $ne: true }, status: 'Submitted' },
            { $set: { status: 'Confirming', approverName: officer?.employeeName || 'Purchase Officer' } },
            { new: true },
        );
        if (!claimed) throw httpError(404, 'This delivery is not waiting for approval.');
        let reduced = false;
        try {
            await assertDeliverable(claimed.lines, true, claimed._id);
            await changeStock(claimed.lines, -1);
            reduced = true;
            claimed.status = 'Confirmed';
            claimed.stockApplied = true;
            await claimed.save();
            await closeDeliveryApproval(claimed._id, 'Approved', req.user?.employeeObjectId);
            res.json({ delivery: presentDelivery(claimed), purchasingOfficer: true });
        } catch (error) {
            if (reduced) {
                try {
                    await changeStock(claimed.lines, 1);
                } catch (restoreError) {
                    console.error('Could not restore delivery stock:', restoreError);
                }
            }
            claimed.status = 'Submitted';
            claimed.stockApplied = false;
            await claimed.save();
            throw error;
        }
    } catch (error) {
        sendError(res, error);
    }
}

export async function rejectDelivery(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Delivery order was not found.');
        const officer = await findPurchaseOfficer();
        if (!actorIsPurchaseOfficer(req, officer)) {
            throw httpError(403, 'Only the purchase officer can reject this delivery.');
        }
        const row = await DeliveryOrder.findOneAndUpdate(
            { _id: req.params.id, status: 'Submitted', stockApplied: { $ne: true } },
            { $set: { status: 'Rejected', approverName: officer?.employeeName || 'Purchase Officer' } },
            { new: true },
        );
        if (!row) throw httpError(404, 'This delivery is not waiting for approval.');
        await closeDeliveryApproval(row._id, 'Rejected', req.user?.employeeObjectId);
        res.json({ delivery: presentDelivery(row), purchasingOfficer: true });
    } catch (error) {
        sendError(res, error);
    }
}

export async function deleteDelivery(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Delivery order was not found.');
        const row = await DeliveryOrder.findById(req.params.id);
        if (!row) throw httpError(404, 'Delivery order was not found.');
        if (row.stockApplied) {
            await changeStock(row.lines, 1);
            row.stockApplied = false;
            await row.save();
        }
        if (row.status === 'Submitted' || row.status === 'Confirming') {
            await closeDeliveryApproval(row._id, 'Rejected', req.user?.employeeObjectId);
        }
        await DeliveryOrder.deleteOne({ _id: row._id });
        res.json({ ok: true });
    } catch (error) {
        sendError(res, error);
    }
}
