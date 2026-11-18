import mongoose from 'mongoose';
import InventoryStockEntry from '../../models/inventory/InventoryStockEntry.js';
import InventoryVendor from '../../models/inventory/InventoryVendor.js';
import { ensureAttachmentPersistedToS3 } from '../../utils/s3Upload.js';
import { cleanName, httpError, sendError } from './http.js';
import InventoryItem from '../../models/inventory/InventoryItem.js';
import { applyItemStock, createPendingItemRecord } from './itemStock.js';
import {
    actorIsPurchaseOfficer,
    closeStockApproval,
    findPurchaseOfficer,
    notifyStockApproval,
} from './stockApproval.js';

function roundMoney(value) {
    return Math.round(Number(value) * 100) / 100;
}

function presentLine(line) {
    return {
        itemId: line.itemId ? String(line.itemId) : '',
        categoryId: line.categoryId ? String(line.categoryId) : '',
        subcategoryId: line.subcategoryId ? String(line.subcategoryId) : '',
        brandId: line.brandId ? String(line.brandId) : '',
        modelNumber: line.modelNumber || '',
        itemName: line.itemName || '',
        description: line.description || '',
        quantity: line.quantity || 0,
        unitPrice: line.unitPrice || 0,
        total: line.total || 0,
    };
}

function presentEntry(row) {
    const attachment = row.attachment?.publicId || row.attachment?.name
        ? {
            name: row.attachment.name || '',
            mimeType: row.attachment.mimeType || '',
            publicId: row.attachment.publicId || '',
            url: row.attachment.url || '',
        }
        : null;
    return {
        _id: row._id,
        clientRequestId: row.clientRequestId || '',
        purchaseSource: row.purchaseSource,
        vendorId: row.vendorId ? String(row.vendorId) : '',
        purchaseDate: row.purchaseDate ? row.purchaseDate.toISOString().slice(0, 10) : '',
        billNo: row.billNo || '',
        lpoNo: row.lpoNo || '',
        lines: (row.lines || []).map(presentLine),
        attachment,
        status: row.status === 'posting' ? 'draft' : row.status,
        postedAt: row.postedAt || null,
        updatedAt: row.updatedAt,
        submittedByName: row.submittedByName || '',
        approverName: row.approverName || '',
    };
}

function readLines(body, { posting }) {
    const rows = Array.isArray(body?.lines) ? body.lines : [];
    if (posting && rows.length === 0) throw httpError(400, 'Add at least one item.');
    return rows.map((line, index) => {
        const quantity = Number(line?.quantity);
        const unitPrice = line?.unitPrice === '' || line?.unitPrice == null ? NaN : Number(line.unitPrice);
        if (posting) {
            if (!Number.isFinite(quantity) || quantity <= 0) {
                throw httpError(400, `Enter a quantity greater than zero on row ${index + 1}.`);
            }
            if (!Number.isFinite(unitPrice) || unitPrice < 0) {
                throw httpError(400, `Enter a price on row ${index + 1}.`);
            }
        }
        const safeQuantity = Number.isFinite(quantity) && quantity > 0 ? roundMoney(quantity) : 0;
        const safePrice = Number.isFinite(unitPrice) && unitPrice >= 0 ? roundMoney(unitPrice) : 0;
        if (!line?.categoryId || !line?.subcategoryId || !line?.brandId || !cleanName(line?.itemName)) {
            throw httpError(400, `Row ${index + 1} is missing category, sub category, brand, or item.`);
        }
        return {
            itemId: line.itemId && mongoose.isValidObjectId(line.itemId) ? line.itemId : null,
            categoryId: line.categoryId,
            subcategoryId: line.subcategoryId,
            brandId: line.brandId,
            modelNumber: cleanName(line.modelNumber),
            itemName: cleanName(line.itemName),
            description: cleanName(line.description),
            quantity: safeQuantity,
            unitPrice: safePrice,
            total: roundMoney(safeQuantity * safePrice),
        };
    });
}

