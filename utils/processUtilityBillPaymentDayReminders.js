import UtilityBillPaymentDay from '../models/UtilityBillPaymentDay.js';
import UtilityBillPaymentDayReminderLog from '../models/UtilityBillPaymentDayReminderLog.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendUtilityBillPaymentDayEmail } from './sendUtilityBillPaymentDayEmail.js';

const REQUEST_TYPE = 'Utility Bill Payment Reminder';
const STAGES = [10, 5, 0];

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

function kindForStage(daysBefore) {
    if (daysBefore === 10) return 't10';
    if (daysBefore === 5) return 't5';
    return 'due';
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

async function createHrBell({ record, daysBefore, dueDate, hr }) {
    if (!hr?._id) return;
    const dueLabel = dueDate.toLocaleDateString('en-GB');
    const stageLabel =
        daysBefore === 0 ? 'due today' : `due in ${daysBefore} day${daysBefore === 1 ? '' : 's'}`;
    const requestId = `${record.entryId}:${yearMonthKey(dueDate)}:${daysBefore}`;

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
                detailsPath: `/HRM/Asset/UtilityBills/details/${encodeURIComponent(String(record.entryId))}`,
            }),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}

/**
 * Daily scan: Active payment-day rows → email + HR bell at T-10, T-5, and due day.
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
            const { daysUntil, dueDate, yearMonth } = daysUntilPaymentDay(record.paymentDay);
            if (!STAGES.includes(daysUntil)) continue;

            const already = await wasSent(record.entryId, yearMonth, daysUntil);
            if (already) continue;

            const dueDateLabel = dueDate.toLocaleDateString('en-GB');
            const kind = kindForStage(daysUntil);

            if (hr) {
                await sendUtilityBillPaymentDayEmail({
                    recipient: hr,
                    record,
                    kind,
                    dueDateLabel,
                });
                await createHrBell({
                    record,
                    daysBefore: daysUntil,
                    dueDate,
                    hr,
                });
            }

            await markSent(record.entryId, yearMonth, daysUntil, dueDate);
            console.log(
                `[UtilityBillPaymentDayReminders] ${kind} sent for entry ${record.entryId} (day ${record.paymentDay})`,
            );
        }
    } catch (err) {
        console.error('[processUtilityBillPaymentDayReminders] Non-fatal error:', err?.message || err);
    }
}
