import crypto from 'crypto';
import mongoose from 'mongoose';
import UtilityBillPayment from '../models/UtilityBillPayment.js';
import UtilityBillPaymentDay from '../models/UtilityBillPaymentDay.js';
import UtilityBillPaymentDayReminderLog from '../models/UtilityBillPaymentDayReminderLog.js';
import UtilityEntry from '../models/UtilityEntry.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendUtilityBillPaymentDayEmail } from './sendUtilityBillPaymentDayEmail.js';
import { utilityBillHasZohoLink } from './markUtilityVendorBillsPaidFromZoho.js';
import {
    getCalendarPartsInTz,
    getScheduledEmailTimeZone,
    zonedWallTimeToUtc,
} from './scheduleDailyAtMidnight.js';

const REQUEST_TYPE = 'Utility Bill Payment Reminder';
/** Only fire when payable date == today (no T-10 / T-5 advance emails). */
const DUE_TODAY_STAGE = 0;

function requestObjectId(key) {
    const hex = crypto.createHash('md5').update(String(key)).digest('hex').slice(0, 24);
    return new mongoose.Types.ObjectId(hex);
}

function reminderTz() {
    return getScheduledEmailTimeZone();
}

function todayStartInReminderTz(now = new Date()) {
    const { year, month, day } = getCalendarPartsInTz(now, reminderTz());
    return zonedWallTimeToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, reminderTz());
}

function yearMonthKeyFromParts(year, month) {
    return `${year}-${String(month).padStart(2, '0')}`;
}

function yearMonthKey(d) {
    const { year, month } = getCalendarPartsInTz(d, reminderTz());
    return yearMonthKeyFromParts(year, month);
}

/** Normalize billMonth / yearMonth to YYYY-MM. */
export function normalizeUtilityBillMonth(raw) {
    const s = String(raw || '').trim();
    if (/^\d{4}-\d{2}$/.test(s)) return s;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 7);
    return '';
}

export function utilityBillPaymentDayRequestId(entryId, yearMonth, daysBefore = DUE_TODAY_STAGE) {
    return requestObjectId(
        `utility-bill-payment-day:${String(entryId || '').trim()}:${yearMonth}:${daysBefore}`,
    );
}

export function dueDateForPaymentDay(paymentDay, refDate = new Date()) {
    const tz = reminderTz();
    const { year, month } = getCalendarPartsInTz(refDate, tz);
    const nextMonthProbe = zonedWallTimeToUtc(
        {
            year: month === 12 ? year + 1 : year,
            month: month === 12 ? 1 : month + 1,
            day: 1,
            hour: 12,
        },
        tz,
    );
    const lastParts = getCalendarPartsInTz(
        new Date(nextMonthProbe.getTime() - 36 * 60 * 60 * 1000),
        tz,
    );
    const last = lastParts.day;
    const day = Math.min(Math.max(1, Number(paymentDay) || 1), last);
    return zonedWallTimeToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, tz);
}

export function daysUntilPaymentDay(paymentDay, today = new Date()) {
    const t = todayStartInReminderTz(today);
    let due = dueDateForPaymentDay(paymentDay, t);
    if (due.getTime() < t.getTime()) {
        const { year, month } = getCalendarPartsInTz(t, reminderTz());
        const nextMonthRef = zonedWallTimeToUtc(
            {
                year: month === 12 ? year + 1 : year,
                month: month === 12 ? 1 : month + 1,
                day: 1,
                hour: 12,
            },
            reminderTz(),
        );
        due = dueDateForPaymentDay(paymentDay, nextMonthRef);
    }
    return {
        daysUntil: Math.round((due.getTime() - t.getTime()) / (1000 * 60 * 60 * 24)),
        dueDate: due,
        yearMonth: yearMonthKey(due),
    };
}

/** Payable date for a specific bill month YYYY-MM (not "next upcoming" cycle). */
export function dueDateForBillMonth(paymentDay, billMonth) {
    const ym = normalizeUtilityBillMonth(billMonth);
    if (!ym) return null;
    const [yearStr, monthStr] = ym.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    if (!Number.isFinite(year) || month < 1 || month > 12) return null;
    const refDate = zonedWallTimeToUtc(
        { year, month, day: 15, hour: 12, minute: 0, second: 0 },
        reminderTz(),
    );
    return dueDateForPaymentDay(paymentDay, refDate);
}

