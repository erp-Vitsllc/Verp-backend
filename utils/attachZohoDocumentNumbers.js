import ZohoBill from '../models/ZohoBill.js';
import ZohoExpense from '../models/ZohoExpense.js';
import { fetchBillByIdAcrossOrgs, fetchExpenseById, getZohoOrganizationId } from '../services/zohoService.js';
import {
    mapZohoExpenseToDoc,
    resolveZohoBillSerialNumber,
    resolveZohoExpenseSerialNumber,
    looksLikeZohoBillSerial,
} from './zohoPurchaseMappers.js';
import { withZohoOrganization } from './zohoOrgContext.js';

function clean(value) {
    return String(value ?? '').trim();
}

function collectBillIds(record) {
    const ids = [];
    const primary = clean(record?.zohoBillId);
    if (primary) ids.push(primary);
    for (const extra of record?.zohoBillIds || []) {
        const id = clean(extra);
        if (id) ids.push(id);
    }
    return ids;
}

export function expenseNumberFromCache(doc) {
    if (!doc) return '';
    const fromRaw = resolveZohoExpenseSerialNumber(doc.zohoRaw);
    return (
        clean(fromRaw) ||
        clean(doc.expenseNumber) ||
        clean(doc.zohoRaw?.expense_number) ||
        clean(doc.zohoRaw?.expenseNumber)
    );
}

/** Zoho Books Serial No. custom field — not Bill# (bill_number). */
export function zohoReturnedBillSerialNumber(zohoBill) {
    return resolveZohoBillSerialNumber(zohoBill);
}

async function persistZohoDocumentNumber(persistModel, filter, field, value) {
    if (!persistModel || !value || !filter) return;
    try {
        await persistModel.updateMany(filter, { $set: { [field]: value } });
    } catch (err) {
        console.warn(
            `[attachZohoDocumentNumbers] persist ${field} failed:`,
            err?.message || err,
        );
    }
}

function resolveOrgId(record) {
    const stored = clean(record?.zohoOrganizationId);
    if (stored) return stored;
    try {
        return getZohoOrganizationId();
    } catch {
        return '';
    }
}

function serialFromCacheRow(row) {
    if (!row) return '';
    return (
        resolveZohoBillSerialNumber(row.zohoRaw) ||
        (looksLikeZohoBillSerial(row.billNumber) ? clean(row.billNumber) : '')
    );
}

async function liveBillSerialNumber(record) {
    const id = clean(record?.zohoBillId);
    if (!id) return '';
    try {
        const live = await fetchBillByIdAcrossOrgs(id, record?.zohoOrganizationId);
        const number = zohoReturnedBillSerialNumber(live);
        if (live) {
            try {
                const { upsertZohoBillFromApi } = await import(
                    '../services/zohoPurchaseSyncService.js'
                );
                await upsertZohoBillFromApi(live);
            } catch {
                /* cache upsert is best-effort */
            }
        }
        return number;
    } catch (err) {
        console.warn('[attachZohoBillNumbers] live fetch failed:', err?.message || err);
        return '';
    }
}

async function liveExpenseSerialNumber(record) {
    const id = clean(record?.zohoExpenseId);
    if (!id) return '';
    try {
        const live = await withZohoOrganization(record?.zohoOrganizationId || null, () =>
            fetchExpenseById(id),
        );
        const number =
            resolveZohoExpenseSerialNumber(live) ||
            clean(live?.expense_number || live?.expenseNumber);
        if (live) {
            try {
                const orgId = resolveOrgId(record);
                const doc = mapZohoExpenseToDoc(live, orgId, new Date());
                if (doc && orgId) {
                    await ZohoExpense.findOneAndUpdate(
                        { organizationId: orgId, zohoExpenseId: doc.zohoExpenseId },
                        { $set: doc },
                        { upsert: true },
                    );
                }
            } catch {
                /* cache upsert is best-effort */
            }
        }
        return number;
    } catch (err) {
        console.warn('[attachZohoExpenseNumber] live fetch failed:', err?.message || err);
        return '';
    }
}

/**
 * Fill zohoBillNumber from Zoho Serial No. custom field (cache or live fetch).
 * Never use Bill# (bill_number) or ERP invoice / account numbers.
 */
export async function attachZohoBillNumbers(records = [], options = {}) {
    const list = Array.isArray(records) ? records : [];
    const { persistModel = null, fetchLive = false } = options;

    const missingIds = [];
    for (const rec of list) {
        missingIds.push(...collectBillIds(rec));
    }
    const unique = [...new Set(missingIds)];
    const map = new Map();
    if (unique.length) {
        const rows = await ZohoBill.find({ zohoBillId: { $in: unique } })
            .select('zohoBillId billNumber zohoRaw')
            .lean();
        for (const row of rows) {
            const id = clean(row.zohoBillId);
            const number = serialFromCacheRow(row);
            if (id && number) map.set(id, number);
        }
    }

    const out = [];
    for (const rec of list) {
        const id = clean(rec?.zohoBillId);
        const cachedSerial = id ? map.get(id) : '';
        const storedSerial = clean(rec?.zohoBillNumber);
        let zohoBillNumber = cachedSerial || storedSerial;

        if (fetchLive && id) {
            const liveSerial = await liveBillSerialNumber(rec);
            if (liveSerial) zohoBillNumber = liveSerial;
        }

        if (persistModel && zohoBillNumber && (id || rec?._id)) {
            await persistZohoDocumentNumber(
                persistModel,
                id ? { zohoBillId: id } : { _id: rec._id },
                'zohoBillNumber',
                zohoBillNumber,
            );
        }

        out.push({ ...rec, zohoBillNumber });
    }
    return out;
}

export async function attachZohoExpenseNumber(record, options = {}) {
    if (!record) return record;
    const { persistModel = null, fetchLive = false } = options;
    const id = clean(record.zohoExpenseId);
    if (!id) return record;

    const cached = await ZohoExpense.findOne({ zohoExpenseId: id })
        .select('expenseNumber zohoRaw')
        .lean();
    let zohoExpenseNumber = expenseNumberFromCache(cached);

    if (!zohoExpenseNumber && fetchLive) {
        zohoExpenseNumber = await liveExpenseSerialNumber(record);
    } else if (
        cached &&
        zohoExpenseNumber &&
        zohoExpenseNumber !== clean(record.zohoExpenseNumber)
    ) {
        /* prefer cache serial over stale stored value */
    }

    if (!zohoExpenseNumber) return record;

    if (persistModel && record._id) {
        await persistZohoDocumentNumber(
            persistModel,
            { _id: record._id },
            'zohoExpenseNumber',
            zohoExpenseNumber,
        );
    }

    return { ...record, zohoExpenseNumber };
}
