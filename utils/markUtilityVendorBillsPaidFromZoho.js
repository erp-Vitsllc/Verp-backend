import mongoose from 'mongoose';
import UtilityBillPayment from '../models/UtilityBillPayment.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import DashboardAction from '../models/DashboardAction.js';

const UTILITY_REQUEST_TYPE = 'Utility Bill Payment';

const clean = (value, fallback = '') => {
    const text = String(value ?? '').trim();
    return text || fallback;
};

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

    // Prefill with batch + mode bills, but no explicit ids — mark Approved bills in batch
    // that have a Zoho bill id matching applied payment bills (or all Approved if only batch).
    if (!or.length && batchId && mongoose.Types.ObjectId.isValid(batchId) && mode === 'bills') {
        or.push({ batchId: new mongoose.Types.ObjectId(batchId) });
    }

    if (!or.length) {
        return { paidCount: 0, bills: [] };
    }

    const filter = {
        status: 'Approved',
        $or: or,
    };

    let bills = await UtilityBillPayment.find(filter);
    if (!bills.length) {
        return { paidCount: 0, bills: [] };
    }

    // When matching by Zoho ids, keep only bills that actually intersect applied Zoho bills.
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

    let paidBy = null;
    if (userId && mongoose.Types.ObjectId.isValid(String(userId))) {
        const userEmp = await EmployeeBasic.findOne({
            $or: [{ _id: userId }, { userId }],
        })
            .select('_id')
            .lean();
        paidBy = userEmp?._id || null;
        if (!paidBy) {
            try {
                paidBy = new mongoose.Types.ObjectId(String(userId));
            } catch {
                paidBy = null;
            }
        }
    }

    const zohoPaymentId = clean(
        zohoPayment.payment_id || zohoPayment.vendorpayment_id || zohoPayment.id,
    );
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
        await bill.save();
        if (bill.batchId) batchIds.add(String(bill.batchId));
    }

    // Clear / refresh Accounts dashboard rows for affected batches.
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
                        comment: 'Paid via Zoho Payments Made',
                    },
                );
            }
        }
    } catch (dashErr) {
        console.warn(
            '[markUtilityVendorBillsPaidFromZoho] dashboard sync failed:',
            dashErr?.message || dashErr,
        );
    }

    console.log(
        `[markUtilityVendorBillsPaidFromZoho] Marked ${bills.length} utility bill(s) Paid` +
            (zohoPaymentId ? ` (payment ${zohoPaymentId})` : ''),
    );

    return {
        paidCount: bills.length,
        bills: bills.map((b) => b.toObject()),
    };
}