function calendarMonthKeysToCheck(refDate = new Date()) {
    const { year, month } = getCalendarPartsInTz(refDate, reminderTz());
    const current = yearMonthKeyFromParts(year, month);
    const prevYear = month === 1 ? year - 1 : year;
    const prevMonth = month === 1 ? 12 : month - 1;
    const previous = yearMonthKeyFromParts(prevYear, prevMonth);
    return [current, previous];
}

function isDueOnOrBeforeToday(dueDate, refDate = new Date()) {
    if (!dueDate) return false;
    const t = todayStartInReminderTz(refDate);
    return dueDate.getTime() <= t.getTime();
}

function isDueToday(dueDate, refDate = new Date()) {
    if (!dueDate) return false;
    const t = todayStartInReminderTz(refDate);
    return dueDate.getTime() === t.getTime();
}

function formatBillMonthLabel(billMonth) {
    const ym = normalizeUtilityBillMonth(billMonth);
    if (!ym) return '';
    const [yearStr, monthStr] = ym.split('-');
    const probe = zonedWallTimeToUtc(
        { year: Number(yearStr), month: Number(monthStr), day: 1, hour: 12 },
        reminderTz(),
    );
    return probe.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: reminderTz() });
}

function overdueReminderMessage(billMonth, dueLabel, refDate = new Date()) {
    const ym = normalizeUtilityBillMonth(billMonth);
    const currentYm = yearMonthKey(refDate);
    if (ym === currentYm) {
        return `Bill overdue — please clear this month's bill (${dueLabel})`;
    }
    const monthLabel = formatBillMonthLabel(ym);
    return monthLabel
        ? `Bill overdue — please clear ${monthLabel} bill (${dueLabel})`
        : `Bill overdue — please clear bill (${dueLabel})`;
}

/**
 * That month's bill is settled when Paid OR already sent to Zoho.
 */
export async function isUtilityMonthBillSettled(entryId, billMonth) {
    const id = String(entryId || '').trim();
    const ym = normalizeUtilityBillMonth(billMonth);
    if (!id || !ym) return false;

    const bills = await UtilityBillPayment.find({
        entryId: id,
        billMonth: ym,
        status: { $ne: 'Rejected' },
    })
        .select('status zohoBillId zohoBillIds zohoLineItems zohoSyncedAt')
        .lean();

    if (!bills.length) return false;
    return bills.some(
        (b) => String(b.status || '') === 'Paid' || utilityBillHasZohoLink(b),
    );
}

/**
 * Clear Pending payment-day reminder for one account + bill month
 * (after Paid or Zoho sync).
 */
export async function clearUtilityBillPaymentDayReminderForMonth(
    entryId,
    billMonth,
    reason = 'Month bill paid or sent to Zoho',
) {
    const id = String(entryId || '').trim();
    const ym = normalizeUtilityBillMonth(billMonth);
    if (!id || !ym) return 0;

    const requestId = utilityBillPaymentDayRequestId(id, ym, DUE_TODAY_STAGE);
    const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const result = await DashboardAction.updateMany(
        {
            requestType: REQUEST_TYPE,
            status: 'Pending',
            $or: [
                { requestId },
                {
                    $and: [
                        { extra3: { $regex: `"entryId"\\s*:\\s*"${escape(id)}"` } },
                        { extra3: { $regex: `"yearMonth"\\s*:\\s*"${escape(ym)}"` } },
                    ],
                },
            ],
        },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment: reason,
            },
        },
    );

    return result?.modifiedCount || 0;
}

/** Clear reminders for one or more bill docs (after pay / Zoho). */
export async function clearUtilityBillPaymentDayRemindersForBills(
    bills = [],
    reason = 'Month bill paid or sent to Zoho',
) {
    const seen = new Set();
    let closed = 0;
    for (const bill of bills || []) {
        const id = String(bill?.entryId || '').trim();
        const ym = normalizeUtilityBillMonth(bill?.billMonth);
        if (!id || !ym) continue;
        const key = `${id}|${ym}`;
        if (seen.has(key)) continue;
        seen.add(key);
        closed += await clearUtilityBillPaymentDayReminderForMonth(id, ym, reason);
    }
    return closed;
}

/**
 * Scan Pending reminders and clear when:
 * - that month's bill is Paid / in Zoho, OR
 * - utility account deleted / no Active payment-day row
 */
