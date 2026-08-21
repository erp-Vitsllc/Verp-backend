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

/**
 * Payable date for a bill month YYYY-MM.
 * Policy: that month's bill is paid on the payment day of the *next* month
 * (June bill → July payment day).
 */
export function dueDateForBillMonth(paymentDay, billMonth) {
    const ym = normalizeUtilityBillMonth(billMonth);
    if (!ym) return null;
    const [yearStr, monthStr] = ym.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    if (!Number.isFinite(year) || month < 1 || month > 12) return null;
    const payYear = month === 12 ? year + 1 : year;
    const payMonth = month === 12 ? 1 : month + 1;
    const refDate = zonedWallTimeToUtc(
        { year: payYear, month: payMonth, day: 15, hour: 12, minute: 0, second: 0 },
        reminderTz(),
    );
    return dueDateForPaymentDay(paymentDay, refDate);
}

/** Current calendar month + previous (previous = the bill payable this month). */
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

function monthNameFromBillMonth(billMonth) {
    const label = formatBillMonthLabel(billMonth);
    if (!label) return '';
    return label.replace(/\s+\d{4}$/, '');
}

/** "June bill payment day on Electricity on the 12345678, please pay the bill" */
export function paymentDayReminderMessage(record = {}, billMonth = '') {
    const monthName = monthNameFromBillMonth(billMonth) || 'This';
    const utilityType = String(record.utilityType || 'utility').trim() || 'utility';
    const accountNo = String(record.accountNo || '').trim() || 'account';
    return `${monthName} bill payment day on ${utilityType} on the ${accountNo}, please pay the bill`;
}

function entryAvailableFromMonth(entry) {
    const created = entry?.createdAt || null;
    if (created) {
        const ym = yearMonthKey(new Date(created));
        if (/^\d{4}-\d{2}$/.test(ym)) return ym;
    }
    const contractStart = String(entry?.values?.contractStart || '').trim();
    if (/^\d{4}-\d{2}/.test(contractStart)) return contractStart.slice(0, 7);
    return '';
}

function entryEligibleForBillMonth(entry, billMonth) {
    const ym = normalizeUtilityBillMonth(billMonth);
    if (!entry || !ym) return false;
    if (String(entry.status || '') === 'Inactive') return false;
    const from = entryAvailableFromMonth(entry);
    if (from && from > ym) return false;
    return true;
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

async function createAccountsBell({ record, dueDate, accounts, yearMonth }) {
    if (!accounts?._id) return;
    const ym = yearMonth || yearMonthKey(dueDate);
    const requestId = utilityBillPaymentDayRequestId(record.entryId, ym, DUE_TODAY_STAGE);
    const monthLabel = formatBillMonthLabel(ym) || ym;
    const utilityType = String(record.utilityType || 'Utility').trim() || 'Utility';
    const accountNo = String(record.accountNo || '').trim() || '—';
    const dueParts = getCalendarPartsInTz(dueDate, reminderTz());
    const dueDateKey = `${dueParts.year}-${String(dueParts.month).padStart(2, '0')}-${String(dueParts.day).padStart(2, '0')}`;

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
            extra1: `${utilityType} · ${accountNo} · ${monthLabel}`,
            extra2: paymentDayReminderMessage(record, ym),
            extra3: JSON.stringify({
                entryId: record.entryId,
                paymentDay: record.paymentDay,
                daysBefore: DUE_TODAY_STAGE,
                yearMonth: ym,
                billMonth: ym,
                accountNo,
                utilityType,
                dueDateKey,
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
 * 2) Current month's bill is payable next month on the payment day
 *    (June bill → July payment day). Scan current + previous bill months.
 * 3) On that payable day == today → Accounts email (once per bill month)
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
        const entryIds = [
            ...new Set(records.map((row) => String(row.entryId || '').trim()).filter(Boolean)),
        ];
        const entries = entryIds.length
            ? await UtilityEntry.find({ _id: { $in: entryIds } })
                  .select('createdAt status values.contractStart')
                  .lean()
            : [];
        const entryById = new Map(entries.map((row) => [String(row._id), row]));

        console.log(
            `[UtilityBillPaymentDayReminders] scanning ${records.length} Active row(s) for ${dubaiParts.year}-${String(dubaiParts.month).padStart(2, '0')}-${String(dubaiParts.day).padStart(2, '0')} (${reminderTz()}); months ${monthsToCheck.join(', ')}`,
        );

        for (const record of records) {
            const entry = entryById.get(String(record.entryId || ''));
            for (const billMonth of monthsToCheck) {
                try {
                    if (!entryEligibleForBillMonth(entry, billMonth)) {
                        await clearUtilityBillPaymentDayReminderForMonth(
                            record.entryId,
                            billMonth,
                            'Account was not active for this bill month',
                        );
                        continue;
                    }

                    if (await isUtilityMonthBillSettled(record.entryId, billMonth)) {
                        await clearUtilityBillPaymentDayReminderForMonth(
                            record.entryId,
                            billMonth,
                            'Month bill already paid or in Zoho',
                        );
                        continue;
                    }

                    const dueDate = dueDateForBillMonth(record.paymentDay, billMonth);
                    if (!dueDate) continue;
                    if (!isDueOnOrBeforeToday(dueDate, now)) {
                        await clearUtilityBillPaymentDayReminderForMonth(
                            record.entryId,
                            billMonth,
                            'Bill is payable next month — reminder cleared until payment day',
                        );
                        continue;
                    }

                    const dueDateLabel = dueDate.toLocaleDateString('en-GB', {
                        timeZone: reminderTz(),
                    });
                    const message = paymentDayReminderMessage(record, billMonth);

                    if (accounts) {
                        await createAccountsBell({
                            record,
                            dueDate,
                            accounts,
                            yearMonth: billMonth,
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
                            message,
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
