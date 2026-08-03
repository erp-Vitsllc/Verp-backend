import UtilityEntry from '../models/UtilityEntry.js';
import UtilityBillPayment from '../models/UtilityBillPayment.js';
import UtilityBillPaymentDay from '../models/UtilityBillPaymentDay.js';
import UtilityBillPaymentDayReminderLog from '../models/UtilityBillPaymentDayReminderLog.js';
import UtilityEntryStatusChange from '../models/UtilityEntryStatusChange.js';
import UtilityConfig from '../models/UtilityConfig.js';
import DashboardAction from '../models/DashboardAction.js';
import { isJwtSystemSuperUser } from './systemSuperUser.js';
import { awaitAdminDeletionArchive } from './adminDeletionArchiveRun.js';
import { clearUtilityContractExpiryNotifications } from './processUtilityContractExpiryReminders.js';

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

function plain(doc) {
    if (!doc) return null;
    if (typeof doc.toObject === 'function') return doc.toObject();
    return { ...doc };
}

/** Full snapshot for one utility account (entry + related rows). */
export async function buildUtilityEntryDeletionSnapshot(entryId) {
    const id = String(entryId || '').trim();
    if (!id) return null;

    const entry = await UtilityEntry.findById(id).lean();
    if (!entry) return null;

    const [bills, paymentDays, statusChanges, reminderLogs] = await Promise.all([
        UtilityBillPayment.find({ entryId: id }).lean(),
        UtilityBillPaymentDay.find({ entryId: id }).lean(),
        UtilityEntryStatusChange.find({ entryId: id }).lean(),
        UtilityBillPaymentDayReminderLog.find({ entryId: id }).lean(),
    ]);

    const accountNo =
        entry?.values?.accountNo ||
        bills.find((b) => b.accountNo)?.accountNo ||
        '';
    const provider = entry?.values?.provider || '';

    return {
        entry,
        bills,
        paymentDays,
        statusChanges,
        reminderLogs,
        entryId: id,
        utilityType: entry.type || '',
        accountNo,
        provider,
        name: [entry.type, accountNo || provider || id].filter(Boolean).join(' — '),
    };
}

/** Delete one bill payment and clear inbox if its batch is empty / no longer pending. */
export async function cascadeDeleteUtilityBill(billId, { req, skipArchive = false } = {}) {
    const id = String(billId || '').trim();
    if (!id) return { ok: false, message: 'Bill id is required.' };

    const bill = await UtilityBillPayment.findById(id);
    if (!bill) return { ok: false, message: 'Bill not found.' };

    const billSnapshot = plain(bill);
    if (req && !skipArchive) {
        await awaitAdminDeletionArchive(req, {
            moduleName: 'Utility Bill',
            recordId: id,
            details:
                `${bill.utilityType || 'Utility'} bill` +
                (bill.billMonth ? ` (${bill.billMonth})` : '') +
                (bill.accountNo ? ` — ${bill.accountNo}` : ''),
            deletedPayload: {
                ...billSnapshot,
                entryId: bill.entryId,
                utilityType: bill.utilityType,
                accountNo: bill.accountNo,
                name: bill.accountNo || bill.utilityType || id,
            },
        });
    }

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
export async function cascadeDeleteUtilityEntry(entryId, { req, skipArchive = false } = {}) {
    const id = String(entryId || '').trim();
    if (!id) return { ok: false, message: 'Entry id is required.' };

    const entry = await UtilityEntry.findById(id);
    if (!entry) return { ok: false, message: 'Entry not found.' };

    const snapshot = await buildUtilityEntryDeletionSnapshot(id);
    if (req && !skipArchive && snapshot) {
        await awaitAdminDeletionArchive(req, {
            moduleName: 'Utility Entry',
            recordId: id,
            details: snapshot.name || `${entry.type} utility account`,
            deletedPayload: snapshot,
        });
    }

    const bills = snapshot?.bills || (await UtilityBillPayment.find({ entryId: id }).select('_id batchId').lean());
    const batchIds = bills.map((b) => b.batchId).filter(Boolean);
    const statusChanges =
        snapshot?.statusChanges ||
        (await UtilityEntryStatusChange.find({ entryId: id }).select('_id').lean());

    await Promise.all([
        UtilityBillPayment.deleteMany({ entryId: id }),
        UtilityBillPaymentDay.deleteMany({ entryId: id }),
        UtilityBillPaymentDayReminderLog.deleteMany({ entryId: id }),
        UtilityEntryStatusChange.deleteMany({ entryId: id }),
        UtilityEntry.deleteOne({ _id: entry._id }),
        clearBillBatchDashboard(batchIds),
        clearStatusChangeDashboard(statusChanges.map((s) => s._id)),
        clearUtilityContractExpiryNotifications(id, 'Utility account deleted'),
    ]);

    return {
        ok: true,
        entryId: id,
        type: entry.type || '',
        deletedBills: bills.length,
    };
}

/** Delete every entry (and related data) for a utility type name. */
export async function cascadeDeleteEntriesByType(typeName, { req, skipArchive = false } = {}) {
    const type = String(typeName || '').trim();
    if (!type) return { ok: true, deletedEntries: 0, entrySnapshots: [] };

    const entries = await UtilityEntry.find({
        type: new RegExp(`^${type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    })
        .select('_id')
        .lean();

    const entrySnapshots = [];
    let deletedEntries = 0;
    for (const row of entries) {
        if (!skipArchive && req) {
            const snap = await buildUtilityEntryDeletionSnapshot(row._id);
            if (snap) entrySnapshots.push(snap);
        }
        const result = await cascadeDeleteUtilityEntry(row._id, { req, skipArchive: true });
        if (result.ok) deletedEntries += 1;
    }
    return { ok: true, deletedEntries, entrySnapshots };
}

/**
 * Delete a utility type tab (config). Archives config + all related entries in one recovery row
 * (and emails Management once), then removes live data.
 */
export async function cascadeDeleteUtilityConfig(configId, { req } = {}) {
    const id = String(configId || '').trim();
    if (!id) return { ok: false, message: 'Utility id is required.' };

    const doc = await UtilityConfig.findById(id);
    if (!doc) return { ok: false, message: 'Utility not found.' };

    const type = doc.type || '';
    const { entrySnapshots, deletedEntries } = await (async () => {
        const entries = await UtilityEntry.find({
            type: new RegExp(`^${type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
        })
            .select('_id')
            .lean();
        const snaps = [];
        for (const row of entries) {
            const snap = await buildUtilityEntryDeletionSnapshot(row._id);
            if (snap) snaps.push(snap);
        }
        return { entrySnapshots: snaps, deletedEntries: entries.length };
    })();

    if (req) {
        await awaitAdminDeletionArchive(req, {
            moduleName: 'Utility Config',
            recordId: id,
            details: `Utility type “${type}”` + (deletedEntries ? ` (+ ${deletedEntries} account(s))` : ''),
            deletedPayload: {
                config: plain(doc),
                entries: entrySnapshots,
                utilityType: type,
                name: type,
            },
        });
    }

    await cascadeDeleteEntriesByType(type, { req, skipArchive: true });
    await UtilityConfig.deleteOne({ _id: doc._id });

    return { ok: true, deletedEntries, type };
}
