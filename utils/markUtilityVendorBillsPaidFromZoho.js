import mongoose from 'mongoose';
import UtilityBillPayment from '../models/UtilityBillPayment.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import DashboardAction from '../models/DashboardAction.js';
import ZohoBill from '../models/ZohoBill.js';
import {
    fetchBillById,
    isZohoBillMissingError,
    isZohoBooksRateLimitError,
    searchZohoBillsByNumber,
    searchZohoBillsByText,
} from '../services/zohoService.js';
import { resolveZohoBillSerialNumber } from './zohoPurchaseMappers.js';
import { upsertZohoBillFromApi } from '../services/zohoPurchaseSyncService.js';
import { withZohoOrganization } from './zohoOrgContext.js';
import { resolveZohoOrganizationIdForCompany } from './resolveZohoOrganization.js';
import Company from '../models/Company.js';

const UTILITY_REQUEST_TYPE = 'Utility Bill Payment';

/** Zoho's 5,000-call cap is per organization per day. Stop calling that org until restart. */
const zohoOrgRateLimited = new Set();

const clean = (value, fallback = '') => {
    const text = String(value ?? '').trim();
    return text || fallback;
};

function toAmount(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    const text = String(value ?? '').trim();
    if (!text) return NaN;
    const n = Number(text.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : NaN;
}

function paymentRowsTotal(zohoBill) {
    const rows = []
        .concat(Array.isArray(zohoBill?.payments) ? zohoBill.payments : [])
        .concat(Array.isArray(zohoBill?.vendorpayments) ? zohoBill.vendorpayments : []);
    return rows.reduce((sum, row) => {
        const amount = toAmount(
            row?.amount ?? row?.amount_applied ?? row?.payment_amount ?? row?.total,
        );
        return Number.isFinite(amount) ? sum + amount : sum;
    }, 0);
}

function zohoBillHasPaymentSignal(zohoBill) {
    const source =
        zohoBill?.bill && typeof zohoBill.bill === 'object' ? zohoBill.bill : zohoBill;
    if (!source || typeof source !== 'object') return false;
    if (clean(source.status || source.status_formatted || source.current_sub_status)) return true;
    const balance = toAmount(
        source.balance ?? source.balance_due ?? source.balanceDue ?? source.bcy_balance,
    );
    if (Number.isFinite(balance)) return true;
    const total = toAmount(source.total ?? source.total_amount ?? source.amount);
    return Number.isFinite(total);
}

function isZohoBillFullyPaidFields(zohoBill) {
    const status = clean(
        zohoBill.status || zohoBill.status_formatted || zohoBill.current_sub_status,
    )
        .toLowerCase()
        .replace(/\s+/g, '_');
    if (status === 'paid' || status === 'fully_paid') return true;
    if (status === 'void' || status === 'draft') return false;

    const total = toAmount(zohoBill.total ?? zohoBill.total_amount ?? zohoBill.amount);
    const paymentMade = toAmount(
        zohoBill.payment_made ?? zohoBill.payments_made ?? zohoBill.paymentMade,
    );
    const applied = Math.max(
        Number.isFinite(paymentMade) ? paymentMade : 0,
        paymentRowsTotal(zohoBill),
    );
    if (Number.isFinite(total) && total > 0 && applied + 0.009 >= total) return true;

    const balance = toAmount(
        zohoBill.balance ?? zohoBill.balance_due ?? zohoBill.balanceDue ?? zohoBill.bcy_balance,
    );
    // Group payments can leave status as open / partially_paid while the balance is already cleared.
    if (Number.isFinite(balance) && Math.abs(balance) < 0.05 && (!Number.isFinite(total) || total > 0)) {
        return true;
    }
    return false;
}

/** Zoho bill is fully paid (balance cleared). Avoid matching "unpaid". */
export function isZohoBillFullyPaid(zohoBill) {
    if (!zohoBill || typeof zohoBill !== 'object') return false;
    if (
        zohoBill.bill &&
        typeof zohoBill.bill === 'object' &&
        (zohoBill.bill.status || zohoBill.bill.bill_id || zohoBill.bill.status_formatted)
    ) {
        return isZohoBillFullyPaid(zohoBill.bill);
    }
    if (zohoBill.zohoRaw && typeof zohoBill.zohoRaw === 'object') {
        if (isZohoBillFullyPaidFields(zohoBill.zohoRaw)) return true;
    }
    return isZohoBillFullyPaidFields(zohoBill);
}

function collectZohoIdsFromUtilityBill(bill) {
    const ids = new Set();
    const push = (v) => {
        const id = clean(v);
        if (id) ids.add(id);
    };
    push(bill?.zohoBillId);
    for (const id of Array.isArray(bill?.zohoBillIds) ? bill.zohoBillIds : []) push(id);
    for (const line of Array.isArray(bill?.zohoLineItems) ? bill.zohoLineItems : []) {
        push(line?.zohoBillId);
    }
    return [...ids];
}

/** True when the ERP utility bill is linked to at least one Zoho bill. */
export function utilityBillHasZohoLink(bill) {
    if (clean(bill?.zohoBillNumber)) return true;
    return collectZohoIdsFromUtilityBill(bill).length > 0;
}

async function resolvePaidByEmployeeId(userId) {
    if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) return null;
    const userEmp = await EmployeeBasic.findOne({
        $or: [{ _id: userId }, { userId }],
    })
        .select('_id')
        .lean();
    if (userEmp?._id) return userEmp._id;
    try {
        return new mongoose.Types.ObjectId(String(userId));
    } catch {
        return null;
    }
}

