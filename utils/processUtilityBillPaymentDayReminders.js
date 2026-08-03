import crypto from 'crypto';
import mongoose from 'mongoose';
import UtilityBillPayment from '../models/UtilityBillPayment.js';
import UtilityBillPaymentDay from '../models/UtilityBillPaymentDay.js';
import UtilityBillPaymentDayReminderLog from '../models/UtilityBillPaymentDayReminderLog.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendUtilityBillPaymentDayEmail } from './sendUtilityBillPaymentDayEmail.js';

const REQUEST_TYPE = 'Utility Bill Payment Reminder';
/** Advance notice stages (still go to HR). */
const ADVANCE_STAGES = [10, 5];
/** Overdue / due-today stage key stored on reminder log. */
const DUE_STAGE = 0;

function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

function yearMonthKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

/** DashboardAction.requestId is ObjectId — stable id from reminder key. */
function requestObjectId(key) {
    const hex = crypto.createHash('md5').update(String(key)).digest('hex').slice(0, 24);
    return new mongoose.Types.ObjectId(hex);
}

/** Clamp payment day to last day of month. */
export function dueDateForPaymentDay(paymentDay, refDate = new Date()) {
    const y = refDate.getFullYear();
    const m = refDate.getMonth();
    const last = new Date(y, m + 1, 0).getDate();
    const day = Math.min(Math.max(1, Number(paymentDay) || 1), last);
    return startOfDay(new Date(y, m, day));
}

/**
 * Days until next upcoming due (this month if still upcoming/today, else next month).
 * Used for T-10 / T-5 advance reminders.
 */
export function daysUntilPaymentDay(paymentDay, today = new Date()) {
    const t = startOfDay(today);
    let due = dueDateForPaymentDay(paymentDay, t);
    if (due < t) {
        const nextMonthRef = new Date(t.getFullYear(), t.getMonth() + 1, 1);
        due = dueDateForPaymentDay(paymentDay, nextMonthRef);
    }
    return {
        daysUntil: Math.round((due - t) / (1000 * 60 * 60 * 24)),
        dueDate: due,
        yearMonth: yearMonthKey(due),
    };
}

/** This calendar month’s payment due (never rolls forward). */
export function currentMonthPaymentDue(paymentDay, today = new Date()) {
    const t = startOfDay(today);
    const dueDate = dueDateForPaymentDay(paymentDay, t);
    return {
        daysUntil: Math.round((dueDate - t) / (1000 * 60 * 60 * 24)),
        dueDate,
        yearMonth: yearMonthKey(dueDate),
        isDueOrPast: dueDate.getTime() <= t.getTime(),
    };
}

function dueReminderKey(entryId, yearMonth) {
    return `${String(entryId)}:${String(yearMonth)}:due`;
}

export function dueReminderRequestId(entryId, yearMonth) {
    return requestObjectId(dueReminderKey(entryId, yearMonth));
}

function advanceReminderRequestId(entryId, yearMonth, daysBefore) {
    return requestObjectId(`${String(entryId)}:${String(yearMonth)}:${daysBefore}`);
}

async function wasSent(entryId, yearMonth, daysBefore) {
    const hit = await UtilityBillPaymentDayReminderLog.findOne({
        entryId: String(entryId),
        yearMonth,
        daysBefore,
    })
        .select('_id')
        .lean();
    return Boolean(hit);
}

async function markSent(entryId, yearMonth, daysBefore, dueDate) {
    try {
        await UtilityBillPaymentDayReminderLog.create({
            entryId: String(entryId),
            yearMonth,
            daysBefore,
            dueDate,
        });
    } catch (err) {
        if (err?.code !== 11000) throw err;
    }
}

/** Bill for this entry + month is fully done (Paid). */
export async function isUtilityBillMonthPaid(entryId, yearMonth) {
    const id = String(entryId || '').trim();
    const month = String(yearMonth || '').trim();
    if (!id || !month) return false;
    const paid = await UtilityBillPayment.findOne({
        entryId: id,
        billMonth: month,
        status: 'Paid',
    })
        .select('_id')
        .lean();
    return Boolean(paid);
}

