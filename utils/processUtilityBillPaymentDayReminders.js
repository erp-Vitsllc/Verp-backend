import crypto from 'crypto';
import mongoose from 'mongoose';
import UtilityBillPayment from '../models/UtilityBillPayment.js';
import UtilityBillPaymentDay from '../models/UtilityBillPaymentDay.js';
import UtilityBillPaymentDayReminderLog from '../models/UtilityBillPaymentDayReminderLog.js';
import UtilityEntry from '../models/UtilityEntry.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendUtilityBillPaymentDayEmail } from './sendUtilityBillPaymentDayEmail.js';
import { completeUtilityReminderTasks, ensureUtilityReminderTask } from './utilityReminderTask.js';
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

/** Previous calendar month: the bill Accounts pays on the 1st of this month. */
export function previousCalendarMonthKey(year, month) {
    const prevYear = month === 1 ? year - 1 : year;
    const prevMonth = month === 1 ? 12 : month - 1;
    return yearMonthKeyFromParts(prevYear, prevMonth);
}

/**
 * On the 1st, Accounts is notified to pay the previous month.
 * If that 1st was missed, the same previous-month notice is sent once later in the month.
 */
export function previousMonthPayReminderDue(billMonth, { year, month, day, alreadySent = false } = {}) {
    const previous = previousCalendarMonthKey(year, month);
    if (normalizeUtilityBillMonth(billMonth) !== previous) return { open: false, send: false };
    if (!Number.isFinite(day) || day < 1) return { open: false, send: false };
    return { open: true, send: !alreadySent };
}

/**
 * Bill months from `fromYm` through the previous calendar month.
 * The current month is not due yet.
 */