async function persistUtilityBillsAsPaid(bills, { paidBy = null, comment = '' } = {}) {
    if (!bills?.length) return { paidCount: 0, bills: [] };
    const now = new Date();
    const batchIds = new Set();

    for (const bill of bills) {
        bill.status = 'Paid';
        bill.pendingWithName = '';
        bill.pendingWithRole = '';
        bill.paidBy = paidBy || bill.paidBy || null;
        bill.paidAt = now;
        bill.actionedBy = paidBy || bill.actionedBy || null;
        bill.actionedAt = now;
        if (comment) bill.comment = comment;
        const zs = String(bill.zohoBillStatus || '').toLowerCase();
        if (zs && zs !== 'draft' && zs !== 'open') {
            bill.zohoBillStatus = 'open';
        }
        try {
            await bill.save();
        } catch (saveErr) {
            console.warn(
                '[persistUtilityBillsAsPaid] save failed:',
                saveErr?.message || saveErr,
            );
            continue;
        }
        if (bill.batchId) batchIds.add(String(bill.batchId));
    }

    try {
        const { clearUtilityBillPaymentDayRemindersForBills } = await import(
            './processUtilityBillPaymentDayReminders.js'
        );
        await clearUtilityBillPaymentDayRemindersForBills(
            bills,
            'Month bill paid — payment day reminder cleared',
        );
    } catch (remErr) {
        console.warn(
            '[persistUtilityBillsAsPaid] payment-day reminder clear failed:',
            remErr?.message || remErr,
        );
    }

    try {
        for (const bid of batchIds) {
            if (!mongoose.Types.ObjectId.isValid(bid)) continue;
            const remainingApproved = await UtilityBillPayment.countDocuments({
                batchId: bid,
                status: 'Approved',
            });
            if (remainingApproved === 0) {
                await DashboardAction.updateMany(
                    {
                        requestId: bid,
                        requestType: UTILITY_REQUEST_TYPE,
                        status: 'Pending',
                    },
                    {
                        status: 'Approved',
                        actionedDate: now,
                        actionedBy: paidBy || null,
                        comment: comment || 'Paid via Zoho',
                    },
                );
            }
        }
    } catch (dashErr) {
        console.warn(
            '[persistUtilityBillsAsPaid] dashboard sync failed:',
            dashErr?.message || dashErr,
        );
    }

    return {
        paidCount: bills.length,
        bills: bills.map((b) => (typeof b.toObject === 'function' ? b.toObject() : b)),
    };
}

