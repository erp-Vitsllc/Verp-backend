import ZohoBill from '../models/ZohoBill.js';
import UtilityBillPayment from '../models/UtilityBillPayment.js';
import { searchZohoBillsByNumber } from '../services/zohoService.js';
import { resolveZohoVendorIdByProvider } from './syncUtilityBillToZoho.js';

export const DUPLICATE_BILL_MESSAGES = {
    zoho: 'This bill has already been added for this vendor in Zoho.',
    pending: 'This bill is already pending for this vendor.',
    modal: 'This bill has already been added for this vendor in the current bill.',
};

export function vendorBillKey(vendor, billNumber) {
    const v = String(vendor || '').trim().toLowerCase();
    const n = String(billNumber || '').trim().toLowerCase();
    if (!v || !n) return '';
    return `${v}::${n}`;
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeBillNumber(value) {
    return String(value || '').trim().toLowerCase();
}

function billNumbersMatch(entered, ...candidates) {
    const needle = normalizeBillNumber(entered);
    if (!needle) return false;
    return candidates.some((value) => normalizeBillNumber(value) === needle);
}

/** Same loose match used when creating a Zoho bill from a utility provider name. */
function vendorNamesMatch(provider, vendorName) {
    const a = String(provider || '').trim().toLowerCase();
    const b = String(vendorName || '').trim().toLowerCase();
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length >= 4 && b.includes(a)) return true;
    if (b.length >= 4 && a.includes(b)) return true;
    return false;
}

function vendorBillPairFilter(vendor, billNumber) {
    return {
        provider: new RegExp(`^${escapeRegex(vendor)}$`, 'i'),
        billNumber: new RegExp(`^${escapeRegex(billNumber)}$`, 'i'),
    };
}

function zohoNumberFilter(billNumber) {
    const billRe = new RegExp(`^${escapeRegex(billNumber)}$`, 'i');
    return {
        $or: [
            { billNumber: billRe },
            { referenceNumber: billRe },
            { utilityParentBillNumber: billRe },
        ],
    };
}

function cachedRowMatchesPair(row, vendor, billNumber, vendorId) {
    if (
        !billNumbersMatch(
            billNumber,
            row?.billNumber,
            row?.referenceNumber,
            row?.utilityParentBillNumber,
        )
    ) {
        return false;
    }
    if (vendorId && String(row?.vendorId || '').trim() === vendorId) return true;
    return vendorNamesMatch(vendor, row?.vendorName);
}

function liveRowMatchesPair(row, vendor, billNumber, vendorId) {
    if (!billNumbersMatch(billNumber, row?.bill_number, row?.reference_number)) {
        return false;
    }
    if (vendorId && String(row?.vendor_id || '').trim() === vendorId) return true;
    return vendorNamesMatch(vendor, row?.vendor_name);
}

async function resolveVendorIdCached(vendor, cache) {
    const key = String(vendor || '').trim().toLowerCase();
    if (!key) return '';
    if (cache.has(key)) return cache.get(key);
    let vendorId = '';
    try {
        vendorId = String((await resolveZohoVendorIdByProvider(vendor)) || '').trim();
    } catch (err) {
        console.warn(
            '[lookupVendorBillDuplicates] vendor resolve failed:',
            err?.message || err,
        );
    }
    cache.set(key, vendorId);
    return vendorId;
}

/**
 * Look up Vendor + Bill Number against Zoho Bills and pending ERP utility bills.
 * Does not check the current modal — the client does that locally.
 */
export async function lookupVendorBillDuplicates(items = [], { excludeIds = [] } = {}) {
    const pairs = (Array.isArray(items) ? items : [])
        .map((item, index) => ({
            index,
            vendor: String(item?.provider || item?.vendor || '').trim(),
            billNumber: String(item?.billNumber || '').trim(),
        }))
        .filter((item) => item.vendor && item.billNumber);

    const empty = (Array.isArray(items) ? items : []).map((_, index) => ({
        index,
        source: null,
        message: '',
    }));
    if (!pairs.length) return empty;

    const cachedRows = await ZohoBill.find({
        isActive: { $ne: false },
        $or: pairs.map((p) => zohoNumberFilter(p.billNumber)),
    })
        .select('vendorName vendorId billNumber referenceNumber utilityParentBillNumber')
        .lean();

    const vendorIdCache = new Map();
    const zohoDupIndexes = new Set();
    const liveMisses = [];

    for (const pair of pairs) {
        const vendorId = await resolveVendorIdCached(pair.vendor, vendorIdCache);
        const localHit = (cachedRows || []).some((row) =>
            cachedRowMatchesPair(row, pair.vendor, pair.billNumber, vendorId),
        );
        if (localHit) {
            zohoDupIndexes.add(pair.index);
        } else {
            liveMisses.push({ ...pair, vendorId });
        }
    }

    const liveByNumber = new Map();
    for (const miss of liveMisses) {
        const numberKey = normalizeBillNumber(miss.billNumber);
        if (!liveByNumber.has(numberKey)) {
            liveByNumber.set(numberKey, await searchZohoBillsByNumber(miss.billNumber));
        }
        const liveRows = liveByNumber.get(numberKey) || [];
        if (
            liveRows.some((row) =>
                liveRowMatchesPair(row, miss.vendor, miss.billNumber, miss.vendorId),
            )
        ) {
            zohoDupIndexes.add(miss.index);
        }
    }

    const exclude = (Array.isArray(excludeIds) ? excludeIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean);

    const pendingQuery = {
        status: { $in: ['Pending Accounts', 'Pending HR'] },
        $or: pairs.map((p) => vendorBillPairFilter(p.vendor, p.billNumber)),
    };
    if (exclude.length) {
        pendingQuery._id = { $nin: exclude };
    }

    const pendingHits = await UtilityBillPayment.find(pendingQuery)
        .select('provider billNumber')
        .lean();
    const pendingKeys = new Set(
        (pendingHits || []).map((row) => vendorBillKey(row.provider, row.billNumber)),
    );

    return (Array.isArray(items) ? items : []).map((item, index) => {
        const key = vendorBillKey(item?.provider || item?.vendor, item?.billNumber);
        if (!key) return { index, source: null, message: '' };
        if (zohoDupIndexes.has(index)) {
            return { index, source: 'zoho', message: DUPLICATE_BILL_MESSAGES.zoho };
        }
        if (pendingKeys.has(key)) {
            return { index, source: 'pending', message: DUPLICATE_BILL_MESSAGES.pending };
        }
        return { index, source: null, message: '' };
    });
}

export function findCurrentBatchVendorBillDuplicate(rows = []) {
    const seen = new Map();
    for (let i = 0; i < rows.length; i += 1) {
        const key = vendorBillKey(rows[i]?.provider || rows[i]?.vendor, rows[i]?.billNumber);
        if (!key) continue;
        if (seen.has(key)) {
            return {
                index: i,
                source: 'modal',
                message: DUPLICATE_BILL_MESSAGES.modal,
            };
        }
        seen.set(key, i);
    }
    return null;
}
