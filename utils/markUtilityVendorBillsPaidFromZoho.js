import mongoose from 'mongoose';
import UtilityBillPayment from '../models/UtilityBillPayment.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import DashboardAction from '../models/DashboardAction.js';
import ZohoBill from '../models/ZohoBill.js';
import { fetchBillById } from '../services/zohoService.js';
import { upsertZohoBillFromApi } from '../services/zohoPurchaseSyncService.js';
import { withZohoOrganization } from './zohoOrgContext.js';
import { resolveZohoOrganizationIdForCompany } from './resolveZohoOrganization.js';
import Company from '../models/Company.js';
import { clearUtilityBillPaymentDayDueReminder } from './processUtilityBillPaymentDayReminders.js';

const UTILITY_REQUEST_TYPE = 'Utility Bill Payment';

const clean = (value, fallback = '') => {
    const text = String(value ?? '').trim();
    return text || fallback;
};

/** Zoho bill is fully paid (balance cleared). Avoid matching "unpaid". */
export function isZohoBillFullyPaid(zohoBill) {
    if (!zohoBill || typeof zohoBill !== 'object') return false;
    const status = clean(zohoBill.status || zohoBill.status_formatted).toLowerCase();
    if (status === 'paid') return true;
    if (status === 'void' || status === 'draft' || status === 'partially_paid') return false;
    const balance = Number(
        zohoBill.balance ?? zohoBill.balance_due ?? zohoBill.balanceDue ?? NaN,
    );
    if (Number.isFinite(balance) && Math.abs(balance) < 0.01) {
        const total = Number(zohoBill.total ?? zohoBill.total_amount ?? zohoBill.amount ?? 0);
        if (status === 'open' || status === 'overdue' || status === 'unpaid') {
            return total > 0;
        }
        return true;
    }
    return false;
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
        await bill.save();
        if (bill.batchId) batchIds.add(String(bill.batchId));
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

    try {
        const clearedKeys = new Set();
        for (const bill of bills) {
            const entryId = String(bill.entryId || '').trim();
            const billMonth = String(bill.billMonth || '').trim();
            if (!entryId || !billMonth) continue;
            const key = `${entryId}:${billMonth}`;
            if (clearedKeys.has(key)) continue;
            clearedKeys.add(key);
            await clearUtilityBillPaymentDayDueReminder({
                entryId,
                billMonth,
                actionedBy: paidBy || null,
                comment: comment || 'Bill paid via Zoho — payment-day reminder cleared',
            });
        }
    } catch (remindErr) {
        console.warn(
            '[persistUtilityBillsAsPaid] due reminder clear failed:',
            remindErr?.message || remindErr,
        );
    }

    return {
        paidCount: bills.length,
        bills: bills.map((b) => (typeof b.toObject === 'function' ? b.toObject() : b)),
    };
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

    const candidates = await UtilityBillPayment.find({
        ...baseFilter,
        status: { $in: ['Approved', 'Paid'] },
    }).limit(150);
    if (!candidates.length) return { paidCount: 0, unpaidCount: 0, checked: 0 };

    const paidBy = await resolvePaidByEmployeeId(userId);
    const toMarkPaid = [];
    const toMarkUnpaid = [];

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
        const orgTries = [
            ...new Set([clean(preferredOrgId), ...orgFallbacks].filter(Boolean)),
        ];
        const attempts = orgTries.length ? orgTries : [''];
        let lastErr = null;
        for (const orgId of attempts) {
            try {
                const live = await withZohoOrganization(orgId || null, () =>
                    fetchBillById(zohoId),
                );
                if (live) {
                    // Remember which org worked for later updates.
                    if (orgId && live && typeof live === 'object' && !live.organization_id) {
                        live.organization_id = orgId;
                    }
                    return live;
                }
            } catch (err) {
                lastErr = err;
            }
        }
        if (lastErr) throw lastErr;
        return null;
    }

    for (const bill of candidates) {
        const zohoIds = collectZohoIdsFromUtilityBill(bill);
        if (!zohoIds.length) continue;

        let allPaid = true;
        let sawAny = false;

        for (const zohoId of zohoIds) {
            const cached = await ZohoBill.findOne({ zohoBillId: zohoId })
                .select('status balance total zohoBillId organizationId')
                .lean();

            if (fetchLive) {
                try {
                    const preferredOrg = await resolvePreferredOrgForBill(
                        bill,
                        cached?.organizationId,
                    );
                    const live = await fetchZohoBillLive(zohoId, preferredOrg);
                    if (live) {
                        sawAny = true;
                        try {
                            await upsertZohoBillFromApi(live);
                        } catch {
                            /* cache update optional */
                        }
                        // Persist working org on ERP bill when missing.
                        if (!clean(bill.zohoOrganizationId)) {
                            const liveOrg = clean(
                                live.organization_id || live.organizationId || preferredOrg,
                            );
                            if (liveOrg) {
                                bill.zohoOrganizationId = liveOrg;
                                try {
                                    await bill.save();
                                } catch {
                                    /* non-fatal */
                                }
                            }
                        }
                        if (!isZohoBillFullyPaid(live)) {
                            allPaid = false;
                            break;
                        }
                        continue;
                    }
                } catch (err) {
                    console.warn(
                        `[syncApprovedUtilityBillsPaidFromZoho] fetch ${zohoId} failed:`,
                        err?.message || err,
                    );
                }
            }

            if (cached) {
                sawAny = true;
                if (!isZohoBillFullyPaid(cached)) {
                    allPaid = false;
                    break;
                }
            } else {
                // Unknown Zoho state (no live + no cache) — do not flip this bill.
                allPaid = false;
                sawAny = false;
                break;
            }
        }

        if (!sawAny) continue;

        const erpStatus = String(bill.status || '').trim();
        if (allPaid && erpStatus === 'Approved') {
            toMarkPaid.push(bill);
        } else if (!allPaid && erpStatus === 'Paid') {
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