async function createHrAdvanceBell({ record, daysBefore, dueDate, hr }) {
    if (!hr?._id) return;
    const dueLabel = dueDate.toLocaleDateString('en-GB');
    const stageLabel = `due in ${daysBefore} day${daysBefore === 1 ? '' : 's'}`;
    const requestId = advanceReminderRequestId(record.entryId, yearMonthKey(dueDate), daysBefore);

    await DashboardAction.findOneAndUpdate(
        { requestId, requestType: REQUEST_TYPE },
        {
            requestId,
            requestType: REQUEST_TYPE,
            assignedTo: hr._id,
            status: 'Pending',
            subjectEmployee: hr._id,
            subjectName: `${hr.firstName || ''} ${hr.lastName || ''}`.trim() || 'HR',
            requestedByName: 'System',
            extra1: `${record.utilityType || 'Utility'} · Day ${record.paymentDay}`,
            extra2: `Payment ${stageLabel} (${dueLabel})`,
            extra3: JSON.stringify({
                entryId: record.entryId,
                paymentDay: record.paymentDay,
                daysBefore,
                yearMonth: yearMonthKey(dueDate),
                stage: 'advance',
                detailsPath: `/HRM/Asset/UtilityBills/details/${encodeURIComponent(String(record.entryId))}`,
            }),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}

async function upsertAccountsDueBell({ record, dueDate, accounts, overdueDays }) {
    if (!accounts?._id) return;
    const dueLabel = dueDate.toLocaleDateString('en-GB');
    const yearMonth = yearMonthKey(dueDate);
    const requestId = dueReminderRequestId(record.entryId, yearMonth);
    const stageLabel =
        overdueDays <= 0
            ? overdueDays === 0
                ? 'due today'
                : `overdue by ${Math.abs(overdueDays)} day${Math.abs(overdueDays) === 1 ? '' : 's'}`
            : 'due today';

    await DashboardAction.findOneAndUpdate(
        { requestId, requestType: REQUEST_TYPE },
        {
            requestId,
            requestType: REQUEST_TYPE,
            assignedTo: accounts._id,
            status: 'Pending',
            subjectEmployee: accounts._id,
            subjectName:
                `${accounts.firstName || ''} ${accounts.lastName || ''}`.trim() || 'Accounts',
            requestedByName: 'System',
            actionedDate: null,
            comment: '',
            extra1: `${record.utilityType || 'Utility'} · Day ${record.paymentDay}`,
            extra2: `Payment ${stageLabel} (${dueLabel}) — complete bill to clear`,
            extra3: JSON.stringify({
                entryId: record.entryId,
                paymentDay: record.paymentDay,
                daysBefore: DUE_STAGE,
                yearMonth,
                stage: 'due_or_past',
                detailsPath: `/HRM/Asset/UtilityBills/details/${encodeURIComponent(String(record.entryId))}`,
            }),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}

/**
 * Clear Accounts due/overdue reminder once the month’s bill is Paid.
 */
export async function clearUtilityBillPaymentDayDueReminder({
    entryId,
    billMonth,
    actionedBy = null,
    comment = 'Bill paid — reminder cleared',
} = {}) {
    const id = String(entryId || '').trim();
    const month = String(billMonth || '').trim();
    if (!id || !month) return { ok: false };

    const requestId = dueReminderRequestId(id, month);
    const result = await DashboardAction.updateMany(
        { requestId, requestType: REQUEST_TYPE, status: 'Pending' },
        {
            status: 'Approved',
            actionedDate: new Date(),
            ...(actionedBy ? { actionedBy } : {}),
            comment,
        },
    );
    return { ok: true, modified: result?.modifiedCount || 0 };
}

/**
 * Daily scan:
 * - T-10 / T-5 → HR email + bell (advance)
 * - Payment day today or past (this month) → Accounts email + bell until that month’s bill is Paid
 */
export async function processUtilityBillPaymentDayReminders() {
    try {
        const records = await UtilityBillPaymentDay.find({ status: 'Active' }).lean();
        if (!records.length) return;

        const [hr, accounts] = await Promise.all([
            getDepartmentHOD('hr'),
            getDepartmentHOD('accounts'),
        ]);
        if (!hr?._id) {
            console.warn('[UtilityBillPaymentDayReminders] HR HOD not found.');
        }
        if (!accounts?._id) {
            console.warn('[UtilityBillPaymentDayReminders] Accounts HOD not found.');
        }

        for (const record of records) {
            // --- Advance reminders (HR) ---
            const upcoming = daysUntilPaymentDay(record.paymentDay);
            if (ADVANCE_STAGES.includes(upcoming.daysUntil)) {
                const already = await wasSent(record.entryId, upcoming.yearMonth, upcoming.daysUntil);
                if (!already) {
                    const dueDateLabel = upcoming.dueDate.toLocaleDateString('en-GB');
                    const kind = upcoming.daysUntil === 10 ? 't10' : 't5';
                    if (hr) {
                        await sendUtilityBillPaymentDayEmail({
                            recipient: hr,
                            record,
                            kind,
                            dueDateLabel,
                        });
                        await createHrAdvanceBell({
                            record,
                            daysBefore: upcoming.daysUntil,
                            dueDate: upcoming.dueDate,
                            hr,
                        });
                    }
                    await markSent(
                        record.entryId,
                        upcoming.yearMonth,
                        upcoming.daysUntil,
                        upcoming.dueDate,
                    );
                    console.log(
                        `[UtilityBillPaymentDayReminders] ${kind} sent for entry ${record.entryId}`,
                    );
                }
            }

            // --- Due today / past (Accounts) — stays until bill Paid ---
            const current = currentMonthPaymentDue(record.paymentDay);
            if (!current.isDueOrPast) continue;

            const paid = await isUtilityBillMonthPaid(record.entryId, current.yearMonth);
            if (paid) {
                await clearUtilityBillPaymentDayDueReminder({
                    entryId: record.entryId,
                    billMonth: current.yearMonth,
                    comment: 'Bill already paid — reminder cleared',
                });
                continue;
            }

            if (!accounts?._id) continue;

            await upsertAccountsDueBell({
                record,
                dueDate: current.dueDate,
                accounts,
                overdueDays: current.daysUntil,
            });

            const alreadyDue = await wasSent(record.entryId, current.yearMonth, DUE_STAGE);
            if (!alreadyDue) {
                const dueDateLabel = current.dueDate.toLocaleDateString('en-GB');
                const kind = current.daysUntil < 0 ? 'overdue' : 'due';
                await sendUtilityBillPaymentDayEmail({
                    recipient: accounts,
                    record,
                    kind,
                    dueDateLabel,
                });
                await markSent(record.entryId, current.yearMonth, DUE_STAGE, current.dueDate);
                console.log(
                    `[UtilityBillPaymentDayReminders] ${kind} → Accounts for entry ${record.entryId} (${current.yearMonth})`,
                );
            }
        }
    } catch (err) {
        console.error('[processUtilityBillPaymentDayReminders] Non-fatal error:', err?.message || err);
    }
}