export async function clearSettledUtilityBillPaymentDayReminders() {
    const pending = await DashboardAction.find({
        requestType: REQUEST_TYPE,
        status: 'Pending',
    })
        .select('_id extra3 requestedDate')
        .lean();

    let closed = 0;
    for (const row of pending) {
        let meta = {};
        try {
            meta = JSON.parse(row.extra3 || '{}');
        } catch {
            meta = {};
        }
        const entryId = String(meta.entryId || '').trim();
        let ym = normalizeUtilityBillMonth(meta.yearMonth || meta.dueDateKey);
        if (!ym && row.requestedDate) {
            ym = yearMonthKey(new Date(row.requestedDate));
        }

        let reason = '';
        if (!entryId) {
            reason = 'Payment day reminder missing account — cleared';
        } else {
            const dayRow = await UtilityBillPaymentDay.findOne({ entryId: String(entryId) })
                .select('_id status paymentDay')
                .lean();
            if (!dayRow) {
                reason = 'Utility / payment day removed — reminder cleared';
            } else if (String(dayRow.status || '') !== 'Active') {
                reason = 'Payment day inactive — reminder cleared';
            } else if (ym && (await isUtilityMonthBillSettled(entryId, ym))) {
                reason = 'Month bill paid or sent to Zoho';
            }
        }

        if (!reason) continue;
        await DashboardAction.updateOne(
            { _id: row._id, status: 'Pending' },
            {
                $set: {
                    status: 'Approved',
                    actionedDate: new Date(),
                    comment: reason,
                },
            },
        );
        closed += 1;
    }
    return closed;
}

/** Clear all Pending payment-day reminders for one utility account. */
export async function clearUtilityBillPaymentDayRemindersForEntry(
    entryId,
    reason = 'Payment day reminder cleared',
) {
    const id = String(entryId || '').trim();
    if (!id) return 0;
    const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const result = await DashboardAction.updateMany(
        {
            requestType: REQUEST_TYPE,
            status: 'Pending',
            extra3: { $regex: `"entryId"\\s*:\\s*"${escape(id)}"` },
        },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment: reason,
            },
        },
    );

    return result?.modifiedCount || 0;
}

function entryHasBillableMonthlyRental(values = {}) {
    const raw = values?.monthlyRental;
    if (raw === '' || raw == null || raw === undefined) return true;
    const rental = Number(raw);
    return Number.isFinite(rental) && rental > 0;
}