async function readPurchase(body, { posting }) {
    const purchaseSource = body?.purchaseSource === 'manual' ? 'manual' : 'vendor';
    if (purchaseSource === 'manual') {
        return {
            purchaseSource,
            vendorId: null,
            purchaseDate: null,
            billNo: '',
            lpoNo: '',
        };
    }
    const vendorId = String(body?.vendorId || '');
    const purchaseDate = String(body?.purchaseDate || '');
    const billNo = cleanName(body?.billNo);
    const lpoNo = cleanName(body?.lpoNo);
    const vendorIsValid = mongoose.isValidObjectId(vendorId);
    const dateIsValid = /^\d{4}-\d{2}-\d{2}$/.test(purchaseDate);
    if (posting) {
        if (!vendorIsValid) throw httpError(400, 'Vendor name is required.');
        const vendor = await InventoryVendor.findById(vendorId).select('_id');
        if (!vendor) throw httpError(400, 'Vendor was not found.');
        if (!dateIsValid) throw httpError(400, 'Purchase date is required.');
        if (!billNo) throw httpError(400, 'Bill no is required.');
    } else if (vendorIsValid) {
        const vendor = await InventoryVendor.findById(vendorId).select('_id');
        if (!vendor) throw httpError(400, 'Vendor was not found.');
    }
    return {
        purchaseSource,
        vendorId: vendorIsValid ? vendorId : null,
        purchaseDate: dateIsValid ? new Date(`${purchaseDate}T00:00:00.000Z`) : null,
        billNo,
        lpoNo,
    };
}

async function readAttachment(body, previous) {
    const incoming = body?.attachment;
    if (!incoming) return { name: '', mimeType: '', publicId: '', url: '' };
    if (incoming.publicId && !incoming.data) {
        return {
            name: cleanName(incoming.name) || previous?.name || '',
            mimeType: incoming.mimeType || previous?.mimeType || '',
            publicId: incoming.publicId,
            url: incoming.url || previous?.url || '',
        };
    }
    const stored = await ensureAttachmentPersistedToS3(
        {
            name: incoming.name,
            mimeType: incoming.mimeType,
            data: incoming.data,
            publicId: incoming.publicId,
        },
        { folder: 'inventory-stock-entries', fileName: incoming.name || 'bill.pdf', resourceType: 'auto' },
    );
    if (!stored?.publicId) return { name: '', mimeType: '', publicId: '', url: '' };
    return {
        name: stored.name || '',
        mimeType: stored.mimeType || '',
        publicId: stored.publicId,
        url: stored.url || '',
    };
}

async function postLines(req, entry, lines) {
    const posted = lines.slice(0, entry.postedCount || 0).map((line) => ({ ...line }));
    for (let index = posted.length; index < lines.length; index += 1) {
        const line = lines[index];
        let itemId = line.itemId ? String(line.itemId) : '';
        if (!itemId) {
            const created = await createPendingItemRecord({
                categoryId: line.categoryId,
                subcategoryId: line.subcategoryId,
                brandId: line.brandId,
                itemName: line.itemName,
                modelNumber: line.modelNumber,
            });
            itemId = String(created.item._id);
        }
        const result = await applyItemStock(req, itemId, {
            quantity: line.quantity,
            price: line.unitPrice,
            categoryId: line.categoryId,
            subcategoryId: line.subcategoryId,
            brandId: line.brandId,
            modelNumber: line.modelNumber || line.itemName,
        });
        posted.push({
            ...line,
            itemId: result.body?._id || itemId,
            description: result.body?.description || line.description,
            modelNumber: result.body?.modelNumber || line.modelNumber,
        });
        entry.lines = posted.concat(lines.slice(index + 1));
        entry.postedCount = posted.length;
        entry.markModified('lines');
        await entry.save();
    }
    return posted;
}

function plainLines(lines) {
    return (lines || []).map((line) => ({
        itemId: line.itemId || null,
        categoryId: line.categoryId,
        subcategoryId: line.subcategoryId,
        brandId: line.brandId,
        modelNumber: line.modelNumber || '',
        itemName: line.itemName || '',
        description: line.description || '',
        quantity: line.quantity || 0,
        unitPrice: line.unitPrice || 0,
        total: line.total || 0,
    }));
}

