import crypto from 'crypto';
import mongoose from 'mongoose';
import UtilityBillPaymentDay from '../models/UtilityBillPaymentDay.js';
import UtilityBillPaymentDayReminderLog from '../models/UtilityBillPaymentDayReminderLog.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendUtilityBillPaymentDayEmail } from './sendUtilityBillPaymentDayEmail.js';

const REQUEST_TYPE = 'Utility Bill Payment Reminder';
/** Only fire when payable date == today (no T-10 / T-5 advance emails). */
const DUE_TODAY_STAGE = 0;

/** DashboardAction.requestId is ObjectId — derive a stable id from the reminder key. */
function requestObjectId(key) {
    const hex = crypto.createHash('md5').update(String(key)).digest('hex').slice(0, 24);
    return new mongoose.Types.ObjectId(hex);
}

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

export function utilityBillPaymentDayRequestId(entryId, yearMonth, daysBefore = DUE_TODAY_STAGE) {
    return requestObjectId(
        `utility-bill-payment-day:${String(entryId || '').trim()}:${yearMonth}:${daysBefore}`,
    );
}

/** Clamp payment day to last day of month. */
export function dueDateForPaymentDay(paymentDay, refDate = new Date()) {
    const y = refDate.getFullYear();
    const m = refDate.getMonth();
    const last = new Date(y, m + 1, 0).getDate();
    const day = Math.min(Math.max(1, Number(paymentDay) || 1), last);
    return startOfDay(new Date(y, m, day));
}

/** Days until next due (this month if still upcoming/today, else next month). */
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

async function createHrBell({ record, dueDate, hr, yearMonth }) {
    if (!hr?._id) return;
    const dueLabel = dueDate.toLocaleDateString('en-GB');
    const requestId = utilityBillPaymentDayRequestId(
        record.entryId,
        yearMonth || yearMonthKey(dueDate),
        DUE_TODAY_STAGE,
    );

    await DashboardAction.findOneAndUpdate(
        { requestId, requestType: REQUEST_TYPE },
        {
            requestId,
            requestType: REQUEST_TYPE,
            assignedTo: hr._id,
            assignedToEmpId: hr.employeeId || undefined,
            status: 'Pending',
            subjectEmployeeId: hr.employeeId || undefined,
            subjectName: `${hr.firstName || ''} ${hr.lastName || ''}`.trim() || 'HR',
            requestedByName: 'System',
            extra1: `${record.utilityType || 'Utility'} · Day ${record.paymentDay}`,
            extra2: `Payment due today (${dueLabel})`,
            extra3: JSON.stringify({
                entryId: record.entryId,
                paymentDay: record.paymentDay,
                daysBefore: DUE_TODAY_STAGE,
                yearMonth: yearMonth || yearMonthKey(dueDate),
                detailsPath: `/HRM/Asset/UtilityBills/details/${encodeURIComponent(String(record.entryId))}`,
            }),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}

/**
 * Daily scan: Active payment-day rows → one email + HR bell only when payable date == today.
 */
export async function processUtilityBillPaymentDayReminders() {
    try {
        const records = await UtilityBillPaymentDay.find({ status: 'Active' }).lean();
        if (!records.length) return;

        const hr = await getDepartmentHOD('hr');
        if (!hr?._id) {
            console.warn('[UtilityBillPaymentDayReminders] HR HOD not found.');
        }

        for (const record of records) {
            try {
                const { daysUntil, dueDate, yearMonth } = daysUntilPaymentDay(record.paymentDay);
                if (daysUntil !== DUE_TODAY_STAGE) continue;

                const already = await wasSent(record.entryId, yearMonth, DUE_TODAY_STAGE);
                if (already) continue;

                const dueDateLabel = dueDate.toLocaleDateString('en-GB');

                if (hr) {
                    // Bell first — if this fails, do not mark sent / spam email without a notification.
                    await createHrBell({
                        record,
                        dueDate,
                        hr,
                        yearMonth,
                    });
                    await sendUtilityBillPaymentDayEmail({
                        recipient: hr,
                        record,
                        dueDateLabel,
                    });
                }

                await markSent(record.entryId, yearMonth, DUE_TODAY_STAGE, dueDate);
                console.log(
                    `[UtilityBillPaymentDayReminders] due-today sent for entry ${record.entryId} (day ${record.paymentDay})`,
                );
            } catch (entryErr) {
                console.error(
                    `[processUtilityBillPaymentDayReminders] entry ${record?.entryId}:`,
                    entryErr?.message || entryErr,
                );
            }
        }
    } catch (err) {
        console.error('[processUtilityBillPaymentDayReminders] Non-fatal error:', err?.message || err);
    }
}
