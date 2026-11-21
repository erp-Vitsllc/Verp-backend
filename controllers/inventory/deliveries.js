import mongoose from 'mongoose';
import DeliveryOrder from '../../models/inventory/DeliveryOrder.js';
import InventoryItem from '../../models/inventory/InventoryItem.js';
import InventoryStockEntry from '../../models/inventory/InventoryStockEntry.js';
import { escapeRegex } from '../../utils/regexHelper.js';
import { dubaiDateKey } from '../../utils/workOrderNumber.js';
import { httpError, sendError } from './http.js';
import { awaitAdminDeletionArchive } from '../../utils/adminDeletionArchiveRun.js';
import { isReqUserSystemSuperUser } from '../../utils/systemSuperUser.js';
import { ensureAttachmentPersistedToS3 } from '../../utils/s3Upload.js';
import { assertPdfAttachment } from './pdfAttachment.js';
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
        createdByName: row.createdByName || '',
        createdBy: row.createdBy || '',
        note: row.note || '',
        attachment: row.attachment?.name || row.attachment?.url
            ? {
                name: row.attachment.name || '',
                mimeType: row.attachment.mimeType || '',
                publicId: row.attachment.publicId || '',
                url: row.attachment.url || '',
            }
            : null,
        lines: Array.isArray(row.lines) ? row.lines : [],
        stockApplied: Boolean(row.stockApplied),
        editPending: Boolean(row.editPending),
        editSubmittedBy: row.pendingEdit?.submittedByName || '',
        pendingEdit: row.editPending && row.pendingEdit
            ? {
                deliveryType: row.pendingEdit.deliveryType || '',
                doDate: row.pendingEdit.doDate || '',
                projectName: row.pendingEdit.projectName || '',
                workOrderId: row.pendingEdit.workOrderId || '',
                workOrderNo: row.pendingEdit.workOrderNo || '',
                customerId: row.pendingEdit.customerId || '',
                customerName: row.pendingEdit.customerName || '',
                deliveryAddress: row.pendingEdit.deliveryAddress || '',
                contactPersonName: row.pendingEdit.contactPersonName || '',
                contactNumber: row.pendingEdit.contactNumber || '',
                note: row.pendingEdit.note || '',
                attachment: row.pendingEdit.attachment?.name || row.pendingEdit.attachment?.url
                    ? {
                        name: row.pendingEdit.attachment.name || '',
                        mimeType: row.pendingEdit.attachment.mimeType || '',
                        publicId: row.pendingEdit.attachment.publicId || '',
                        url: row.pendingEdit.attachment.url || '',
                    }
                    : null,
                lines: Array.isArray(row.pendingEdit.lines) ? row.pendingEdit.lines : [],
            }
            : null,
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