async function ensureLineItems(lines) {
    const next = [];
    for (const line of lines) {
        if (line.itemId) {
            next.push(line);
            continue;
        }
        const created = await createPendingItemRecord({
            categoryId: line.categoryId,
            subcategoryId: line.subcategoryId,
            brandId: line.brandId,
            itemName: line.itemName,
            modelNumber: line.modelNumber,
        });
        next.push({
            ...line,
            itemId: created.item?._id || null,
            description: created.item?.description || line.description,
            modelNumber: created.item?.modelNumber || line.modelNumber,
        });
    }
    return next;
}

function summarizePending(row) {
    return {
        _id: row._id,
        billNo: row.billNo || '',
        purchaseSource: row.purchaseSource,
        submittedByName: row.submittedByName || '',
        approverName: row.approverName || '',
        lineCount: row.lines?.length || 0,
        updatedAt: row.updatedAt,
    };
}

export async function listInventoryBills(req, res) {
    try {
        const filter = { status: 'posted' };
        const vendorId = String(req.query.vendorId || '');
        if (vendorId && mongoose.isValidObjectId(vendorId)) {
            filter.vendorId = vendorId;
            filter.purchaseSource = 'vendor';
        }
        const rows = await InventoryStockEntry.find(filter)
            .select('purchaseSource vendorId purchaseDate billNo lpoNo lines attachment updatedAt')
            .lean();
        const vendorIds = [...new Set(rows.map((row) => (row.vendorId ? String(row.vendorId) : '')).filter(Boolean))];
        const vendors = vendorIds.length
            ? await InventoryVendor.find({ _id: { $in: vendorIds } }).select('name').lean()
            : [];
        const vendorNames = new Map(vendors.map((vendor) => [String(vendor._id), vendor.name || '']));
        rows.sort((left, right) => {
            const leftTime = left.purchaseDate ? new Date(left.purchaseDate).getTime() : 0;
            const rightTime = right.purchaseDate ? new Date(right.purchaseDate).getTime() : 0;
            if (rightTime !== leftTime) return rightTime - leftTime;
            return new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime();
        });
        res.json({
            bills: rows.map((row) => {
                const value = (row.lines || []).reduce((sum, line) => {
                    const stored = Number(line.total);
                    if (Number.isFinite(stored) && stored > 0) return sum + stored;
                    const quantity = Number(line.quantity);
                    const price = Number(line.unitPrice);
                    if (Number.isFinite(quantity) && Number.isFinite(price)) return sum + (quantity * price);
                    return sum + (Number.isFinite(stored) ? stored : 0);
                }, 0);
                const manual = row.purchaseSource === 'manual';
                const hasFile = Boolean(row.attachment?.name || row.attachment?.url);
                return {
                    id: String(row._id),
                    vendorId: row.vendorId ? String(row.vendorId) : '',
                    purchaseSource: manual ? 'manual' : 'vendor',
                    billNo: row.billNo || '',
                    lpoNo: row.lpoNo || '',
                    vendorName: manual ? '' : (vendorNames.get(String(row.vendorId || '')) || ''),
                    purchaseDate: row.purchaseDate ? new Date(row.purchaseDate).toISOString().slice(0, 10) : '',
                    purchaseType: 'Direct',
                    value: Math.round(value * 100) / 100,
                    attachment: hasFile
                        ? { name: row.attachment.name || 'Attachment', url: row.attachment.url || '' }
                        : null,
                };
            }),
        });
    } catch (error) {
        sendError(res, error);
    }
}

export async function listStockEntries(req, res) {
    try {
        const status = req.query.status === 'posted' ? 'posted' : 'draft';
        const rows = await InventoryStockEntry.find({ status })
            .sort({ updatedAt: -1 })
            .limit(30)
            .select('clientRequestId purchaseSource vendorId billNo status updatedAt lines')
            .lean();
        res.json({
            entries: rows.map((row) => ({
                _id: row._id,
                clientRequestId: row.clientRequestId || '',
                purchaseSource: row.purchaseSource,
                vendorId: row.vendorId ? String(row.vendorId) : '',
                billNo: row.billNo || '',
                status: row.status,
                lineCount: row.lines?.length || 0,
                updatedAt: row.updatedAt,
            })),
        });
    } catch (error) {
        sendError(res, error);
    }
}

