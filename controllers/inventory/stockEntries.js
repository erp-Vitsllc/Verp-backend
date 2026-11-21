import mongoose from 'mongoose';
import InventoryStockEntry from '../../models/inventory/InventoryStockEntry.js';
import InventoryVendor from '../../models/inventory/InventoryVendor.js';
import { ensureAttachmentPersistedToS3 } from '../../utils/s3Upload.js';
import { cleanName, httpError, sendError } from './http.js';
import InventoryItem from '../../models/inventory/InventoryItem.js';
import { applyItemStock, createPendingItemRecord } from './itemStock.js';
import { awaitAdminDeletionArchive } from '../../utils/adminDeletionArchiveRun.js';
import {
    actorIsManagement,
    actorIsPurchaseOfficer,
    closeDraftBill,
    closeStockApproval,
    findPurchaseOfficer,
    notifyDraftBill,
    notifyStockApproval,
    syncViewerDraftBills,
} from './stockApproval.js';

function roundMoney(value) {
    return Math.round(Number(value) * 100) / 100;
}

function billListStatus(status) {
    return status === 'draft' ? 'Draft' : 'Approved';
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function quantitiesFromLines(lines) {
    const totals = new Map();
    const unresolved = [];
    for (const line of lines || []) {
        const quantity = Number(line.quantity) || 0;
        if (quantity <= 0) continue;
        const id = line.itemId && mongoose.isValidObjectId(String(line.itemId)) ? String(line.itemId) : '';
        if (id) {
            totals.set(id, roundMoney((totals.get(id) || 0) + quantity));
        } else {
            unresolved.push({ line, quantity });
        }
    }
    return { totals, unresolved };
}

async function deleteReasonsByBill(rows) {
    const reasons = new Map();
    const posted = (rows || []).filter((row) => row.status === 'posted');
    if (!posted.length) return reasons;
    const prepared = posted.map((row) => ({
        id: String(row._id),
        blocked: false,
        ...quantitiesFromLines(row.lines),
    }));
    const unresolved = prepared.flatMap((row) => row.unresolved);
    const itemIds = new Set();
    prepared.forEach((row) => row.totals.forEach((_quantity, id) => itemIds.add(id)));
    const models = [...new Set(unresolved.map(({ line }) => String(line.modelNumber || '').trim()).filter(Boolean))];
    const catalog = models.length
        ? await InventoryItem.find({ modelNumber: { $in: models } })
            .collation({ locale: 'en', strength: 2 })
            .select('_id modelNumber brandId categoryId')
            .lean()
        : [];
    const modelKey = (value) => String(value || '').trim().toLowerCase();
    const sameRef = (left, right) => String(left || '') === String(right || '');
    for (const row of prepared) {
        for (const { line, quantity } of row.unresolved) {
            const model = String(line.modelNumber || '').trim();
            if (!model) {
                row.blocked = true;
                break;
            }
            const found = catalog.filter((item) => {
                if (modelKey(item.modelNumber) !== modelKey(model)) return false;
                if (line.brandId && mongoose.isValidObjectId(String(line.brandId)) && !sameRef(item.brandId, line.brandId)) return false;
                if (line.categoryId && mongoose.isValidObjectId(String(line.categoryId)) && !sameRef(item.categoryId, line.categoryId)) return false;
                return true;
            });
            if (found.length !== 1) {
                row.blocked = true;
                break;
            }
            const id = String(found[0]._id);
            row.totals.set(id, roundMoney((row.totals.get(id) || 0) + quantity));
            itemIds.add(id);
        }
    }
    const existing = itemIds.size
        ? await InventoryItem.find({ _id: { $in: [...itemIds] } }).select('_id availableQuantity').lean()
        : [];
    const availableByItem = new Map(existing.map((item) => [String(item._id), Number(item.availableQuantity) || 0]));
    for (const row of prepared) {
        if (row.blocked || !row.totals.size) {
            reasons.set(row.id, stockDeleteBlockReason(null));
            continue;
        }
        const known = new Map();
        let missing = false;
        for (const id of row.totals.keys()) {
            if (!availableByItem.has(id)) {
                missing = true;
                break;
            }
            known.set(id, availableByItem.get(id));
        }
        reasons.set(row.id, missing
            ? stockDeleteBlockReason(null)
            : stockDeleteBlockReason({ totals: row.totals, availableByItem: known }));
    }
    return reasons;
}

async function billItemQuantities(lines) {
    const { totals, unresolved } = quantitiesFromLines(lines);
    for (const { line, quantity } of unresolved) {
        const model = String(line.modelNumber || '').trim();
        if (!model) return null;
        const query = { modelNumber: { $regex: new RegExp(`^${escapeRegex(model)}$`, 'i') } };
        if (line.brandId && mongoose.isValidObjectId(String(line.brandId))) query.brandId = line.brandId;
        if (line.categoryId && mongoose.isValidObjectId(String(line.categoryId))) query.categoryId = line.categoryId;
        const found = await InventoryItem.find(query).select('_id').limit(2).lean();
        if (found.length !== 1) return null;
        const id = String(found[0]._id);
        totals.set(id, roundMoney((totals.get(id) || 0) + quantity));
    }
    if (!totals.size) return null;
    const existing = await InventoryItem.find({ _id: { $in: [...totals.keys()] } }).select('_id availableQuantity').lean();
    if (existing.length !== totals.size) return null;
    return {
        totals,
        availableByItem: new Map(existing.map((item) => [String(item._id), Number(item.availableQuantity) || 0])),
    };
}

function stockDeleteBlockReason(quantities) {
    if (!quantities) return 'Delete is disabled because this bill has an item that cannot be removed from stock.';
    for (const [id, quantity] of quantities.totals) {
        const available = quantities.availableByItem.has(id) ? quantities.availableByItem.get(id) : null;
        if (available == null || available < quantity) {
            return 'Delete is disabled because available stock is lower than the quantity this bill added.';
        }
    }
    return '';
}

async function reversePostedStock(quantities) {
    const applied = [];
    try {
        for (const [id, quantity] of quantities.totals) {
            const updated = await InventoryItem.findOneAndUpdate(
                { _id: id, availableQuantity: { $gte: quantity } },
                { $inc: { availableQuantity: -quantity } },
                { new: true },
            );
            if (!updated) {
                throw httpError(400, 'Delete is disabled because available stock is lower than the quantity this bill added.');
            }
            applied.push({ id, quantity });
        }
    } catch (error) {
        for (const row of applied.reverse()) {
            await InventoryItem.updateOne({ _id: row.id }, { $inc: { availableQuantity: row.quantity } });
        }
        throw error;
    }
}

function clipNote(value) {
    return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, 1000);
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
        note: row.note || '',
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
            billNo: cleanName(body?.billNo),
            lpoNo: '',
            note: clipNote(body?.note),
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
        note: clipNote(body?.note),
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
        let result;
        try {
            result = await applyItemStock(req, itemId, {
                quantity: line.quantity,
                price: line.unitPrice,
                categoryId: line.categoryId,
                subcategoryId: line.subcategoryId,
                brandId: line.brandId,
                modelNumber: line.modelNumber || line.itemName,
            });
        } catch (error) {
            if (error?.status !== 403) throw error;
            const created = await createPendingItemRecord({
                categoryId: line.categoryId,
                subcategoryId: line.subcategoryId,
                brandId: line.brandId,
                itemName: line.itemName,
                modelNumber: line.modelNumber,
            });
            result = await applyItemStock(req, String(created.item._id), {
                quantity: line.quantity,
                price: line.unitPrice,
                categoryId: line.categoryId,
                subcategoryId: line.subcategoryId,
                brandId: line.brandId,
                modelNumber: line.modelNumber || line.itemName,
            });
        }
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
        const filter = { status: { $in: ['draft', 'pending', 'posted'] } };
        const vendorId = String(req.query.vendorId || '');
        if (vendorId && mongoose.isValidObjectId(vendorId)) {
            filter.vendorId = vendorId;
            filter.purchaseSource = 'vendor';
        }
        const rows = await InventoryStockEntry.find(filter)
            .select('status purchaseSource vendorId purchaseDate billNo lpoNo lines attachment updatedAt createdBy')
            .lean();
        const vendorIds = [...new Set(rows.map((row) => (row.vendorId ? String(row.vendorId) : '')).filter(Boolean))];
        const vendors = vendorIds.length
            ? await InventoryVendor.find({ _id: { $in: vendorIds } }).select('name paymentTerms').lean()
            : [];
        const vendorInfo = new Map(vendors.map((vendor) => [String(vendor._id), {
            name: vendor.name || '',
            paymentTerms: vendor.paymentTerms || '',
        }]));
        rows.sort((left, right) => {
            const leftOpen = left.status === 'draft' || left.status === 'pending' ? 0 : 1;
            const rightOpen = right.status === 'draft' || right.status === 'pending' ? 0 : 1;
            if (leftOpen !== rightOpen) return leftOpen - rightOpen;
            const leftTime = left.purchaseDate ? new Date(left.purchaseDate).getTime() : 0;
            const rightTime = right.purchaseDate ? new Date(right.purchaseDate).getTime() : 0;
            if (rightTime !== leftTime) return rightTime - leftTime;
            return new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime();
        });
        const viewerId = String(req.user?.id || req.user?._id || '');
        const deleteReasons = await deleteReasonsByBill(rows);
        const viewerIsManagement = await actorIsManagement(req);
        const myDrafts = rows
            .filter((row) => row.status === 'draft' && viewerId && String(row.createdBy || '') === viewerId)
            .map((row) => ({
                id: String(row._id),
                billNo: row.billNo || '',
                message: 'Bill you created is on draft. Submit it.',
                updatedAt: row.updatedAt || row.createdAt || null,
            }));
        await syncViewerDraftBills(rows, viewerId);
        res.json({
            myDrafts,
            isManagement: viewerIsManagement,
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
                const vendor = manual ? null : vendorInfo.get(String(row.vendorId || ''));
                const hasFile = Boolean(row.attachment?.name || row.attachment?.url);
                const deleteReason = row.status === 'posted' ? (deleteReasons.get(String(row._id)) || '') : '';
                return {
                    id: String(row._id),
                    status: billListStatus(row.status),
                    vendorId: row.vendorId ? String(row.vendorId) : '',
                    purchaseSource: manual ? 'manual' : 'vendor',
                    billNo: row.billNo || '',
                    lpoNo: row.lpoNo || '',
                    vendorName: vendor?.name || '',
                    paymentTerms: vendor?.paymentTerms || '',
                    purchaseDate: row.purchaseDate ? new Date(row.purchaseDate).toISOString().slice(0, 10) : '',
                    purchaseType: 'Direct',
                    value: Math.round(value * 100) / 100,
                    lines: (row.lines || []).map((line) => ({
                        itemName: line.itemName || '',
                        description: line.description || '',
                        quantity: line.quantity || 0,
                        unitPrice: line.unitPrice || 0,
                        total: line.total || 0,
                    })),
                    attachment: hasFile
                        ? { name: row.attachment.name || 'Attachment', url: row.attachment.url || '' }
                        : null,
                    deleteDisabled: Boolean(deleteReason),
                    deleteReason,
                    stockApplied: row.status === 'posted',
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
        const managementEdit = entry?.status === 'posted' && await actorIsManagement(req);
        if (entry?.status === 'posted' && !managementEdit) {
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
        if (managementEdit) {
            const previousLines = plainLines(entry.lines);
            const previous = await billItemQuantities(entry.lines);
            const hasQuantity = previousLines.some((line) => Number(line.quantity) > 0);
            if (hasQuantity && stockDeleteBlockReason(previous)) {
                throw httpError(400, 'This bill cannot be edited because available stock is lower than the quantity it added.');
            }
            if (hasQuantity) await reversePostedStock(previous);
            try {
                Object.assign(entry, payload, { postedCount: 0 });
                entry.markModified('lines');
                if (!posting) {
                    entry.status = 'draft';
                    entry.postedAt = null;
                    await entry.save();
                    await notifyDraftBill({ entry, actorId: req.user?.id });
                    res.json(presentEntry(entry));
                    return;
                }
                entry.status = 'posting';
                await entry.save();
                const postedLines = await postLines(req, entry, lines);
                entry.lines = postedLines;
                entry.status = 'posted';
                entry.postedAt = entry.postedAt || new Date();
                await entry.save();
                await closeDraftBill(entry._id, req.user?.employeeObjectId);
                res.json(presentEntry(entry));
                return;
            } catch (error) {
                if (previous?.totals) {
                    for (const [id, quantity] of previous.totals) {
                        await InventoryItem.updateOne({ _id: id }, { $inc: { availableQuantity: quantity } });
                    }
                }
                entry.status = 'posted';
                entry.lines = previousLines;
                entry.postedCount = previousLines.length;
                entry.markModified('lines');
                await entry.save().catch(() => {});
                throw error;
            }
        }
        if (!posting) {
            if (entry?.status === 'pending' && !await actorIsManagement(req)) {
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
            await notifyDraftBill({ entry, actorId: req.user?.id });
            res.status(creating ? 201 : 200).json(presentEntry(entry));
            return;
        }
        const officer = await findPurchaseOfficer();
        if (!officer) {
            throw httpError(400, 'Add purchaser on workflow. Then only can create or submit. Else Draft or Cancel.');
        }
        const purchasingOfficer = actorIsPurchaseOfficer(req, officer);
        if (!purchasingOfficer) {
            const senderName = cleanName(req.user?.name) || 'An employee';
            const pendingPayload = {
                ...payload,
                status: 'pending',
                postedAt: null,
                postedCount: 0,
                submittedByName: senderName,
                approverName: officer.employeeName || 'Purchase Officer',
                approverEmployeeId: officer.empObjectId || null,
            };
            const creating = !entry;
            if (entry) {
                Object.assign(entry, pendingPayload);
                entry.markModified('lines');
                await entry.save();
            } else {
                entry = await InventoryStockEntry.create(pendingPayload);
            }
            await notifyStockApproval({ entry, officer, senderName });
            await closeDraftBill(entry._id, req.user?.employeeObjectId);
            res.status(creating ? 201 : 200).json(presentEntry(entry));
            return;
        }
        const wasPending = entry?.status === 'pending';
        if (entry) {
            const alreadyPosted = entry.postedCount || 0;
            const claimed = await InventoryStockEntry.findOneAndUpdate(
                { _id: entry._id, status: { $in: ['draft', 'pending'] } },
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
            if (wasPending) await closeStockApproval(entry._id, 'Approved', req.user?.employeeObjectId);
            await closeDraftBill(entry._id, req.user?.employeeObjectId);
            res.status(201).json(presentEntry(entry));
        } catch (error) {
            entry.status = 'draft';
            await entry.save();
            await notifyDraftBill({ entry, actorId: entry.createdBy || req.user?.id });
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
            isManagement: await actorIsManagement(req),
            hasPurchaseOfficer: Boolean(officer),
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
            await closeDraftBill(claimed._id, req.user?.employeeObjectId);
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
            await closeDraftBill(entry._id, req.user?.employeeObjectId);
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

export async function deleteStockEntry(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Bill was not found.');
        const entry = await InventoryStockEntry.findById(req.params.id);
        if (!entry || entry.status === 'posting') throw httpError(404, 'Bill was not found.');

        const posted = entry.status === 'posted';
        let reversed = null;
        if (posted) {
            const quantities = await billItemQuantities(entry.lines);
            const reason = stockDeleteBlockReason(quantities);
            if (reason) throw httpError(400, reason);
            await reversePostedStock(quantities);
            reversed = quantities;
        }

        try {
            if (entry.status !== 'draft') {
                const label = entry.billNo || String(entry._id);
                const details = posted
                    ? `Approved bill ${label} deleted. Stock added by this bill was removed.`
                    : `Bill ${label} deleted before stock was added.`;
                await awaitAdminDeletionArchive(req, {
                    moduleName: 'Inventory Bill',
                    recordId: label,
                    details,
                    deletedPayload: entry.toObject(),
                    archive: {
                        topModule: 'other',
                        category: 'list',
                        entityType: 'inventory_bill',
                        title: 'Inventory Bill',
                        subtitle: label,
                        details,
                    },
                });
                await closeStockApproval(entry._id, 'Rejected', req.user?.employeeObjectId);
            }
            await closeDraftBill(entry._id, req.user?.employeeObjectId);
            await InventoryStockEntry.deleteOne({ _id: entry._id });
        } catch (error) {
            if (reversed) {
                for (const [id, quantity] of reversed.totals) {
                    await InventoryItem.updateOne({ _id: id }, { $inc: { availableQuantity: quantity } });
                }
            }
            throw error;
        }
        res.json({ ok: true });
    } catch (error) {
        sendError(res, error);
    }
}

function dateKey(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 10);
}

export async function listItemPurchaseHistory(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Item was not found.');
        const itemId = String(req.params.id);
        const rows = await InventoryStockEntry.find({
            status: 'posted',
            'lines.itemId': itemId,
        })
            .select('purchaseSource vendorId purchaseDate billNo lines postedAt')
            .lean();
        const vendorIds = [...new Set(rows.map((row) => (row.vendorId ? String(row.vendorId) : '')).filter(Boolean))];
        const vendors = vendorIds.length
            ? await InventoryVendor.find({ _id: { $in: vendorIds } }).select('name').lean()
            : [];
        const vendorNames = new Map(vendors.map((vendor) => [String(vendor._id), vendor.name || '']));
        const purchases = [];
        rows.forEach((row) => {
            (row.lines || []).forEach((line, index) => {
                if (String(line.itemId || '') !== itemId) return;
                purchases.push({
                    id: `${row._id}-${index}`,
                    entryId: String(row._id),
                    purchaseDate: dateKey(row.purchaseDate) || dateKey(row.postedAt),
                    vendorId: row.purchaseSource === 'manual' ? '' : (row.vendorId ? String(row.vendorId) : ''),
                    vendorName: row.purchaseSource === 'manual' ? 'Manual' : (vendorNames.get(String(row.vendorId || '')) || ''),
                    billNo: row.billNo || '',
                    quantity: line.quantity || 0,
                    unitPrice: line.unitPrice || 0,
                    sortTime: row.postedAt ? new Date(row.postedAt).getTime() : 0,
                });
            });
        });
        purchases.sort((left, right) => {
            if (right.purchaseDate !== left.purchaseDate) return right.purchaseDate.localeCompare(left.purchaseDate);
            return right.sortTime - left.sortTime;
        });
        res.json({
            purchases: purchases.map(({ sortTime, ...row }) => row),
        });
    } catch (error) {
        sendError(res, error);
    }
}

export async function listItemDocuments(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Item was not found.');
        const itemId = String(req.params.id);
        const rows = await InventoryStockEntry.find({
            status: 'posted',
            'lines.itemId': itemId,
        })
            .select('purchaseSource vendorId purchaseDate billNo attachment postedAt')
            .lean();
        const attached = rows.filter((row) => row.attachment?.name || row.attachment?.url);
        const vendorIds = [...new Set(attached.map((row) => (row.vendorId ? String(row.vendorId) : '')).filter(Boolean))];
        const vendors = vendorIds.length
            ? await InventoryVendor.find({ _id: { $in: vendorIds } }).select('name').lean()
            : [];
        const vendorNames = new Map(vendors.map((vendor) => [String(vendor._id), vendor.name || '']));
        const documents = attached.map((row) => ({
            id: String(row._id),
            entryId: String(row._id),
            purchaseDate: dateKey(row.purchaseDate) || dateKey(row.postedAt),
            vendorId: row.purchaseSource === 'manual' ? '' : (row.vendorId ? String(row.vendorId) : ''),
            vendorName: row.purchaseSource === 'manual' ? 'Manual' : (vendorNames.get(String(row.vendorId || '')) || ''),
            billNo: row.billNo || '',
            fileName: row.attachment?.name || 'Attachment',
            fileUrl: row.attachment?.url || '',
            sortTime: row.postedAt ? new Date(row.postedAt).getTime() : 0,
        }));
        documents.sort((left, right) => {
            if (right.purchaseDate !== left.purchaseDate) return right.purchaseDate.localeCompare(left.purchaseDate);
            return right.sortTime - left.sortTime;
        });
        res.json({
            documents: documents.map(({ sortTime, ...row }) => row),
        });
    } catch (error) {
        sendError(res, error);
    }
}