export function dueUnpaidBillMonths(fromYm, year, month) {
    const previous = previousCalendarMonthKey(year, month);
    const from = normalizeUtilityBillMonth(fromYm);
    if (!from || !previous || from > previous) return [];
    const months = [];
    let y = Number(from.slice(0, 4));
    let m = Number(from.slice(5, 7));
    const endY = Number(previous.slice(0, 4));
    const endM = Number(previous.slice(5, 7));
    let guard = 0;
    while ((y < endY || (y === endY && m <= endM)) && guard < 36) {
        months.push(yearMonthKeyFromParts(y, m));
        m += 1;
        if (m > 12) {
            m = 1;
            y += 1;
        }
        guard += 1;
    }
    return months;
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

/** One notice for the utility, not one notice for each SIM or account under it. */
export function utilityTypeNoticeId(utilityType) {
    const type = String(utilityType || 'Utility').trim().toLowerCase() || 'utility';
    return `utility-type:${type}`;
}

/** "October bill payment — SIM cards, please pay the bill" */
export function utilityTypePaymentMessage(utilityType, billMonth) {
    const monthName = monthNameFromBillMonth(billMonth) || 'This';
    const type = String(utilityType || 'utility').trim() || 'utility';
    return `${monthName} bill payment — ${type}, please pay the bill`;
}

function monthAfterYearMonth(ym) {
    const key = normalizeUtilityBillMonth(ym);
    if (!key) return '';
    let year = Number(key.slice(0, 4));
    let month = Number(key.slice(5, 7)) + 1;
    if (month > 12) {
        month = 1;
        year += 1;
    }
    return yearMonthKeyFromParts(year, month);
}

/** The month the SIM record was created. A contract start date is not used. */
function entryCreatedMonth(entry) {
    const created = entry?.createdAt || null;
    if (!created) return '';
    const ym = yearMonthKey(new Date(created));
    return /^\d{4}-\d{2}$/.test(ym) ? ym : '';
}

/**
 * Missing-bill check applies only when the SIM was created before that month.
 * A SIM added in the month, or later, is not checked for that month's payment.
 */
export function simCreatedBeforeBillMonth(createdYm, billMonth) {
    const created = normalizeUtilityBillMonth(createdYm);
    const ym = normalizeUtilityBillMonth(billMonth);
    if (!created || !ym) return false;
    return created < ym;
}

/** Unpaid months after the SIM was created, through the previous calendar month. */
export function unpaidMonthsSinceSimCreated(createdYm, year, month) {
    const start = monthAfterYearMonth(createdYm);
    if (!start) return [];
    return dueUnpaidBillMonths(start, year, month);
}

function entryEligibleForBillMonth(entry, billMonth) {
    const ym = normalizeUtilityBillMonth(billMonth);
    if (!entry || !ym) return false;
    if (String(entry.status || '') === 'Inactive') return false;
    return simCreatedBeforeBillMonth(entryCreatedMonth(entry), ym);
}

function zohoStatusIsPaid(bill) {
    const status = String(bill?.zohoBillStatus || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_');
    return status === 'paid' || status === 'fully_paid';
}

/**
 * A month is settled only when a bill is Paid in ERP or Zoho.
 * No bill, a zero amount, or an unpaid bill stays open.
 */
export function utilityMonthBillIsSettled(bills = []) {
    const rows = (Array.isArray(bills) ? bills : []).filter(
        (bill) => String(bill?.status || '') !== 'Rejected',
    );
    if (!rows.length) return false;
    return rows.some((bill) => String(bill.status || '') === 'Paid' || zohoStatusIsPaid(bill));
}

/** True when this month already has a bill updated in Zoho. */
export function utilityMonthBillIsInZoho(bills = []) {
    const rows = (Array.isArray(bills) ? bills : []).filter(
        (bill) => String(bill?.status || '') !== 'Rejected',
    );
    return rows.some((bill) => utilityBillHasZohoLink(bill));
}

export async function isUtilityMonthBillSettled(entryId, billMonth) {
    const id = String(entryId || '').trim();
    const ym = normalizeUtilityBillMonth(billMonth);
    if (!id || !ym) return false;

    const bills = await UtilityBillPayment.find({
        entryId: id,
        billMonth: ym,
        status: { $ne: 'Rejected' },
    })
        .select(
            'status amount zohoBillId zohoBillIds zohoBillNumber zohoBillStatus zohoLineItems zohoSyncedAt',
        )
        .lean();

    return utilityMonthBillIsSettled(bills);
}

export async function isUtilityMonthBillInZoho(entryId, billMonth) {
    const id = String(entryId || '').trim();
    const ym = normalizeUtilityBillMonth(billMonth);
    if (!id || !ym) return false;

    const bills = await UtilityBillPayment.find({
        entryId: id,
        billMonth: ym,
        status: { $ne: 'Rejected' },
    })
        .select('status zohoBillId zohoBillIds zohoBillNumber zohoLineItems')
        .lean();

    return utilityMonthBillIsInZoho(bills);
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

    const filter = {
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
    };
    const matches = await DashboardAction.find(filter).select('_id').lean();
    if (!matches.length) return 0;
    const matchIds = matches.map((row) => row._id);
    const result = await DashboardAction.updateMany(
        { _id: { $in: matchIds }, status: 'Pending' },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment: reason,
            },
        },
    );
    if (result?.modifiedCount) await completeUtilityReminderTasks(matchIds);

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
 * - that month's bill is Paid in ERP or Zoho, OR
 * - utility account deleted / no Active payment-day row
 * A Zoho upload does not clear the task.
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
        if (entryId.startsWith('utility-type:')) continue;
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
            const entry = await UtilityEntry.findById(entryId).select('createdAt status').lean();
            if (!dayRow) {
                reason = 'Utility / payment day removed — reminder cleared';
            } else if (String(dayRow.status || '') !== 'Active') {
                reason = 'Payment day inactive — reminder cleared';
            } else if (ym && !entryEligibleForBillMonth(entry, ym)) {
                reason = 'SIM was added after this bill month';
            } else if (ym && (await isUtilityMonthBillSettled(entryId, ym))) {
                reason = 'Month bill paid in Zoho';
            }
        }

        if (!reason) continue;
        const closedRow = await DashboardAction.updateOne(
            { _id: row._id, status: 'Pending' },
            {
                $set: {
                    status: 'Approved',
                    actionedDate: new Date(),
                    comment: reason,
                },
            },
        );
        if (closedRow?.modifiedCount) await completeUtilityReminderTasks([row._id]);
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

    const filter = {
        requestType: REQUEST_TYPE,
        status: 'Pending',
        extra3: { $regex: `"entryId"\\s*:\\s*"${escape(id)}"` },
    };
    const matches = await DashboardAction.find(filter).select('_id').lean();
    if (!matches.length) return 0;
    const matchIds = matches.map((row) => row._id);
    const result = await DashboardAction.updateMany(
        { _id: { $in: matchIds }, status: 'Pending' },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment: reason,
            },
        },
    );
    if (result?.modifiedCount) await completeUtilityReminderTasks(matchIds);

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