export async function getStockEntry(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Stock entry was not found.');
        const row = await InventoryStockEntry.findById(req.params.id).lean();
        if (!row || row.status === 'posting') throw httpError(404, 'Stock entry was not found.');
        res.json(presentEntry(row));
    } catch (error) {
        sendError(res, error);
    }
}

export async function saveStockEntry(req, res) {
    try {
        const posting = req.body?.status === 'posted';
        const purchase = await readPurchase(req.body, { posting });
        const lines = readLines(req.body, { posting });
        const clientRequestId = cleanName(req.body?.clientRequestId);
        const requestedId = String(req.body?.id || '');
        let entry = null;
        if (requestedId && mongoose.isValidObjectId(requestedId)) {
            entry = await InventoryStockEntry.findById(requestedId);
        } else if (clientRequestId) {
            entry = await InventoryStockEntry.findOne({ clientRequestId });
        }
        if (entry?.status === 'posted') {
            res.json(presentEntry(entry));
            return;
        }
        if (entry?.status === 'posting') {
            throw httpError(409, 'This stock entry is already being saved.');
        }
        const attachment = await readAttachment(req.body, entry?.attachment);
        const payload = {
            ...purchase,
            lines,
            attachment,
            clientRequestId: clientRequestId || entry?.clientRequestId || undefined,
            createdBy: entry?.createdBy || req.user?.id || null,
        };
        if (!payload.clientRequestId) delete payload.clientRequestId;
        if (!posting) {
            if (entry?.status === 'pending') {
                res.json(presentEntry(entry));
                return;
            }
            const creating = !entry;
            if (entry) {
                Object.assign(entry, payload, { status: 'draft', postedAt: null });
                await entry.save();
            } else {
                entry = await InventoryStockEntry.create({ ...payload, status: 'draft' });
            }
            res.status(creating ? 201 : 200).json(presentEntry(entry));
            return;
        }
        const officer = await findPurchaseOfficer();
        if (!actorIsPurchaseOfficer(req, officer)) {
            if (!officer) {
                throw httpError(400, 'Assign an active Purchase Officer on the flowchart before submitting stock.');
            }
            const wasPending = entry?.status === 'pending';
            const pendingLines = await ensureLineItems(lines);
            const approval = {
                submittedByName: cleanName(req.user?.name) || entry?.submittedByName || '',
                approverName: officer.employeeName || 'Purchase Officer',
                approverEmployeeId: officer.empObjectId || null,
            };
            const pendingPayload = {
                ...payload,
                lines: pendingLines,
                ...approval,
                status: 'pending',
                postedAt: null,
                postedCount: 0,
            };
            if (entry) {
                Object.assign(entry, pendingPayload);
                entry.markModified('lines');
                await entry.save();
            } else {
                try {
                    entry = await InventoryStockEntry.create(pendingPayload);
                } catch (error) {
                    if (error?.code !== 11000 || !clientRequestId) throw error;
                    const existing = await InventoryStockEntry.findOne({ clientRequestId });
                    if (existing && (existing.status === 'posted' || existing.status === 'pending')) {
                        res.json(presentEntry(existing));
                        return;
                    }
                    throw httpError(409, 'This stock entry is already being saved.');
                }
            }
            if (!wasPending) {
                await notifyStockApproval({
                    entry,
                    officer,
                    senderName: approval.submittedByName,
                });
            }
            res.status(wasPending ? 200 : 201).json(presentEntry(entry));
            return;
        }
        if (entry) {
            const alreadyPosted = entry.postedCount || 0;
            const claimed = await InventoryStockEntry.findOneAndUpdate(
                { _id: entry._id, status: 'draft' },
                {
                    $set: {
                        ...payload,
                        status: 'posting',
                        lines,
                        postedCount: alreadyPosted > 0 ? Math.min(alreadyPosted, lines.length) : 0,
                    },
                },
                { new: true },
            );
            if (!claimed) {
                const current = await InventoryStockEntry.findById(entry._id);
                if (current?.status === 'posted') {
                    res.json(presentEntry(current));
                    return;
                }
                throw httpError(409, 'This stock entry is already being saved.');
            }
            entry = claimed;
        } else {
            try {
                entry = await InventoryStockEntry.create({ ...payload, status: 'posting', postedCount: 0 });
            } catch (error) {
                if (error?.code !== 11000 || !clientRequestId) throw error;
                const existing = await InventoryStockEntry.findOne({ clientRequestId });
                if (existing?.status === 'posted') {
                    res.json(presentEntry(existing));
                    return;
                }
                throw httpError(409, 'This stock entry is already being saved.');
            }
        }
        try {
            const postedLines = await postLines(req, entry, lines);
            entry.lines = postedLines;
            entry.status = 'posted';
            entry.postedAt = new Date();
            await entry.save();
            res.status(201).json(presentEntry(entry));
        } catch (error) {
            entry.status = 'draft';
            await entry.save();
            throw error;
        }
    } catch (error) {
        sendError(res, error);
    }
}

