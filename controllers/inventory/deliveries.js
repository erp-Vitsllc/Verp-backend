import mongoose from 'mongoose';
import DeliveryOrder from '../../models/inventory/DeliveryOrder.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import { escapeRegex } from '../../utils/regexHelper.js';
import { dubaiDateKey } from '../../utils/workOrderNumber.js';
import { httpError, sendError } from './http.js';

const TYPES = new Set(['Project', 'Annual', 'Manual']);
const SCHEDULED = new Set(['Project', 'Annual']);

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
        inventoryItemId: clipLine(raw.inventoryItemId, 40),
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

export async function viewerIsPurchasingOfficer(req) {
    const ids = [req.user?.employeeObjectId, req.user?.id]
        .map((value) => String(value || ''))
        .filter((value) => mongoose.isValidObjectId(value));
    const employeeId = clipLine(req.user?.employeeId, 40);
    const filters = [];
    if (ids.length) filters.push({ _id: { $in: ids } });
    if (employeeId) filters.push({ employeeId });
    let designation = '';
    if (filters.length) {
        const employee = await EmployeeBasic.findOne({ $or: filters }).select('designation').lean();
        designation = employee?.designation || '';
    }
    const role = `${designation} ${req.user?.groupName || ''} ${req.user?.role || ''}`;
    return /purchasing officer/i.test(role);
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
    try {
        const payload = readDelivery(req.body);
        const purchasingOfficer = await viewerIsPurchasingOfficer(req);
        const status = payload.action === 'draft'
            ? 'Draft'
            : (purchasingOfficer ? 'Confirmed' : 'Submitted');
        const doDate = /^\d{4}-\d{2}-\d{2}$/.test(payload.doDate) ? payload.doDate : dubaiDateKey();

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
                    lines: payload.lines,
                    createdBy: String(req.user?.id || ''),
                    createdByName: clipLine(req.user?.name, 160),
                });
                res.status(201).json({ delivery: presentDelivery(row), purchasingOfficer });
                return;
            } catch (error) {
                if (error?.code === 11000 && attempt < 2) continue;
                throw error;
            }
        }
    } catch (error) {
        sendError(res, error);
    }
}

export async function deleteDelivery(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Delivery order was not found.');
        const row = await DeliveryOrder.findByIdAndDelete(req.params.id).lean();
        if (!row) throw httpError(404, 'Delivery order was not found.');
        res.json({ ok: true });
    } catch (error) {
        sendError(res, error);
    }
}