/** True when a Zoho bill row is the serial / bill number shown on the utility card. */
export function zohoBillMatchesDisplayedNumber(zohoBill, number) {
    const wanted = clean(number);
    if (!wanted || !zohoBill || typeof zohoBill !== 'object') return false;
    const serial = clean(resolveZohoBillSerialNumber(zohoBill));
    if (serial && serial === wanted) return true;
    return [
        zohoBill.bill_number,
        zohoBill.billNumber,
        zohoBill.reference_number,
        zohoBill.referenceNumber,
    ].some((value) => clean(value) === wanted);
}

/**
 * Zoho bills sync already knows these ids are paid. Stamp the linked utility
 * rows, including a match on the Serial No. shown in the ERP.
 */
export async function markUtilityBillsPaidForZohoBillIds(zohoBillIds = []) {
    const ids = [...new Set((Array.isArray(zohoBillIds) ? zohoBillIds : []).map((id) => clean(id)).filter(Boolean))];
    if (!ids.length) return { paidCount: 0, bills: [] };

    const cached = await ZohoBill.find({ zohoBillId: { $in: ids } })
        .select('billNumber zohoRaw')
        .lean();
    const serials = [
        ...new Set(
            cached
                .map(
                    (row) =>
                        clean(resolveZohoBillSerialNumber(row?.zohoRaw)) ||
                        clean(row?.billNumber),
                )
                .filter(Boolean),
        ),
    ];
    const or = [
        { zohoBillId: { $in: ids } },
        { zohoBillIds: { $in: ids } },
        { 'zohoLineItems.zohoBillId': { $in: ids } },
    ];
    if (serials.length) or.push({ zohoBillNumber: { $in: serials } });

    const bills = await UtilityBillPayment.find({
        status: 'Approved',
        $or: or,
    });
    if (!bills.length) return { paidCount: 0, bills: [] };
    return persistUtilityBillsAsPaid(bills, {
        comment: 'Paid in Zoho (synced to ERP)',
    });
}

function collectZohoBillIds({ body = {}, payload = {}, zohoPayment = {} } = {}) {
    const ids = new Set();
    const push = (value) => {
        const id = clean(value);
        if (id) ids.add(id);
    };

    const billLists = [
        body.bills,
        payload.bills,
        zohoPayment.bills,
        body.applied_bills,
        body.appliedBills,
    ];
    for (const list of billLists) {
        for (const bill of Array.isArray(list) ? list : []) {
            push(bill?.bill_id || bill?.billId || bill?.zohoBillId);
        }
    }

    const links = Array.isArray(body.utilityBillLinks) ? body.utilityBillLinks : [];
    for (const link of links) {
        push(link?.zohoBillId || link?.bill_id || link?.billId);
    }

    for (const id of [].concat(body.zohoBillIds || [], body.zohoBillId || [])) {
        push(id);
    }

    return [...ids];
}

function collectUtilityBillMongoIds(body = {}) {
    const ids = new Set();
    const push = (value) => {
        const id = clean(value);
        if (id && mongoose.Types.ObjectId.isValid(id)) ids.add(id);
    };

    for (const id of [].concat(body.utilityBillIds || [], body.billIds || [], body.utilityBillId || [])) {
        push(id);
    }

    const links = Array.isArray(body.utilityBillLinks) ? body.utilityBillLinks : [];
    for (const link of links) {
        push(link?.utilityBillId || link?.billId || link?._id);
    }

    const partyRows = Array.isArray(body.party_expenses)
        ? body.party_expenses
        : Array.isArray(body.partyExpenses)
          ? body.partyExpenses
          : [];
    for (const row of partyRows) {
        push(row?.utilityBillId);
    }

    return [...ids];
}