async function clearPerAccountUtilityReminders() {
    const pending = await DashboardAction.find({
        requestType: REQUEST_TYPE,
        status: 'Pending',
    })
        .select('_id extra3')
        .lean();
    const ids = [];
    for (const row of pending) {
        let meta = {};
        try {
            meta = JSON.parse(row.extra3 || '{}');
        } catch {
            meta = {};
        }
        const entryId = String(meta.entryId || '').trim();
        if (!entryId.startsWith('utility-type:')) ids.push(row._id);
    }
    if (!ids.length) return 0;
    const result = await DashboardAction.updateMany(
        { _id: { $in: ids }, status: 'Pending' },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment: 'One notice per utility, not per SIM or account',
            },
        },
    );
    if (result?.modifiedCount) await completeUtilityReminderTasks(ids);
    return result?.modifiedCount || 0;
}

async function createUtilityTypeBell({ utilityType, dueDate, accounts, yearMonth }) {
    if (!accounts?._id || !yearMonth) return;
    const noticeId = utilityTypeNoticeId(utilityType);
    const requestId = utilityBillPaymentDayRequestId(noticeId, yearMonth, DUE_TODAY_STAGE);
    const monthLabel = formatBillMonthLabel(yearMonth) || yearMonth;
    const type = String(utilityType || 'Utility').trim() || 'Utility';
    const dueParts = getCalendarPartsInTz(dueDate, reminderTz());
    const dueDateKey = `${dueParts.year}-${String(dueParts.month).padStart(2, '0')}-${String(dueParts.day).padStart(2, '0')}`;
    const message = utilityTypePaymentMessage(type, yearMonth);

    const action = await DashboardAction.findOneAndUpdate(
        { requestId, requestType: REQUEST_TYPE },
        {
            $set: {
                requestId,
                requestType: REQUEST_TYPE,
                assignedTo: accounts._id,
                assignedToEmpId: accounts.employeeId || undefined,
                status: 'Pending',
                subjectName:
                    `${accounts.firstName || ''} ${accounts.lastName || ''}`.trim() || 'Accounts',
                requestedByName: 'System',
                requestedDate: new Date(),
                extra1: `${type} · ${monthLabel}`,
                extra2: message,
                extra3: JSON.stringify({
                    entryId: noticeId,
                    daysBefore: DUE_TODAY_STAGE,
                    yearMonth,
                    billMonth: yearMonth,
                    accountNo: '',
                    utilityType: type,
                    dueDateKey,
                    utilityTypeNotice: true,
                    stickyUntilSettled: true,
                    detailsPath: '/HRM/Asset/UtilityBills',
                }),
            },
            $unset: { subjectEmployeeId: '' },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await ensureUtilityReminderTask(action);
}

/**
 * After a utility bill is updated in Zoho: if the payable day has arrived
 * and Zoho has not marked it Paid, open the Accounts task immediately.
 * The daily job keeps it Pending until Paid.
 */
export async function notifyAccountsAfterUtilityZohoUpdate(billDoc) {
    const entryId = String(billDoc?.entryId || '').trim();
    const billMonth = normalizeUtilityBillMonth(billDoc?.billMonth);
    if (!entryId || !billMonth) return { created: false };
    if (!utilityBillHasZohoLink(billDoc)) return { created: false };
    if (utilityMonthBillIsSettled([billDoc])) {
        await clearUtilityBillPaymentDayReminderForMonth(
            entryId,
            billMonth,
            'Month bill paid in Zoho',
        );
        return { created: false, cleared: true };
    }

    return { created: false };
}

/**
 * Daily, and when Accounts opens Utility Bills:
 * 1) Clear a reminder only when that month's bill is Paid.
 * 2) A missing bill counts as unpaid only for months after the SIM was created.
 *    A SIM added now is not checked for older months. A zero amount is not paid.
 * 3) The current month is not notified yet.
 * 4) On the 1st, one email and one notification per utility for the previous month.
 *    Not one message per SIM or account. It stays until that utility's previous month is paid.
 */
let utilityReminderRun = null;
let utilityReminderFinishedAt = 0;

export async function processUtilityBillPaymentDayReminders() {
    if (utilityReminderRun) return utilityReminderRun;
    if (Date.now() - utilityReminderFinishedAt < 60 * 1000) return undefined;
    utilityReminderRun = runUtilityBillPaymentDayReminders().finally(() => {
        utilityReminderRun = null;
        utilityReminderFinishedAt = Date.now();
    });
    return utilityReminderRun;
}

async function runUtilityBillPaymentDayReminders() {
    try {
        const now = new Date();
        const dubaiParts = getCalendarPartsInTz(now, reminderTz());
        const zeroRentalClosed = await deactivatePaymentDaysForZeroRentalEntries();
        if (zeroRentalClosed > 0) {
            console.log(
                `[UtilityBillPaymentDayReminders] cleared ${zeroRentalClosed} zero-rental reminder(s)`,
            );
        }
        const perAccountClosed = await clearPerAccountUtilityReminders();
        if (perAccountClosed > 0) {
            console.log(
                `[UtilityBillPaymentDayReminders] closed ${perAccountClosed} per-account reminder(s)`,
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

        const previousBillMonth = previousCalendarMonthKey(dubaiParts.year, dubaiParts.month);
        const entryIds = [
            ...new Set(records.map((row) => String(row.entryId || '').trim()).filter(Boolean)),
        ];
        const entries = entryIds.length
            ? await UtilityEntry.find({ _id: { $in: entryIds } })
                  .select('createdAt status')
                  .lean()
            : [];
        const entryById = new Map(entries.map((row) => [String(row._id), row]));

        console.log(
            `[UtilityBillPaymentDayReminders] scanning ${records.length} Active row(s) for ${dubaiParts.year}-${String(dubaiParts.month).padStart(2, '0')}-${String(dubaiParts.day).padStart(2, '0')} (${reminderTz()}); unpaid through ${previousBillMonth}`,
        );

        const dueDate = todayStartInReminderTz(
            zonedWallTimeToUtc(
                {
                    year: dubaiParts.year,
                    month: dubaiParts.month,
                    day: 1,
                    hour: 0,
                    minute: 0,
                    second: 0,
                },
                reminderTz(),
            ),
        );
        const unpaidTypes = new Map();
        const seenTypes = new Map();
        for (const record of records) {
            const type = String(record.utilityType || 'Utility').trim() || 'Utility';
            const typeKey = type.toLowerCase();
            if (!seenTypes.has(typeKey)) seenTypes.set(typeKey, type);
            const entry = entryById.get(String(record.entryId || ''));
            if (!entryEligibleForBillMonth(entry, previousBillMonth)) continue;
            if (await isUtilityMonthBillSettled(record.entryId, previousBillMonth)) continue;
            unpaidTypes.set(typeKey, type);
        }

        for (const [typeKey, typeLabel] of seenTypes) {
            const noticeId = utilityTypeNoticeId(typeLabel);
            if (!unpaidTypes.has(typeKey)) {
                await clearUtilityBillPaymentDayReminderForMonth(
                    noticeId,
                    previousBillMonth,
                    'Previous month bills for this utility are paid',
                );
                continue;
            }
            if (!accounts) continue;
            await createUtilityTypeBell({
                utilityType: typeLabel,
                dueDate,
                accounts,
                yearMonth: previousBillMonth,
            });
            const alreadySent = await wasSent(noticeId, previousBillMonth, DUE_TODAY_STAGE);
            if (alreadySent) continue;
            const dueDateLabel = dueDate.toLocaleDateString('en-GB', {
                timeZone: reminderTz(),
            });
            await sendUtilityBillPaymentDayEmail({
                recipient: accounts,
                record: {
                    entryId: noticeId,
                    utilityType: typeLabel,
                    accountNo: '',
                    provider: '',
                    paymentDay: 1,
                },
                dueDateLabel,
                yearMonth: previousBillMonth,
                message: utilityTypePaymentMessage(typeLabel, previousBillMonth),
            });
            await markSent(noticeId, previousBillMonth, DUE_TODAY_STAGE, dueDate);
            console.log(
                `[UtilityBillPaymentDayReminders] previous-month notice for ${typeLabel} (${previousBillMonth})`,
            );
        }
    } catch (err) {
        console.error('[processUtilityBillPaymentDayReminders] Non-fatal error:', err?.message || err);
    }
}