/** Deactivate payment-day rows and clear bells when monthly rental is zero. */
async function deactivatePaymentDaysForZeroRentalEntries() {
    const activeDays = await UtilityBillPaymentDay.find({ status: 'Active' })
        .select('entryId')
        .lean();
    if (!activeDays.length) return 0;

    const entryIds = [...new Set(activeDays.map((row) => String(row.entryId || '').trim()).filter(Boolean))];
    if (!entryIds.length) return 0;

    const entries = await UtilityEntry.find({ _id: { $in: entryIds } })
        .select('values.monthlyRental')
        .lean();
    const zeroRentalIds = entries
        .filter((entry) => !entryHasBillableMonthlyRental(entry?.values || {}))
        .map((entry) => String(entry._id));

    if (!zeroRentalIds.length) return 0;

    await UtilityBillPaymentDay.updateMany(
        { entryId: { $in: zeroRentalIds } },
        { $set: { status: 'Inactive' } },
    );

    let cleared = 0;
    for (const entryId of zeroRentalIds) {
        cleared += await clearUtilityBillPaymentDayRemindersForEntry(
            entryId,
            'No monthly bill — payment day reminder cleared',
        );
    }
    return cleared;
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

async function createAccountsBell({ record, dueDate, accounts, yearMonth, refDate = new Date() }) {
    if (!accounts?._id) return;
    const dueLabel = dueDate.toLocaleDateString('en-GB', { timeZone: reminderTz() });
    const ym = yearMonth || yearMonthKey(dueDate);
    const requestId = utilityBillPaymentDayRequestId(record.entryId, ym, DUE_TODAY_STAGE);

    await DashboardAction.findOneAndUpdate(
        { requestId, requestType: REQUEST_TYPE },
        {
            requestId,
            requestType: REQUEST_TYPE,
            assignedTo: accounts._id,
            assignedToEmpId: accounts.employeeId || undefined,
            status: 'Pending',
            subjectEmployeeId: accounts.employeeId || undefined,
            subjectName:
                `${accounts.firstName || ''} ${accounts.lastName || ''}`.trim() || 'Accounts',
            requestedByName: 'System',
            requestedDate: new Date(),
            extra1: `${record.utilityType || 'Utility'} · Day ${record.paymentDay} · ${ym}`,
            extra2: overdueReminderMessage(ym, dueLabel, refDate),
            extra3: JSON.stringify({
                entryId: record.entryId,
                paymentDay: record.paymentDay,
                daysBefore: DUE_TODAY_STAGE,
                yearMonth: ym,
                billMonth: ym,
                dueDateKey: `${ym}-${String(record.paymentDay).padStart(2, '0')}`,
                stickyUntilSettled: true,
                detailsPath: `/HRM/Asset/UtilityBills/details/${encodeURIComponent(String(record.entryId))}?addBill=1&billMonth=${encodeURIComponent(ym)}`,
            }),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}

/**
 * Daily:
 * 1) Clear reminders when that month's bill is Paid or sent to Zoho
 * 2) For current + previous bill month: if payment date passed and bill unsettled → Accounts bell
 * 3) On that month's payment day == today → urgent email (once per month)
 */
export async function processUtilityBillPaymentDayReminders() {
    try {
        const now = new Date();
        const dubaiParts = getCalendarPartsInTz(now, reminderTz());
        const zeroRentalClosed = await deactivatePaymentDaysForZeroRentalEntries();
        if (zeroRentalClosed > 0) {
            console.log(
                `[UtilityBillPaymentDayReminders] cleared ${zeroRentalClosed} zero-rental reminder(s)`,
            );
        }
        const closed = await clearSettledUtilityBillPaymentDayReminders();
        if (closed > 0) {
            console.log(
                `[UtilityBillPaymentDayReminders] cleared ${closed} settled month reminder(s)`,
            );
        }

        const records = await UtilityBillPaymentDay.find({ status: 'Active' }).lean();
        if (!records.length) return;

        const accounts = await getDepartmentHOD('accounts');
        if (!accounts?._id) {
            console.warn('[UtilityBillPaymentDayReminders] Accounts HOD not found.');
        }

        const monthsToCheck = calendarMonthKeysToCheck(now);

        console.log(
            `[UtilityBillPaymentDayReminders] scanning ${records.length} Active row(s) for ${dubaiParts.year}-${String(dubaiParts.month).padStart(2, '0')}-${String(dubaiParts.day).padStart(2, '0')} (${reminderTz()}); months ${monthsToCheck.join(', ')}`,
        );

        for (const record of records) {
            for (const billMonth of monthsToCheck) {
                try {
                    if (await isUtilityMonthBillSettled(record.entryId, billMonth)) {
                        await clearUtilityBillPaymentDayReminderForMonth(
                            record.entryId,
                            billMonth,
                            'Month bill already paid or in Zoho',
                        );
                        continue;
                    }

                    const dueDate = dueDateForBillMonth(record.paymentDay, billMonth);
                    if (!dueDate || !isDueOnOrBeforeToday(dueDate, now)) continue;

                    const dueDateLabel = dueDate.toLocaleDateString('en-GB', {
                        timeZone: reminderTz(),
                    });

                    if (accounts) {
                        await createAccountsBell({
                            record,
                            dueDate,
                            accounts,
                            yearMonth: billMonth,
                            refDate: now,
                        });
                    }

                    if (!isDueToday(dueDate, now)) continue;

                    const already = await wasSent(record.entryId, billMonth, DUE_TODAY_STAGE);
                    if (already) continue;

                    if (accounts) {
                        await sendUtilityBillPaymentDayEmail({
                            recipient: accounts,
                            record,
                            dueDateLabel,
                            yearMonth: billMonth,
                        });
                    }

                    await markSent(record.entryId, billMonth, DUE_TODAY_STAGE, dueDate);
                    console.log(
                        `[UtilityBillPaymentDayReminders] due-today sent for entry ${record.entryId} (day ${record.paymentDay}, ${billMonth})`,
                    );
                } catch (entryErr) {
                    console.error(
                        `[processUtilityBillPaymentDayReminders] entry ${record?.entryId} ${billMonth}:`,
                        entryErr?.message || entryErr,
                    );
                }
            }
        }
    } catch (err) {
        console.error('[processUtilityBillPaymentDayReminders] Non-fatal error:', err?.message || err);
    }
}
