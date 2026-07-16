import UtilityEntry from '../models/UtilityEntry.js';
import UtilityBillPayment from '../models/UtilityBillPayment.js';
import UtilityBillPaymentDay from '../models/UtilityBillPaymentDay.js';
import UtilityBillPaymentDayReminderLog from '../models/UtilityBillPaymentDayReminderLog.js';
import UtilityEntryStatusChange from '../models/UtilityEntryStatusChange.js';
import DashboardAction from '../models/DashboardAction.js';
import { isJwtSystemSuperUser } from './systemSuperUser.js';

const BILL_REQUEST_TYPE = 'Utility Bill Payment';
const STATUS_CHANGE_REQUEST_TYPE = 'Utility Entry Status Change';

export function isUtilityAdminSuperUser(req) {
    if (isJwtSystemSuperUser(req?.user)) return true;
    const role = String(req?.user?.role || req?.user?.userType || '').toLowerCase();
    return (
        role.includes('admin') ||
        role.includes('super') ||
        req?.user?.isAdmin === true ||
        req?.user?.isAdmin === 'true' ||
        req?.user?.isAdministrator === true
    );
}

async function clearBillBatchDashboard(batchIds = []) {
    const ids = [...new Set((batchIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) return;
    await DashboardAction.updateMany(
        { requestType: BILL_REQUEST_TYPE, requestId: { $in: ids }, status: 'Pending' },
        {
            status: 'Approved',
            actionedDate: new Date(),
            comment: 'Deleted by admin',
        },
    );
}

async function clearStatusChangeDashboard(statusChangeIds = []) {
    const ids = [...new Set((statusChangeIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) return;
    await DashboardAction.updateMany(
        {
            requestType: STATUS_CHANGE_REQUEST_TYPE,
            requestId: { $in: ids },
            status: 'Pending',
        },
        {
            status: 'Approved',
            actionedDate: new Date(),
            comment: 'Deleted by admin',
        },
    );
}

/** Delete one bill payment and clear inbox if its batch is empty / no longer pending. */
export async function cascadeDeleteUtilityBill(billId) {
    const id = String(billId || '').trim();
    if (!id) return { ok: false, message: 'Bill id is required.' };

    const bill = await UtilityBillPayment.findById(id);
    if (!bill) return { ok: false, message: 'Bill not found.' };

    const batchId = bill.batchId ? String(bill.batchId) : '';
    await UtilityBillPayment.deleteOne({ _id: bill._id });

    if (batchId) {
        const remainingPending = await UtilityBillPayment.countDocuments({
            batchId,
            status: { $in: ['Pending Accounts', 'Pending HR'] },
        });
        if (remainingPending === 0) {
            await clearBillBatchDashboard([batchId]);
        }
    }

    return { ok: true, billId: id, entryId: bill.entryId, batchId };
}

/** Delete a utility entry and all related bills / days / status changes / reminders. */
export async function cascadeDeleteUtilityEntry(entryId) {
    const id = String(entryId || '').trim();
    if (!id) return { ok: false, message: 'Entry id is required.' };

    const entry = await UtilityEntry.findById(id);
    if (!entry) return { ok: false, message: 'Entry not found.' };

    const bills = await UtilityBillPayment.find({ entryId: id }).select('_id batchId').lean();
    const batchIds = bills.map((b) => b.batchId).filter(Boolean);
    const statusChanges = await UtilityEntryStatusChange.find({ entryId: id }).select('_id').lean();

    await Promise.all([
        UtilityBillPayment.deleteMany({ entryId: id }),
        UtilityBillPaymentDay.deleteMany({ entryId: id }),
        UtilityBillPaymentDayReminderLog.deleteMany({ entryId: id }),
        UtilityEntryStatusChange.deleteMany({ entryId: id }),
        UtilityEntry.deleteOne({ _id: entry._id }),
        clearBillBatchDashboard(batchIds),
        clearStatusChangeDashboard(statusChanges.map((s) => s._id)),
    ]);

    return {
        ok: true,
        entryId: id,
        type: entry.type || '',
        deletedBills: bills.length,
    };
}

/** Delete every entry (and related data) for a utility type name. */
export async function cascadeDeleteEntriesByType(typeName) {
    const type = String(typeName || '').trim();
    if (!type) return { ok: true, deletedEntries: 0 };

    const entries = await UtilityEntry.find({
        type: new RegExp(`^${type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    })
        .select('_id')
        .lean();

    let deletedEntries = 0;
    for (const row of entries) {
        const result = await cascadeDeleteUtilityEntry(row._id);
        if (result.ok) deletedEntries += 1;
    }
    return { ok: true, deletedEntries };
}
