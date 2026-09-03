import SalaryHistoricalProfile from '../models/SalaryHistoricalProfile.js';
import {
    addDays,
    INACTIVE_LEAVE,
    inclusiveCalendarDays,
    isCountOnlyLeaveType,
    isDateKey,
    normalizeLeaveSourceKey,
} from './salaryHistoricalCalculations.js';

export const ENROLLMENT_LEAVE_STATUS = {
    sick: 'sick_leave',
    authorized: 'authorized_leave',
    unauthorized: 'unauthorized_leave',
    annual: 'on_leave',
};

export const ENROLLMENT_LEAVE_LABEL = {
    sick_leave: 'Sick Leave',
    authorized_leave: 'Authorized Leave',
    unauthorized_leave: 'Unauthorized Leave',
    on_leave: 'Annual leave',
};

const LEAVE_STATUS_KEYS = new Set(Object.values(ENROLLMENT_LEAVE_STATUS));

function emptyLeaveCounts() {
    return {
        on_leave: 0,
        sick_leave: 0,
        authorized_leave: 0,
        unauthorized_leave: 0,
    };
}

function rowId(row, type, start, end) {
    return String(row?._id || row?.id || `${type}-${start}-${end}`);
}

function storedDays(row) {
    return Math.max(
        0,
        Number(row?.eligibleWorkingDays ?? row?.actualDays ?? row?.calendarDays) || 0,
    );
}

function clipRange(start, end, from, to) {
    const a = isDateKey(from) && start < from ? from : start;
    const b = isDateKey(to) && end > to ? to : end;
    if (!a || !b || b < a) return null;
    return { start: a, end: b };
}

function collectManualLeaveRows(profile) {
    const leave = Array.isArray(profile?.leaveRecords) ? profile.leaveRecords : [];
    const annual = (Array.isArray(profile?.annualLeaveRecords) ? profile.annualLeaveRecords : []).map(
        (row) => ({
            ...row,
            leaveType: 'annual',
            fromDate: row.fromDate || row.startDate,
            toDate: row.toDate || row.endDate,
        }),
    );
    return [...leave, ...annual].filter((row) => {
        if (normalizeLeaveSourceKey(row?.source) === 'system') return false;
        const status = String(row?.status || 'approved').toLowerCase();
        return !INACTIVE_LEAVE.has(status);
    });
}

function datedLeaveDays(row, fullStart, fullEnd, clipStart, clipEnd) {
    const stored = storedDays(row);
    const totalCal = inclusiveCalendarDays(fullStart, fullEnd) || 1;
    const clipCal = inclusiveCalendarDays(clipStart, clipEnd) || 0;
    if (clipCal <= 0) return 0;
    if (stored > 0) return Math.max(1, Math.round(stored * (clipCal / totalCal)));
    return clipCal;
}

function eachDateKey(start, end, onDate) {
    if (!isDateKey(start) || !isDateKey(end) || end < start) return;
    let guard = 0;
    for (let cursor = start; cursor && cursor <= end; cursor = addDays(cursor, 1)) {
        onDate(cursor);
        guard += 1;
        if (guard > 400) break;
    }
}

/**
 * Convert salary-enrollment manual leave into attendance-shaped counts, modal
 * entries, and calendar days. System leave is skipped so live Attendance is
 * not double-counted.
 */
export function overlayHistoricalLeave(profile, { from = '', to = '', includeCountOnly = true } = {}) {
    const extraCounts = emptyLeaveCounts();
    const entries = [];
    const calendarRecords = [];

    for (const row of collectManualLeaveRows(profile)) {
        const type = String(row?.leaveType || '').toLowerCase();
        const statusKey = ENROLLMENT_LEAVE_STATUS[type];
        if (!statusKey) continue;

        const start = String(row.fromDate || row.startDate || '').trim();
        const end = String(row.toDate || row.endDate || start).trim();
        const hasDates = isDateKey(start) && isDateKey(end) && end >= start;
        const id = rowId(row, type, start, end);
        const remarks = String(row.remarks || '').trim();

        if (hasDates) {
            const clip = clipRange(start, end, from, to);
            if (!clip) continue;
            const days = datedLeaveDays(row, start, end, clip.start, clip.end);
            if (days <= 0) continue;
            extraCounts[statusKey] += days;
            entries.push({
                date: clip.start,
                statusKey,
                statusLabel: ENROLLMENT_LEAVE_LABEL[statusKey],
                leavePayType: '',
                leaveRequestStatus: 'approved',
                leaveRequestKind: 'historical',
                leaveRequestGroupId: `historical-${id}`,
                fromDate: clip.start,
                toDate: clip.end,
                leaveRequestFromDate: clip.start,
                leaveRequestToDate: clip.end,
                reason: remarks,
                source: 'Salary enrollment',
                days,
                countOnly: false,
                historical: true,
            });
            eachDateKey(clip.start, clip.end, (date) => {
                calendarRecords.push({
                    _id: `historical-${id}-${date}`,
                    date,
                    statusKey,
                    statusLabel: ENROLLMENT_LEAVE_LABEL[statusKey],
                    reason: remarks || 'Salary enrollment',
                    leavePayType: '',
                    leaveRequestStatus: 'approved',
                    leaveRequestKind: 'historical',
                    leaveRequestGroupId: `historical-${id}`,
                    leaveRequestFromDate: clip.start,
                    leaveRequestToDate: clip.end,
                    requestedStatusKey: statusKey,
                    requestedStatusLabel: ENROLLMENT_LEAVE_LABEL[statusKey],
                    historical: true,
                    source: 'Salary enrollment',
                });
            });
            continue;
        }

        if (!includeCountOnly || (!isCountOnlyLeaveType(type) && type !== 'sick')) continue;
        const days = storedDays(row);
        if (days <= 0) continue;
        extraCounts[statusKey] += days;
        entries.push({
            date: '',
            statusKey,
            statusLabel: ENROLLMENT_LEAVE_LABEL[statusKey],
            leavePayType: '',
            leaveRequestStatus: 'approved',
            leaveRequestKind: 'historical',
            leaveRequestGroupId: `historical-count-${id}`,
            fromDate: '',
            toDate: '',
            leaveRequestFromDate: '',
            leaveRequestToDate: '',
            reason: remarks,
            source: 'Salary enrollment',
            days,
            countOnly: true,
            historical: true,
        });
    }

    return { extraCounts, entries, calendarRecords };
}