async function readDeliveryAttachment(body, previous) {
    const incoming = body?.attachment;
    if (!incoming) return { name: '', mimeType: '', publicId: '', url: '' };
    if (incoming.publicId && !incoming.data) {
        return {
            name: clipLine(incoming.name, 240) || previous?.name || '',
            mimeType: incoming.mimeType || previous?.mimeType || '',
            publicId: incoming.publicId,
            url: incoming.url || previous?.url || '',
        };
    }
    assertPdfAttachment(incoming);
    const stored = await ensureAttachmentPersistedToS3(
        {
            name: incoming.name,
            mimeType: 'application/pdf',
            data: incoming.data,
            publicId: incoming.publicId,
        },
        { folder: 'inventory-deliveries', fileName: incoming.name || 'delivery.pdf', resourceType: 'auto' },
    );
    if (!stored?.publicId) return { name: '', mimeType: '', publicId: '', url: '' };
    return {
        name: stored.name || clipLine(incoming.name, 240) || 'delivery.pdf',
        mimeType: 'application/pdf',
        publicId: stored.publicId,
        url: stored.url || '',
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

function priceOnDate(prices, when) {
    let chosen = null;
    for (const row of prices) {
        if (!when || row.time <= when) chosen = row.unitPrice;
        else break;
    }
    return chosen;
}

function roundMoney(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

async function loadPriceBooks(rows) {
    const itemIds = [...new Set(rows.flatMap((delivery) => (
        (delivery.lines || []).map((line) => String(line.inventoryItemId || '')).filter((id) => mongoose.isValidObjectId(id))
    )))];
    const books = new Map(itemIds.map((id) => [id, { prices: [], fallback: 0, stock: null }]));
    if (!itemIds.length) return books;
    const [entries, items] = await Promise.all([
        InventoryStockEntry.find({
            status: 'posted',
            'lines.itemId': { $in: itemIds },
        }).select('purchaseDate postedAt lines.itemId lines.unitPrice').lean(),
        InventoryItem.find({ _id: { $in: itemIds } }).select('lastStockPrice availableQuantity').lean(),
    ]);
    items.forEach((item) => {
        const book = books.get(String(item._id));
        if (book) {
            book.fallback = Number(item.lastStockPrice) || 0;
            book.stock = Number(item.availableQuantity) || 0;
        }
    });
    entries.forEach((entry) => {
        const time = entry.purchaseDate
            ? new Date(entry.purchaseDate).getTime()
            : (entry.postedAt ? new Date(entry.postedAt).getTime() : 0);
        (entry.lines || []).forEach((line) => {
            const book = books.get(String(line.itemId || ''));
            if (!book) return;
            book.prices.push({ time, unitPrice: Number(line.unitPrice) || 0 });
        });
    });
    books.forEach((book) => {
        book.prices.sort((left, right) => left.time - right.time);
        if (!book.fallback && book.prices.length) book.fallback = book.prices[book.prices.length - 1].unitPrice;
    });
    return books;
}

function priceOneDelivery(delivery, books) {
    const deliveryDate = delivery?.doDate || dubaiDateKey(delivery?.createdAt || new Date());
    const when = /^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)
        ? new Date(`${deliveryDate}T23:59:59`).getTime()
        : 0;
    const lines = (delivery?.lines || []).map((line) => {
        const source = line?.toObject?.() || line || {};
        const book = books.get(String(source.inventoryItemId || ''));
        const unitPrice = roundMoney(book ? (priceOnDate(book.prices, when) ?? book.fallback) : 0);
        const quantity = Number(source.quantity) || 0;
        return {
            ...source,
            unitPrice,
            lineAmount: roundMoney(quantity * unitPrice),
            stockOnHand: book && book.stock != null ? book.stock : source.stockOnHand,
        };
    });
    const amount = roundMoney(lines.reduce((sum, line) => sum + line.lineAmount, 0));
    return { lines, amount };
}

export async function priceDeliveries(rows) {
    const books = await loadPriceBooks(rows);
    return rows.map((delivery) => priceOneDelivery(delivery, books));
}

export async function listDeliveries(req, res) {
    try {
        const [rows, purchasingOfficer] = await Promise.all([
            DeliveryOrder.find()
                .sort({ createdAt: -1 })
                .limit(300)
                .select('deliveryNo deliveryType status doDate projectName workOrderId workOrderNo customerId customerName deliveryAddress contactPersonName contactNumber note attachment lines stockApplied editPending pendingEdit createdBy createdByName createdAt')
                .lean(),
            viewerIsPurchasingOfficer(req),
        ]);
        const pendingIndexes = [];
        const batch = [...rows];
        rows.forEach((row, index) => {
            if (!row.editPending || !row.pendingEdit) return;
            pendingIndexes.push(index);
            batch.push({
                doDate: row.pendingEdit.doDate || row.doDate,
                createdAt: row.createdAt,
                lines: row.pendingEdit.lines || [],
            });
        });
        const priced = await priceDeliveries(batch);
        const pendingByRow = new Map(pendingIndexes.map((rowIndex, offset) => [rowIndex, priced[rows.length + offset]]));
        res.json({
            deliveries: rows.map((row, index) => {
                const presented = presentDelivery(row);
                presented.lines = priced[index].lines;
                presented.amount = priced[index].amount;
                if (presented.pendingEdit && pendingByRow.has(index)) {
                    presented.pendingEdit.lines = pendingByRow.get(index).lines;
                }
                return presented;
            }),
            purchasingOfficer,
            viewerId: String(req.user?.id || ''),
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
        const attachment = await readDeliveryAttachment(req.body);
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
                    attachment,
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

async function assertEditStock(existing, lines) {
    const totals = lineTotals(lines);
    if (!totals.size) return;
    const heldHere = existing.stockApplied ? lineTotals(existing.lines) : new Map();
    const [items, waiting] = await Promise.all([
        InventoryItem.find({ _id: { $in: [...totals.keys()] } })
            .select('description availableQuantity pendingStock')
            .lean(),
        quantityWaitingOnOtherDeliveries(existing._id),
    ]);
    const byId = new Map(items.map((item) => [String(item._id), item]));
    for (const [id, quantity] of totals) {
        const item = byId.get(id);
        const onHand = Number(item?.availableQuantity) || 0;
        const mine = heldHere.get(id) || 0;
        if (!item || item.pendingStock || onHand + mine <= 0) {
            throw httpError(400, 'Only items that are in stock can be added.');
        }
        const held = waiting.get(id) || 0;
        if (onHand + mine - held < quantity) {
            const name = item.description || 'An item';
            throw httpError(400, `${name} only has ${onHand + mine - held} available for this edit.`);
        }
    }
}

function pendingFromPayload(payload, senderName) {
    return {
        deliveryType: payload.deliveryType,
        doDate: /^\d{4}-\d{2}-\d{2}$/.test(payload.doDate) ? payload.doDate : '',
        projectName: payload.projectName,
        workOrderId: payload.workOrderId,
        workOrderNo: payload.workOrderNo,
        customerId: payload.customerId,
        customerName: payload.customerName,
        deliveryAddress: payload.deliveryAddress,
        contactPersonName: payload.contactPersonName,
        contactNumber: payload.contactNumber,
        note: payload.note,
        attachment: payload.attachment || { name: '', mimeType: '', publicId: '', url: '' },
        lines: payload.lines,
        submittedByName: senderName,
        submittedAt: new Date(),
    };
}

function writePendingOnto(existing, pending, approverName) {
    existing.deliveryType = pending.deliveryType;
    existing.doDate = pending.doDate || existing.doDate || dubaiDateKey();
    existing.projectName = pending.projectName || '';
    existing.workOrderId = pending.workOrderId || '';
    existing.workOrderNo = pending.workOrderNo || '';
    existing.customerId = pending.customerId || '';
    existing.customerName = pending.customerName || '';
    existing.deliveryAddress = pending.deliveryAddress || '';
    existing.contactPersonName = pending.contactPersonName || '';
    existing.contactNumber = pending.contactNumber || '';
    existing.note = pending.note || '';
    if (pending.attachment) existing.attachment = pending.attachment;
    existing.lines = pending.lines || [];
    existing.status = 'Confirmed';
    existing.stockApplied = true;
    existing.editPending = false;
    existing.pendingEdit = undefined;
    existing.approverName = approverName;
}

async function approvePendingEdit(req, officer) {
    const previous = await DeliveryOrder.findOneAndUpdate(
        { _id: req.params.id, editPending: true },
        { $set: { editPending: false } },
        { new: false },
    );
    if (!previous?.pendingEdit) return null;
    const pending = previous.pendingEdit.toObject?.() || previous.pendingEdit;
    const hadStock = Boolean(previous.stockApplied);
    const originalLines = (previous.lines || []).map((line) => ({ ...line.toObject?.() || line }));
    let restored = false;
    let reduced = false;
    try {
        if (hadStock) {
            await changeStock(originalLines, 1);
            restored = true;
        }
        await assertDeliverable(pending.lines, true, previous._id);
        await changeStock(pending.lines, -1);
        reduced = true;
        const next = await DeliveryOrder.findById(previous._id);
        if (!next) throw httpError(404, 'Delivery order was not found.');
        writePendingOnto(next, pending, officer?.employeeName || 'Purchase Officer');
        await next.save();
        await closeDeliveryApproval(next._id, 'Approved', req.user?.employeeObjectId);
        return next;
    } catch (error) {
        if (reduced) {
            try {
                await changeStock(pending.lines, 1);
            } catch (restoreError) {
                console.error('Could not restore delivery stock:', restoreError);
            }
        }
        if (restored) {
            try {
                await changeStock(originalLines, -1);
            } catch (restoreError) {
                console.error('Could not restore delivery stock:', restoreError);
            }
        }
        await DeliveryOrder.updateOne(
            { _id: previous._id },
            { $set: { editPending: true, pendingEdit: pending, stockApplied: hadStock } },
        );
        throw error;
    }
}

export async function approveDelivery(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Delivery order was not found.');
        const officer = await findPurchaseOfficer();
        if (!actorIsPurchaseOfficer(req, officer)) {
            throw httpError(403, 'Only the purchase officer can approve this delivery.');
        }
        const edited = await approvePendingEdit(req, officer);
        if (edited) {
            res.json({ delivery: presentDelivery(edited), purchasingOfficer: true });
            return;
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
        const edited = await DeliveryOrder.findOneAndUpdate(
            { _id: req.params.id, editPending: true },
            { $set: { editPending: false }, $unset: { pendingEdit: 1 } },
            { new: true },
        );
        if (edited) {
            await closeDeliveryApproval(edited._id, 'Rejected', req.user?.employeeObjectId);
            res.json({ delivery: presentDelivery(edited), purchasingOfficer: true });
            return;
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

async function applyDeliveryUpdate(req, existing, payload) {
    const officer = await findPurchaseOfficer();
    const purchasingOfficer = actorIsPurchaseOfficer(req, officer);
    const submitting = payload.action === 'submit';
    if (payload.lines.length) await assertDeliverable(payload.lines, submitting);
    if (submitting && !officer && !purchasingOfficer) {
        throw httpError(400, 'Assign an active Purchase Officer on the flowchart before submitting a delivery.');
    }
    let reduced = false;
    try {
        if (submitting && purchasingOfficer) {
            await changeStock(payload.lines, -1);
            reduced = true;
        }
        const status = !submitting ? 'Draft' : (purchasingOfficer ? 'Confirmed' : 'Submitted');
    const doDate = /^\d{4}-\d{2}-\d{2}$/.test(payload.doDate) ? payload.doDate : (existing.doDate || dubaiDateKey());
    existing.deliveryType = payload.deliveryType;
    existing.status = status;
    existing.doDate = doDate;
    existing.projectName = payload.projectName;
    existing.workOrderId = payload.workOrderId;
    existing.workOrderNo = payload.workOrderNo;
    existing.customerId = payload.customerId;
    existing.customerName = payload.customerName;
    existing.deliveryAddress = payload.deliveryAddress;
    existing.contactPersonName = payload.contactPersonName;
    existing.contactNumber = payload.contactNumber;
    existing.note = payload.note;
    if (payload.attachment) existing.attachment = payload.attachment;
    existing.lines = payload.lines;
    existing.stockApplied = reduced;
    existing.editPending = false;
    existing.pendingEdit = undefined;
    if (purchasingOfficer && submitting) {
        existing.approverName = officer?.employeeName || clipLine(req.user?.name, 160);
    }
    await existing.save();
        if (status === 'Submitted') {
            await notifyDeliveryApproval({
                delivery: existing,
                officer,
                senderName: clipLine(req.user?.name, 160),
            });
        }
        return existing;
    } catch (error) {
        if (reduced) await changeStock(payload.lines, 1);
        throw error;
    }
}

export async function updateDelivery(req, res) {
    let restored = false;
    const originalLines = [];
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Delivery order was not found.');
        const existing = await DeliveryOrder.findById(req.params.id);
        if (!existing || existing.status === 'Confirming') throw httpError(404, 'Delivery order was not found.');
        const payload = readDelivery(req.body);
        payload.attachment = await readDeliveryAttachment(req.body, existing.attachment);
        const officer = await findPurchaseOfficer();
        const purchasingOfficer = actorIsPurchaseOfficer(req, officer);
        const submitting = payload.action === 'submit';
        const senderName = clipLine(req.user?.name, 160);
        if (!submitting && existing.status !== 'Draft') {
            throw httpError(400, 'Submit this edit so the purchase officer can approve it.');
        }
        const queuesEdit = submitting && !purchasingOfficer && existing.status !== 'Draft';
        if (queuesEdit) {
            if (!officer) throw httpError(400, 'Assign an active Purchase Officer on the flowchart before submitting a delivery.');
            if (payload.lines.length) await assertEditStock(existing, payload.lines);
            existing.editPending = true;
            existing.pendingEdit = pendingFromPayload(payload, senderName);
            existing.markModified('pendingEdit');
            await existing.save();
            await notifyDeliveryApproval({ delivery: existing, officer, senderName, kind: 'edit' });
            res.json({ delivery: presentDelivery(existing), purchasingOfficer: false, pendingApproval: true });
            return;
        }
        originalLines.push(...(existing.lines || []).map((line) => ({ ...line.toObject?.() || line })));
        if (existing.stockApplied) {
            await changeStock(originalLines, 1);
            restored = true;
            existing.stockApplied = false;
        }
        try {
            const saved = await applyDeliveryUpdate(req, existing, payload);
            res.json({ delivery: presentDelivery(saved), purchasingOfficer, pendingApproval: false });
        } catch (error) {
            if (restored) {
                await changeStock(originalLines, -1);
                existing.stockApplied = true;
                existing.lines = originalLines;
            }
            throw error;
        }
    } catch (error) {
        sendError(res, error);
    }
}

export async function deleteDelivery(req, res) {
    let restored = false;
    try {
        if (!(await isReqUserSystemSuperUser(req.user))) {
            throw httpError(403, 'Only the system super user can delete a delivery.');
        }
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Delivery order was not found.');
        const row = await DeliveryOrder.findById(req.params.id);
        if (!row) throw httpError(404, 'Delivery order was not found.');
        const lines = (row.lines || []).map((line) => ({ ...line.toObject?.() || line }));
        if (row.stockApplied) {
            await changeStock(lines, 1);
            restored = true;
        }
        try {
            if (row.status !== 'Draft') {
                const label = row.deliveryNo || String(row._id);
                const details = row.stockApplied
                    ? `Delivery ${label} deleted. Delivered quantity was added back to item stock.`
                    : `Delivery ${label} deleted.`;
                await awaitAdminDeletionArchive(req, {
                    moduleName: 'Inventory Delivery',
                    recordId: label,
                    details,
                    deletedPayload: row.toObject(),
                    archive: {
                        topModule: 'other',
                        category: 'list',
                        entityType: 'inventory_delivery',
                        title: 'Inventory Delivery',
                        subtitle: label,
                        details,
                    },
                });
            }
            if (row.status === 'Submitted' || row.status === 'Confirming' || row.editPending) {
                await closeDeliveryApproval(row._id, 'Rejected', req.user?.employeeObjectId);
            }
            await DeliveryOrder.deleteOne({ _id: row._id });
        } catch (error) {
            if (restored) await changeStock(lines, -1);
            throw error;
        }
        res.json({ ok: true });
    } catch (error) {
        sendError(res, error);
    }
}

export async function listItemDeliveryHistory(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Item was not found.');
        const itemId = String(req.params.id);
        const [rows, purchases, item] = await Promise.all([
            DeliveryOrder.find({
                status: 'Confirmed',
                'lines.inventoryItemId': itemId,
            }).sort({ createdAt: -1 }).lean(),
            InventoryStockEntry.find({
                status: 'posted',
                'lines.itemId': itemId,
            }).select('purchaseDate postedAt lines').lean(),
            InventoryItem.findById(itemId).select('lastStockPrice').lean(),
        ]);
        const prices = [];
        purchases.forEach((entry) => {
            const time = entry.purchaseDate
                ? new Date(entry.purchaseDate).getTime()
                : (entry.postedAt ? new Date(entry.postedAt).getTime() : 0);
            (entry.lines || []).forEach((line) => {
                if (String(line.itemId || '') !== itemId) return;
                prices.push({ time, unitPrice: Number(line.unitPrice) || 0 });
            });
        });
        prices.sort((left, right) => left.time - right.time);
        const fallback = Number(item?.lastStockPrice) || (prices.length ? prices[prices.length - 1].unitPrice : 0);
        const priced = await priceDeliveries(rows);
        const deliveries = [];
        rows.forEach((row, rowIndex) => {
            const deliveryDate = row.doDate || dubaiDateKey(row.createdAt || new Date());
            const when = /^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)
                ? new Date(`${deliveryDate}T23:59:59`).getTime()
                : 0;
            const unitPrice = priceOnDate(prices, when) ?? fallback;
            const presented = presentDelivery(row);
            presented.lines = priced[rowIndex].lines;
            presented.amount = priced[rowIndex].amount;
            (row.lines || []).forEach((line, index) => {
                if (String(line.inventoryItemId || '') !== itemId) return;
                deliveries.push({
                    id: `${row._id}-${index}`,
                    deliveryId: String(row._id),
                    deliveryDate,
                    customerId: row.customerId || '',
                    customerName: row.customerName || '',
                    deliveryNo: row.deliveryNo || '',
                    quantity: line.quantity || 0,
                    unitPrice,
                    sortTime: row.createdAt ? new Date(row.createdAt).getTime() : 0,
                    delivery: presented,
                });
            });
        });
        deliveries.sort((left, right) => {
            if (right.deliveryDate !== left.deliveryDate) return right.deliveryDate.localeCompare(left.deliveryDate);
            return right.sortTime - left.sortTime;
        });
        res.json({
            deliveries: deliveries.map(({ sortTime, ...row }) => row),
        });
    } catch (error) {
        sendError(res, error);
    }
}
