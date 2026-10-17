import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { resolveEmployeePayrollPolicy } from './employeeLeavePolicy.js';
import { lateDeductMultiplier, missedPunchRuleOf, sharedLateRule } from './lateDeductionPolicy.js';
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

/**
 * Late arrival and early go share one monthly count.
 * Missed punch has its own count.
 */
export function approvalEventPool(row, { countOpenPunch = false } = {}) {
    const kind = punchAttendanceKind(row);
    if (kind === 'mispunch') return 'mispunch';
    if (kind === 'late_arrived' || kind === 'early_go') return 'late';
    const key = String(row?.statusKey || '').trim();
    if (key === 'mispunch') return 'mispunch';
    if (key === 'late_arrived' || key === 'early_go') return 'late';
    const pending = String(row?.leaveRequestStatus || '').trim() === 'pending';
    const requestKind = String(row?.leaveRequestKind || '').trim();
    if (pending && (requestKind === 'future_late' || requestKind === 'past_late')) return 'late';
    if (pending && requestKind === 'future_early') return 'late';
    const openPunch = Boolean(String(row?.timeIn || '').trim()) && !String(row?.timeOut || '').trim();
    if (
        countOpenPunch &&
        openPunch &&
        ['on_office', 'work_from_home', 'not_marked', 'late_arrived'].includes(key)
    ) {
        return 'mispunch';
    }
    return '';
}

export function allowedApprovalEvents(policy, pool) {
    const rule = pool === 'mispunch' ? missedPunchRuleOf(policy) : sharedLateRule(policy);
    if (lateDeductMultiplier(rule) <= 0) return null;
    const events = Number(rule?.events);
    if (!Number.isFinite(events) || events < 0) return 0;
    return Math.floor(events);
}

/**
 * Block when this request would put the month above the salary-policy event count.
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
    const rows = await Attendance.find({
        employeeMongoId: String(person._id || employeeId),
        date: { $gte: from, $lte: to },
    })
        .select(
            'date statusKey statusLabel reason timeIn timeOut leaveRequestStatus leaveRequestKind leaveRequestSession hourAdjustStatus hourAdjustKind',
        )
        .lean();

    const existingDates = [];
    for (const row of rows || []) {
        const rowPool = approvalEventPool(row, { countOpenPunch: String(row?.date || '') < today });
        if (rowPool === pool) existingDates.push(String(row.date || ''));
    }

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
    const today = todayKey();
    const rows = await Attendance.find({
        employeeMongoId: String(person._id),
        date: { $gte: `${month}-01`, $lte: monthEnd(month) },
    })
        .select(
            'date statusKey statusLabel reason timeIn timeOut leaveRequestStatus leaveRequestKind leaveRequestSession hourAdjustStatus hourAdjustKind',
        )
        .lean();

    const dates = [];
    for (const row of rows || []) {
        const pool = approvalEventPool(row, { countOpenPunch: String(row?.date || '') < today });
        if (pool === 'mispunch') dates.push(String(row.date || ''));
    }
    const unique = [...new Set(dates.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)))];
    return {
        month,
        used: unique.length,
        allowed,
        includesDate: unique.includes(date),
    };
}
