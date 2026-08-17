import ZohoBill from '../models/ZohoBill.js';
import ZohoExpense from '../models/ZohoExpense.js';
import { fetchBillById, fetchExpenseById, getZohoOrganizationId } from '../services/zohoService.js';
import { mapZohoExpenseToDoc } from './zohoPurchaseMappers.js';
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
    return (
        clean(doc.expenseNumber) ||
        clean(doc.zohoRaw?.expense_number) ||
        clean(doc.zohoRaw?.expenseNumber)
    );
}

export function zohoReturnedBillNumber(zohoBill, fallback = '') {
    return clean(zohoBill?.bill_number || zohoBill?.billNumber || fallback);
}

async function persistIfEmpty(persistModel, filter, field, value) {
    if (!persistModel || !value || !filter) return;
    try {
        await persistModel.updateMany(
            {
                ...filter,
                $or: [{ [field]: '' }, { [field]: null }, { [field]: { $exists: false } }],
            },
            { $set: { [field]: value } },
        );
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

async function liveBillNumber(record) {
    const id = clean(record?.zohoBillId);
    if (!id) return '';
    try {
        const live = await withZohoOrganization(record?.zohoOrganizationId || null, () =>
            fetchBillById(id),
        );
        const number = zohoReturnedBillNumber(live);
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

async function liveExpenseNumber(record) {
    const id = clean(record?.zohoExpenseId);
    if (!id) return '';
    try {
        const live = await withZohoOrganization(record?.zohoOrganizationId || null, () =>
            fetchExpenseById(id),
        );
        const number = clean(live?.expense_number || live?.expenseNumber);
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
 * Fill zohoBillNumber from cache, the number sent to Zoho, or a one-time live Zoho fetch.
 * Already-billed rows without a stored serial get backfilled and persisted.
 */
export async function attachZohoBillNumbers(records = [], options = {}) {
    const list = Array.isArray(records) ? records : [];
    const { persistModel = null, fetchLive = false } = options;

    const missingIds = [];
    for (const rec of list) {
        if (clean(rec?.zohoBillNumber)) continue;
        missingIds.push(...collectBillIds(rec));
    }
    const unique = [...new Set(missingIds)];
    const map = new Map();
    if (unique.length) {
        const rows = await ZohoBill.find({ zohoBillId: { $in: unique } })
            .select('zohoBillId billNumber')
            .lean();
        for (const row of rows) {
            const id = clean(row.zohoBillId);
            const number = clean(row.billNumber);
            if (id && number) map.set(id, number);
        }
    }

    const out = [];
    for (const rec of list) {
        const id = clean(rec?.zohoBillId);
        let zohoBillNumber =
            clean(rec?.zohoBillNumber) ||
            map.get(id) ||
            (id ? clean(rec?.billNumber) : '');

        if (!zohoBillNumber && fetchLive && id) {
            zohoBillNumber = await liveBillNumber(rec);
        }

        if (
            persistModel &&
            zohoBillNumber &&
            !clean(rec?.zohoBillNumber) &&
            (id || rec?._id)
        ) {
            await persistIfEmpty(
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
    if (clean(record.zohoExpenseNumber)) return record;
    const id = clean(record.zohoExpenseId);
    if (!id) return record;

    const cached = await ZohoExpense.findOne({ zohoExpenseId: id })
        .select('expenseNumber zohoRaw')
        .lean();
    let zohoExpenseNumber = expenseNumberFromCache(cached);

    if (!zohoExpenseNumber && fetchLive) {
        zohoExpenseNumber = await liveExpenseNumber(record);
    }

    if (!zohoExpenseNumber) return record;

    if (persistModel && record._id) {
        await persistIfEmpty(
            persistModel,
            { _id: record._id },
            'zohoExpenseNumber',
            zohoExpenseNumber,
        );
    }

    return { ...record, zohoExpenseNumber };
}
