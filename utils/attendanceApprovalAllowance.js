import Attendance from '../models/Attendance.js';
import AttendanceChangeRequest from '../models/AttendanceChangeRequest.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { employeeAttendanceMatch } from './attendanceDayLookup.js';
import { resolveEmployeePayrollPolicy } from './employeeLeavePolicy.js';
import { lateDeductMultiplier, sharedLateRule } from './lateDeductionPolicy.js';
import { punchAttendanceKind } from './partialLeaveWindow.js';
import { getScheduledEmailTimeZone, getZonedParts } from './scheduleDailyAtMidnight.js';

function todayKey() {
    const parts = getZonedParts(new Date(), getScheduledEmailTimeZone());
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function monthEnd(monthKey) {
    const [year, month] = String(monthKey).split('-').map(Number);
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${monthKey}-${String(last).padStart(2, '0')}`;
}

const MISSING_CHECKOUT_SKIP = new Set([
    'holiday',
    'weekly_off',
    'on_leave',
    'sick_leave',
    'compoff_leave',
    'authorized_leave',
]);

function punchText(value) {
    return String(value || '').trim();
}

/** Check-in is stored and check-out was never added. */
export function checkoutMissing(row) {
    const inn = punchText(row?.timeIn);
    if (!inn || inn === '—' || inn === '-' || inn === 'OT') return false;
    const out = punchText(row?.timeOut);
    return !out || out === '—' || out === '-';
}

/**
 * A finished day with check-in and no check-out is a mispunch.
 * The current day stays open until midnight, so the employee can still check out.
 */
export function closedMissingCheckout(row, today = todayKey()) {
    const date = punchText(row?.date);
    const current = punchText(today);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}-\d{2}-\d{2}$/.test(current) || date >= current) {
        return false;
    }
    if (!checkoutMissing(row)) return false;
    const key = punchText(row?.statusKey);
    return !MISSING_CHECKOUT_SKIP.has(key);
}

/**
 * Late arrival and early go share one monthly count.
 * Missed punch has its own count.
 */
export function approvalEventPool(row, { countOpenPunch = false } = {}) {
    const key = punchText(row?.statusKey);
    const pendingHour = punchText(row?.hourAdjustStatus) === 'pending';
    if (pendingHour && punchText(row?.hourAdjustKind) === 'mispunch') return 'mispunch';
    if (countOpenPunch && checkoutMissing(row) && !MISSING_CHECKOUT_SKIP.has(key)) return 'mispunch';
    const kind = punchAttendanceKind(row);
    if (kind === 'mispunch') return 'mispunch';
    if (kind === 'late_arrived' || kind === 'early_go') return 'late';
    if (key === 'mispunch') return 'mispunch';
    if (key === 'late_arrived' || key === 'early_go') return 'late';
    const pending = punchText(row?.leaveRequestStatus) === 'pending';
    const requestKind = punchText(row?.leaveRequestKind);
    if (pending && (requestKind === 'future_late' || requestKind === 'past_late')) return 'late';
    if (pending && requestKind === 'future_early') return 'late';
    return '';
}

/** Monthly missed-punch requests allowed by the salary-policy request count. Blank means no limit. */
export function missedPunchRequestLimit(policy) {
    const raw = policy?.missedPunchRule?.maxRequests;
    if (raw == null || raw === '') return null;
    const count = Number(raw);
    if (!Number.isFinite(count) || count < 0) return null;
    return Math.floor(count);
}

export function allowedApprovalEvents(policy, pool) {
    if (pool === 'mispunch') return missedPunchRequestLimit(policy);
    const rule = sharedLateRule(policy);
    if (lateDeductMultiplier(rule) <= 0) return null;
    const events = Number(rule?.events);
    if (!Number.isFinite(events) || events < 0) return 0;
    return Math.floor(events);
}

/**
 * Block when this request would put the month above the allowed count.
 * For missed punch that count is the salary-policy maximum request.
 * `taken` is how many events are already on record in that month.
 */
export function approvalAllowanceBlock({ allowed, existingDates, requestDates }) {
    if (allowed == null) return null;
    const request = [...new Set((requestDates || []).filter(Boolean))];
    if (!request.length) return null;
    const byMonth = new Map();
    const bucket = (date) => {
        const month = String(date).slice(0, 7);
        if (!byMonth.has(month)) byMonth.set(month, { existing: new Set(), request: new Set() });
        return byMonth.get(month);
    };
    for (const date of existingDates || []) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(date))) bucket(date).existing.add(String(date));
    }
    for (const date of request) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(date))) bucket(date).request.add(String(date));
    }
    for (const [month, sets] of byMonth) {
        if (!sets.request.size) continue;
        const combined = new Set([...sets.existing, ...sets.request]);
        if (combined.size > allowed) {
            return { month, taken: sets.existing.size, allowed };
        }
    }
    return null;
}

export function attendanceApprovalLimitText({ pool, taken, allowed }) {
    const label = pool === 'mispunch' ? 'missed punch' : 'late arrival and early go';
    const noun = Number(taken) === 1 ? 'event' : 'events';
    return `You can't send this request because you already have ${taken} ${label} ${noun} this month. The allowed count is ${allowed}. You can't send this request.`;
}

const ATTENDANCE_COUNT_FIELDS =
    'date statusKey statusLabel reason timeIn timeOut leaveRequestStatus leaveRequestKind leaveRequestSession hourAdjustStatus hourAdjustKind';

const OPEN_MISPUNCH_REQUEST_STAGES = ['pending_reportee', 'pending_hr', 'pending_requester'];

function validDay(date) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''));
}

async function attendanceRowsForEmployee(person, from, to) {
    return Attendance.find({
        ...employeeAttendanceMatch(person),
        date: { $gte: from, $lte: to },
    })
        .select(ATTENDANCE_COUNT_FIELDS)
        .lean();
}

async function poolDatesForEmployee(person, from, to, today, pool) {
    const rows = await attendanceRowsForEmployee(person, from, to);
    const dates = [];
    for (const row of rows || []) {
        const rowPool = approvalEventPool(row, { countOpenPunch: String(row?.date || '') < today });
        if (rowPool === pool) dates.push(String(row.date || ''));
    }
    return dates.filter(validDay);
}

/** Stored mispunches, closed days with no check-out, and a misspunch request that is still open. */
async function mispunchDatesForEmployee(person, from, to, today) {
    const [rows, requests] = await Promise.all([
        attendanceRowsForEmployee(person, from, to),
        AttendanceChangeRequest.find({
            ...employeeAttendanceMatch(person),
            date: { $gte: from, $lte: to },
            action: 'hour_adjust',
            'proposed.hourAdjustKind': 'mispunch',
            stage: { $in: OPEN_MISPUNCH_REQUEST_STAGES },
        })
            .select('date')
            .lean(),
    ]);
    const dates = [];
    for (const row of rows || []) {
        const rowPool = approvalEventPool(row, { countOpenPunch: String(row?.date || '') < today });
        if (rowPool === 'mispunch') dates.push(String(row.date || ''));
    }
    for (const request of requests || []) dates.push(String(request.date || ''));
    return [...new Set(dates.filter(validDay))];
}

export async function attendanceApprovalLimitMessageFor(employee, { pool, requestDates }) {
    const dates = [...new Set((requestDates || []).map((date) => String(date || '').trim()).filter(Boolean))];
    if (!dates.length || (pool !== 'late' && pool !== 'mispunch')) return '';

    const employeeId = String(employee?._id || '');
    let person = employee;
    if (!person?.staffType || !person?.employeeId) {
        person = await EmployeeBasic.findById(employeeId).select('_id employeeId staffType').lean();
    }
    if (!person) return '';

    const policy = await resolveEmployeePayrollPolicy(person);
    const allowed = allowedApprovalEvents(policy, pool);
    if (allowed == null) return '';

    const months = [...new Set(dates.map((date) => date.slice(0, 7)))].sort();
    const from = `${months[0]}-01`;
    const to = monthEnd(months[months.length - 1]);
    const today = todayKey();
    const existingDates = pool === 'mispunch'
        ? await mispunchDatesForEmployee(person, from, to, today)
        : await poolDatesForEmployee(person, from, to, today, pool);

    const block = approvalAllowanceBlock({ allowed, existingDates, requestDates: dates });
    if (!block) return '';
    return attendanceApprovalLimitText({ pool, taken: block.taken, allowed: block.allowed });
}

/** Monthly missed-punch events already on record, and the salary-policy count. */
export async function loadMispunchMonthAllowance(employee, dateKey) {
    const date = String(dateKey || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'A valid date is required.' };

    const employeeId = String(employee?._id || employee?.employeeMongoId || '').trim();
    let person = employee;
    if (!person?.staffType || !person?.employeeId) {
        person = await EmployeeBasic.findById(employeeId).select('_id employeeId staffType').lean();
    }
    if (!person?._id) return { error: 'Employee not found.' };

    const policy = await resolveEmployeePayrollPolicy(person);
    const allowed = allowedApprovalEvents(policy, 'mispunch');
    const month = date.slice(0, 7);
    const unique = await mispunchDatesForEmployee(person, `${month}-01`, monthEnd(month), todayKey());
    return {
        month,
        used: unique.length,
        allowed,
        includesDate: unique.includes(date),
    };
}