/**
 * After Zoho Payments Made Save as Paid on a vendor utility bill, flip ERP
 * UtilityBillPayment Approved → Paid so Latest Bills Vendor Payment shows PAID
 * and company/employee utility_share rows follow.
 *
 * Skips difference/balance settles (those only pay Acc2 / party expense).
 */
export async function markUtilityVendorBillsPaidFromZohoPayment({
    body = {},
    payload = {},
    zohoPayment = {},
    userId = null,
} = {}) {
    const mode = clean(body.mode || body.utilityPayMode).toLowerCase();
    if (mode === 'difference' || mode === 'balance' || mode === 'fine_bills') {
        return { paidCount: 0, bills: [] };
    }

    const zohoBillIds = collectZohoBillIds({ body, payload, zohoPayment });
    const mongoIds = collectUtilityBillMongoIds(body);
    const batchId = clean(body.utilityBatchId || body.batchId);

    const or = [];
    if (zohoBillIds.length) {
        or.push({ zohoBillId: { $in: zohoBillIds } });
        or.push({ zohoBillIds: { $in: zohoBillIds } });
        or.push({ 'zohoLineItems.zohoBillId': { $in: zohoBillIds } });
    }
    if (mongoIds.length) {
        or.push({
            _id: {
                $in: mongoIds.map((id) => new mongoose.Types.ObjectId(id)),
            },
        });
    }

    if (!or.length && batchId && mongoose.Types.ObjectId.isValid(batchId) && mode === 'bills') {
        or.push({ batchId: new mongoose.Types.ObjectId(batchId) });
    }

    if (!or.length) {
        return { paidCount: 0, bills: [] };
    }

    let bills = await UtilityBillPayment.find({
        status: 'Approved',
        $or: or,
    });
    if (!bills.length) {
        return { paidCount: 0, bills: [] };
    }

    if (zohoBillIds.length) {
        const zohoSet = new Set(zohoBillIds);
        bills = bills.filter((bill) => {
            const primary = clean(bill.zohoBillId);
            if (primary && zohoSet.has(primary)) return true;
            const extras = Array.isArray(bill.zohoBillIds) ? bill.zohoBillIds : [];
            if (extras.some((id) => zohoSet.has(clean(id)))) return true;
            const lines = Array.isArray(bill.zohoLineItems) ? bill.zohoLineItems : [];
            return lines.some((line) => zohoSet.has(clean(line?.zohoBillId)));
        });
    }

    if (!bills.length) {
        return { paidCount: 0, bills: [] };
    }

    const paidBy = await resolvePaidByEmployeeId(userId);
    const zohoPaymentId = clean(
        zohoPayment.payment_id || zohoPayment.vendorpayment_id || zohoPayment.id,
    );
    const result = await persistUtilityBillsAsPaid(bills, {
        paidBy,
        comment: zohoPaymentId ? `Paid via Zoho Payments Made (${zohoPaymentId})` : 'Paid via Zoho',
    });
    console.log(
        `[markUtilityVendorBillsPaidFromZoho] Marked ${result.paidCount} utility bill(s) Paid` +
            (zohoPaymentId ? ` (payment ${zohoPaymentId})` : ''),
    );
    return result;
}

/**
 * For ERP utility bills linked to Zoho: keep Vendor Payment Paid / Not Paid in sync.
 * - Approved + Zoho paid  → Paid
 * - Paid + Zoho not paid → Approved (Not Paid in UI)
 */