export async function stockApprovalContext(req, res) {
    try {
        const officer = await findPurchaseOfficer();
        const isPurchaseOfficer = actorIsPurchaseOfficer(req, officer);
        const rows = isPurchaseOfficer
            ? await InventoryStockEntry.find({ status: 'pending' }).sort({ updatedAt: -1 }).lean()
            : [];
        res.json({
            isPurchaseOfficer,
            officerName: officer?.employeeName || '',
            entries: rows.map(summarizePending),
        });
    } catch (error) {
        sendError(res, error);
    }
}

export async function approveStockEntry(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Stock entry was not found.');
        const officer = await findPurchaseOfficer();
        if (!actorIsPurchaseOfficer(req, officer)) {
            throw httpError(403, 'Only the purchase officer can approve this stock.');
        }
        const claimed = await InventoryStockEntry.findOneAndUpdate(
            { _id: req.params.id, status: 'pending' },
            { $set: { status: 'posting' } },
            { new: true },
        );
        if (!claimed) throw httpError(404, 'This stock entry is not waiting for approval.');
        try {
            const postedLines = await postLines(req, claimed, plainLines(claimed.lines));
            claimed.lines = postedLines;
            claimed.status = 'posted';
            claimed.postedAt = new Date();
            claimed.markModified('lines');
            await claimed.save();
            await closeStockApproval(claimed._id, 'Approved', req.user?.employeeObjectId);
            res.json(presentEntry(claimed));
        } catch (error) {
            claimed.status = 'pending';
            await claimed.save();
            throw error;
        }
    } catch (error) {
        sendError(res, error);
    }
}

export async function rejectStockEntry(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Stock entry was not found.');
        const officer = await findPurchaseOfficer();
        if (!actorIsPurchaseOfficer(req, officer)) {
            throw httpError(403, 'Only the purchase officer can reject this stock.');
        }
        const entry = await InventoryStockEntry.findOneAndUpdate(
            { _id: req.params.id, status: 'pending' },
            { $set: { status: 'posting' } },
            { new: true },
        );
        if (!entry) throw httpError(404, 'This stock entry is not waiting for approval.');
        try {
            const itemIds = plainLines(entry.lines)
                .map((line) => line.itemId)
                .filter((id) => id && mongoose.isValidObjectId(id));
            const stillWaiting = new Set();
            if (itemIds.length) {
                const others = await InventoryStockEntry.find({
                    _id: { $ne: entry._id },
                    status: 'pending',
                    'lines.itemId': { $in: itemIds },
                }).select('lines.itemId').lean();
                others.forEach((row) => {
                    (row.lines || []).forEach((line) => {
                        if (line.itemId) stillWaiting.add(String(line.itemId));
                    });
                });
                const items = await InventoryItem.find({ _id: { $in: itemIds } })
                    .select('pendingStock availableQuantity')
                    .lean();
                const removable = items
                    .filter((item) => item.pendingStock && Number(item.availableQuantity) === 0 && !stillWaiting.has(String(item._id)))
                    .map((item) => item._id);
                if (removable.length) await InventoryItem.deleteMany({ _id: { $in: removable } });
            }
            await closeStockApproval(entry._id, 'Rejected', req.user?.employeeObjectId);
            await InventoryStockEntry.deleteOne({ _id: entry._id });
            res.json({ ok: true });
        } catch (error) {
            entry.status = 'pending';
            await entry.save();
            throw error;
        }
    } catch (error) {
        sendError(res, error);
    }
}