export function mergeHistoricalCalendarRecords(records, overlayRecords) {
    const out = [];
    const byDate = new Map();
    for (const row of records || []) {
        out.push(row);
        const date = String(row?.date || '').trim();
        if (date) byDate.set(date, row);
    }
    for (const row of overlayRecords || []) {
        const date = String(row?.date || '').trim();
        if (!date || byDate.has(date)) continue;
        out.push(row);
        byDate.set(date, row);
    }
    return out;
}

export function applyOverlayCounts(counts, extraCounts) {
    const next = { ...(counts || {}) };
    for (const [statusKey, extra] of Object.entries(extraCounts || {})) {
        const days = Number(extra) || 0;
        if (days <= 0) continue;
        next[statusKey] = (Number(next[statusKey]) || 0) + days;
    }
    return next;
}

export function applyOverlayCountsToBalances(leaveBalances, extraCounts) {
    const next = { ...(leaveBalances || {}) };
    for (const [statusKey, extra] of Object.entries(extraCounts || {})) {
        const days = Number(extra) || 0;
        if (days <= 0) continue;
        const row = { ...(next[statusKey] || {}) };
        const taken = (Number(row.taken) || 0) + days;
        const pending = Number(row.pending) || 0;
        row.taken = taken;
        if (row.allowed != null) {
            row.remaining = Math.max(0, Number(row.allowed) - taken - pending);
        }
        const multiplier = Number(row.multiplier) || 1;
        row.deductionDays = Number((taken * multiplier).toFixed(2));
        next[statusKey] = row;
    }
    return next;
}

export function lastOverlayAnnualLeaveDate(entries, fallback = '') {
    let last = String(fallback || '');
    for (const row of entries || []) {
        if (String(row?.statusKey || '') !== 'on_leave') continue;
        const end = String(row.toDate || row.date || '').trim();
        if (isDateKey(end) && end > last) last = end;
    }
    return last;
}

export function isHistoricalLeaveEntry(entry) {
    if (!entry) return false;
    if (entry.historical === true || entry.countOnly === true) return true;
    if (String(entry.leaveRequestKind || '').trim() === 'historical') return true;
    return String(entry.source || '').trim().toLowerCase() === 'salary enrollment';
}

export async function loadHistoricalLeaveProfile(employeeId) {
    const code = String(employeeId || '').trim();
    if (!code) return null;
    return SalaryHistoricalProfile.findOne({ employeeId: code })
        .select('leaveRecords annualLeaveRecords')
        .lean();
}

export async function loadHistoricalLeaveProfilesByEmployeeId(employeeIds) {
    const codes = [
        ...new Set((employeeIds || []).map((id) => String(id || '').trim()).filter(Boolean)),
    ];
    if (!codes.length) return new Map();
    const rows = await SalaryHistoricalProfile.find({ employeeId: { $in: codes } })
        .select('employeeId leaveRecords annualLeaveRecords')
        .lean()
        .maxTimeMS(12000);
    return new Map((rows || []).map((row) => [String(row.employeeId || '').trim(), row]));
}

export function overlayAttendanceRowsForEmployee({
    profile,
    employee,
    from,
    to,
    statusKeys,
    includeCountOnly = false,
}) {
    const overlay = overlayHistoricalLeave(profile, { from, to, includeCountOnly });
    const allowed = statusKeys instanceof Set ? statusKeys : statusKeys ? new Set(statusKeys) : null;
    const mongoId = String(employee?._id || employee?.employeeMongoId || '');
    const employeeId = String(employee?.employeeId || '').trim();
    const employeeName = String(
        employee?.employeeName ||
            [employee?.firstName, employee?.lastName].filter(Boolean).join(' '),
    ).trim();
    return overlay.calendarRecords
        .filter((row) => !allowed || allowed.has(row.statusKey))
        .map((row) => ({
            ...row,
            employeeMongoId: mongoId,
            employeeId,
            employeeName,
        }));
}

export function addOverlayCountsForEmployees({ profilesByCode, employees, from, to, countsByEmp }) {
    const next = countsByEmp || {};
    for (const employee of employees || []) {
        const code = String(employee?.employeeId || '').trim();
        const profile = profilesByCode?.get(code);
        if (!profile) continue;
        const overlay = overlayHistoricalLeave(profile, { from, to, includeCountOnly: true });
        const id = String(employee._id);
        if (!next[id]) next[id] = {};
        for (const [statusKey, days] of Object.entries(overlay.extraCounts)) {
            if (!LEAVE_STATUS_KEYS.has(statusKey) || !days) continue;
            next[id][statusKey] = (next[id][statusKey] || 0) + days;
        }
    }
    return next;
}