export async function syncApprovedUtilityBillsPaidFromZoho({
    entryId = null,
    billIds = null,
    userId = null,
    fetchLive = true,
} = {}) {
    const baseFilter = {
        $or: [
            { zohoBillId: { $nin: [null, ''] } },
            { zohoBillIds: { $exists: true, $ne: [] } },
            { zohoBillNumber: { $nin: [null, ''] } },
            { 'zohoLineItems.zohoBillId': { $nin: [null, ''] } },
        ],
    };
    if (entryId) baseFilter.entryId = String(entryId);
    if (Array.isArray(billIds) && billIds.length) {
        baseFilter._id = {
            $in: billIds
                .map((id) => String(id || '').trim())
                .filter((id) => mongoose.Types.ObjectId.isValid(id))
                .map((id) => new mongoose.Types.ObjectId(id)),
        };
    }

    const candidateQuery = UtilityBillPayment.find({
        ...baseFilter,
        status: { $in: ['Approved', 'Paid'] },
    }).sort({ billMonth: -1, createdAt: -1 });
    const candidates = await (entryId || (Array.isArray(billIds) && billIds.length)
        ? candidateQuery
        : candidateQuery.limit(150));
    if (!candidates.length) return { paidCount: 0, unpaidCount: 0, checked: 0 };

    const paidBy = await resolvePaidByEmployeeId(userId);
    const toMarkPaid = [];
    const toMarkUnpaid = [];
    const cacheByZohoId = new Map();
    const prefetchIds = [
        ...new Set(candidates.flatMap((bill) => collectZohoIdsFromUtilityBill(bill))),
    ];
    if (prefetchIds.length) {
        const cachedRows = await ZohoBill.find({ zohoBillId: { $in: prefetchIds } })
            .select('status balance total zohoBillId organizationId zohoRaw billNumber referenceNumber')
            .lean();
        cachedRows.forEach((row) => {
            const id = clean(row?.zohoBillId);
            if (id) cacheByZohoId.set(id, row);
        });
    }

    let companyOrgIds = [];
    try {
        companyOrgIds = (
            await Company.find({ zohoOrganizationId: { $nin: [null, ''] } })
                .select('zohoOrganizationId')
                .lean()
        )
            .map((c) => clean(c.zohoOrganizationId))
            .filter(Boolean);
    } catch {
        companyOrgIds = [];
    }

    let cachedOrgIds = [];
    try {
        cachedOrgIds = (await ZohoBill.distinct('organizationId'))
            .map((id) => clean(id))
            .filter(Boolean);
    } catch {
        cachedOrgIds = [];
    }

    const orgFallbacks = [
        ...new Set(
            [
                process.env.ZOHO_ORGANIZATION_ID,
                process.env.ZOHO_ORGANIZATION_ID_NNIT,
                process.env.ZOHO_ORGANIZATION_ID_VEGA,
                ...companyOrgIds,
                ...cachedOrgIds,
            ]
                .map((id) => clean(id))
                .filter(Boolean),
        ),
    ];

    async function resolvePreferredOrgForBill(bill, cachedOrgId = '') {
        const fromBill = clean(bill?.zohoOrganizationId);
        if (fromBill) return fromBill;
        const fromCache = clean(cachedOrgId);
        if (fromCache) return fromCache;
        const companyRef = clean(bill?.payByCompanyId);
        if (companyRef) {
            try {
                return clean(await resolveZohoOrganizationIdForCompany(companyRef));
            } catch {
                /* fall through */
            }
        }
        return '';
    }

    async function fetchZohoBillLive(zohoId, preferredOrgId) {
        const preferred = clean(preferredOrgId);
        const orgTries = [...new Set([preferred, ...orgFallbacks].filter(Boolean))];
        const attempts = orgTries.length ? orgTries : [''];
        let lastMissing = null;

        for (const orgId of attempts) {
            if (orgId && zohoOrgRateLimited.has(orgId)) {
                if (orgId === preferred) break;
                continue;
            }
            try {
                const live = await withZohoOrganization(orgId || null, () =>
                    fetchBillById(zohoId),
                );
                if (live) {
                    if (orgId && live && typeof live === 'object' && !live.organization_id) {
                        live.organization_id = orgId;
                    }
                    return live;
                }
            } catch (err) {
                if (isZohoBooksRateLimitError(err)) {
                    if (orgId && !zohoOrgRateLimited.has(orgId)) {
                        zohoOrgRateLimited.add(orgId);
                        console.warn(
                            `[syncApprovedUtilityBillsPaidFromZoho] org ${orgId} hit Zoho's 5,000-call limit; skipping further live bill fetches for this process`,
                        );
                    }
                    // The bill lives in this org. A 404 from another org is not "bill deleted".
                    if (!preferred || orgId === preferred) {
                        const rateErr = new Error(
                            'Zoho organization call limit reached; using cached bill status',
                        );
                        rateErr.rateLimited = true;
                        throw rateErr;
                    }
                    continue;
                }
                if (isZohoBillMissingError(err)) {
                    lastMissing = err;
                    continue;
                }
                lastMissing = lastMissing || err;
            }
        }

        if (preferred && zohoOrgRateLimited.has(preferred)) {
            const rateErr = new Error(
                'Zoho organization call limit reached; using cached bill status',
            );
            rateErr.rateLimited = true;
            throw rateErr;
        }
        if (lastMissing) throw lastMissing;
        return null;
    }

    async function rememberBillOrg(bill, live, preferredOrg) {
        if (clean(bill.zohoOrganizationId)) return;
        const liveOrg = clean(live?.organization_id || live?.organizationId || preferredOrg);
        if (!liveOrg) return;
        bill.zohoOrganizationId = liveOrg;
        try {
            await bill.save();
        } catch {
            /* non-fatal */
        }
    }

    /**
     * paid true/false is trusted for closing a bill only when `live` is true.
     * A failed Zoho fetch must not turn a paid ERP bill back to Not Paid from a stale cache.
     * A cached paid bill can still move Approved → Paid.
     */
    async function readPaidFlag(zohoId, bill) {
        const id = clean(zohoId);
        if (!id) return { paid: null, live: false };

        const cached = cacheByZohoId.get(id) || null;

        if (fetchLive) {
            try {
                const preferredOrg = await resolvePreferredOrgForBill(
                    bill,
                    cached?.organizationId,
                );
                const live = await fetchZohoBillLive(id, preferredOrg);
                if (live && zohoBillHasPaymentSignal(live)) {
                    try {
                        await upsertZohoBillFromApi(live);
                    } catch {
                        /* cache update optional */
                    }
                    await rememberBillOrg(bill, live, preferredOrg);
                    return { paid: isZohoBillFullyPaid(live), live: true };
                }
            } catch (err) {
                if (!err?.rateLimited) {
                    console.warn(
                        `[syncApprovedUtilityBillsPaidFromZoho] fetch ${id} failed:`,
                        err?.message || err,
                    );
                }
            }
        }

        if (cached && isZohoBillFullyPaid(cached)) return { paid: true, live: false };
        return { paid: null, live: false };
    }

    async function confirmPaidByDisplayedNumber(number, bill) {
        const wanted = clean(number);
        if (!wanted) return false;
        const preferred = await resolvePreferredOrgForBill(bill, '');
        const orgs = [...new Set([preferred, ...orgFallbacks].filter(Boolean))].slice(0, 3);
        const attempts = orgs.length ? orgs : [''];

        for (const orgId of attempts) {
            if (orgId && zohoOrgRateLimited.has(orgId)) continue;
            let rows = [];
            try {
                rows = await withZohoOrganization(orgId || null, async () => {
                    const [byNumber, byText] = await Promise.all([
                        searchZohoBillsByNumber(wanted),
                        searchZohoBillsByText(wanted),
                    ]);
                    return [...byNumber, ...byText];
                });
            } catch (err) {
                if (isZohoBooksRateLimitError(err) && orgId) zohoOrgRateLimited.add(orgId);
                continue;
            }

            const seen = new Set();
            let detailFetches = 0;
            for (const row of rows) {
                const id = clean(row?.bill_id || row?.id);
                if (id && seen.has(id)) continue;
                if (id) seen.add(id);
                let full = row;
                if (id && !zohoBillMatchesDisplayedNumber(row, wanted)) {
                    if (detailFetches >= 4) continue;
                    detailFetches += 1;
                    try {
                        full =
                            (await withZohoOrganization(orgId || null, () => fetchBillById(id))) ||
                            row;
                    } catch {
                        full = row;
                    }
                }
                if (!zohoBillMatchesDisplayedNumber(full, wanted)) continue;
                if (!isZohoBillFullyPaid(full)) continue;
                try {
                    await upsertZohoBillFromApi(full);
                } catch {
                    /* cache update optional */
                }
                return true;
            }
        }
        return false;
    }

    for (const bill of candidates) {
        const zohoIds = collectZohoIdsFromUtilityBill(bill);
        const primaryId = clean(bill.zohoBillId) || zohoIds[0] || '';
        const serial = clean(bill.zohoBillNumber);
        const checks = [];

        if (primaryId) checks.push(await readPaidFlag(primaryId, bill));

        if (!checks.some((row) => row.paid === true) && serial) {
            const bySerial = await ZohoBill.findOne({
                $or: [{ billNumber: serial }, { referenceNumber: serial }],
            })
                .select('status balance total zohoBillId organizationId zohoRaw billNumber referenceNumber')
                .lean();
            const serialId = clean(bySerial?.zohoBillId);
            if (serialId && serialId !== primaryId) {
                if (!cacheByZohoId.has(serialId) && bySerial) cacheByZohoId.set(serialId, bySerial);
                checks.push(await readPaidFlag(serialId, bill));
            } else if (bySerial && isZohoBillFullyPaid(bySerial)) {
                checks.push({ paid: true, live: false });
            }
        }

        if (fetchLive && !checks.some((row) => row.paid === true) && serial) {
            if (await confirmPaidByDisplayedNumber(serial, bill)) {
                checks.push({ paid: true, live: true });
            }
        }

        for (const zohoId of zohoIds) {
            if (zohoId === primaryId) continue;
            if (checks.some((row) => row.paid === true)) break;
            checks.push(await readPaidFlag(zohoId, bill));
        }

        const anyPaid = checks.some((row) => row.paid === true);
        const anyUnknown = checks.length === 0 || checks.some((row) => row.paid == null);
        const anyLiveUnpaid = checks.some((row) => row.live && row.paid === false);
        if (!anyPaid && anyUnknown) continue;

        const erpStatus = String(bill.status || '').trim();
        if (anyPaid && erpStatus === 'Approved') {
            toMarkPaid.push(bill);
        } else if (!anyPaid && anyLiveUnpaid && !anyUnknown && erpStatus === 'Paid') {
            toMarkUnpaid.push(bill);
        }
    }

    let unpaidCount = 0;
    if (toMarkUnpaid.length) {
        for (const bill of toMarkUnpaid) {
            bill.status = 'Approved';
            bill.paidAt = null;
            bill.paidBy = null;
            bill.comment = clean(bill.comment)
                ? `${clean(bill.comment)} · Reopened — Zoho bill not paid`
                : 'Reopened — Zoho bill not paid';
            await bill.save();
            unpaidCount += 1;
        }
        console.log(
            `[syncApprovedUtilityBillsPaidFromZoho] Synced ${unpaidCount} Paid → Approved (Not Paid)`,
        );
    }

    if (!toMarkPaid.length) {
        return { paidCount: 0, unpaidCount, checked: candidates.length };
    }

    const result = await persistUtilityBillsAsPaid(toMarkPaid, {
        paidBy,
        comment: 'Paid in Zoho (synced to ERP)',
    });
    console.log(
        `[syncApprovedUtilityBillsPaidFromZoho] Synced ${result.paidCount}/${candidates.length} Approved → Paid`,
    );
    return { ...result, unpaidCount, checked: candidates.length };
}
