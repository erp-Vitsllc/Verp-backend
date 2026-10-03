import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import {
    isCompanyShellEmployee,
    REAL_EMPLOYEE_MONGO_FILTER,
} from './attendanceEmployeeFilters.js';
import {
    loadHistoricalLeaveProfile,
    loadHistoricalLeaveProfilesByEmployeeId,
    overlayAttendanceRowsForEmployee,
    overlayHistoricalLeave,
} from './historicalLeaveAttendanceOverlay.js';
import { addDays } from './salaryHistoricalCalculations.js';

/** Leave that owns the day. A no-punch Absent / Unauthorized mark must not hide it. */
export const LEAVE_COVER_KEYS = new Set([
    'on_leave',
    'authorized_leave',
    'sick_leave',
    'compoff_leave',
]);

export const LEAVE_COVER_LABEL = {
    on_leave: 'Annual Leave',
    authorized_leave: 'Authorized Leave',
    sick_leave: 'Sick Leave',
    compoff_leave: 'Comp Off Leave',
};

const AUTO_ABSENT_REASON = /no punch-in or punch-out/i;

function isDateKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function eachDateKey(start, end) {
    const from = String(start || '').trim();
    const to = String(end || '').trim();
    if (!isDateKey(from) || !isDateKey(to) || to < from) return [];
    const dates = [];
    let cursor = from;
    let guard = 0;
    while (cursor && cursor <= to && guard < 400) {
        dates.push(cursor);
        if (cursor === to) break;
        cursor = addDays(cursor, 1);
        guard += 1;
    }
    return dates;
}

export function coverKey(employeeMongoId, date) {
    return `${String(employeeMongoId || '').trim()}|${String(date || '').trim()}`;
}

function cleanReason(value) {
    const text = String(value || '').trim();
    if (!text || /^salary enrollment$/i.test(text) || AUTO_ABSENT_REASON.test(text)) return '';
    return text;
}

function hasPunch(row) {
    return Boolean(String(row?.timeIn || '').trim() || String(row?.timeOut || '').trim());
}

/** No-punch Absent / Unauthorized / empty days can show the real leave instead. */
export function isAbsentAttendanceDay(row) {
    if (!row) return true;
    if (hasPunch(row)) return false;
    const key = String(row.statusKey || '').trim();
    return key === '' || key === 'not_marked' || key === 'absent' || key === 'unauthorized_leave';
}

function coverRank(cover) {
    if (!cover) return 0;
    if (cover.source === 'scheduled' && !cover.isPending) return 3;
    if (cover.isPending) return 2;
    return 1;
}

/** Approved attendance leave wins, then a pending request, then salary enrollment. */
export function chooseLeaveCover(current, incoming) {
    if (!incoming) return current || null;
    if (!current) return incoming;
    return coverRank(incoming) > coverRank(current) ? incoming : current;
}

export function leaveCoverFromAttendanceRow(row) {
    if (!row) return null;
    const requestStatus = String(row.leaveRequestStatus || '').trim();
    if (requestStatus !== 'approved' && requestStatus !== 'pending') return null;
    const statusKey = String(row.requestedStatusKey || '').trim();
    if (!LEAVE_COVER_KEYS.has(statusKey)) return null;
    return {
        employeeMongoId: String(row.employeeMongoId || ''),
        employeeId: String(row.employeeId || ''),
        employeeName: String(row.employeeName || ''),
        date: String(row.date || ''),
        statusKey,
        statusLabel: LEAVE_COVER_LABEL[statusKey] || row.requestedStatusLabel || statusKey,
        leaveRequestStatus: requestStatus,
        requestedStatusKey: statusKey,
        requestedStatusLabel: row.requestedStatusLabel || LEAVE_COVER_LABEL[statusKey] || '',
        leaveRequestKind: String(row.leaveRequestKind || ''),
        leaveRequestGroupId: String(row.leaveRequestGroupId || ''),
        leaveRequestFromDate: String(row.leaveRequestFromDate || row.date || ''),
        leaveRequestToDate: String(row.leaveRequestToDate || row.date || ''),
        reason: cleanReason(row.leaveRequestReason),
        source: 'scheduled',
        isPending: requestStatus === 'pending',
        historical: false,
    };
}

function coverFromEnrollmentRow(employee, row) {
    const statusKey = String(row?.statusKey || '').trim();
    if (!LEAVE_COVER_KEYS.has(statusKey)) return null;
    const id = String(employee?._id || row?.employeeMongoId || '');
    return {
        employeeMongoId: id,
        employeeId: String(employee?.employeeId || row?.employeeId || ''),
        employeeName:
            String(row?.employeeName || '').trim() ||
            [employee?.firstName, employee?.lastName].filter(Boolean).join(' ').trim(),
        date: String(row.date || ''),
        statusKey,
        statusLabel: LEAVE_COVER_LABEL[statusKey] || row.statusLabel || statusKey,
        leaveRequestStatus: 'approved',
        requestedStatusKey: statusKey,
        requestedStatusLabel: LEAVE_COVER_LABEL[statusKey] || '',
        leaveRequestKind: '',
        leaveRequestGroupId: String(row.leaveRequestGroupId || ''),
        leaveRequestFromDate: String(row.leaveRequestFromDate || row.date || ''),
        leaveRequestToDate: String(row.leaveRequestToDate || row.date || ''),
        reason: cleanReason(row.reason),
        source: 'enrollment',
        isPending: false,
        historical: true,
    };
}

function rememberCover(index, cover) {
    if (!cover?.employeeMongoId || !isDateKey(cover.date)) return;
    if (!LEAVE_COVER_KEYS.has(cover.statusKey)) return;
    const key = coverKey(cover.employeeMongoId, cover.date);
    index.set(key, chooseLeaveCover(index.get(key), cover));
}

function addEnrollmentProfile(index, employee, profile, from, to) {
    if (!employee || !profile) return;
    const rows = overlayAttendanceRowsForEmployee({
        profile,
        employee,
        from,
        to,
        statusKeys: LEAVE_COVER_KEYS,
        includeCountOnly: false,
    });
    for (const row of rows) {
        rememberCover(index, coverFromEnrollmentRow(employee, row));
    }
}

function paintLeaveOntoRow(row, cover, dateKey) {
    const date = String(dateKey || row?.date || cover.date || '');
    const base = row
        ? { ...row }
        : {
              _id: '',
              date,
              employeeMongoId: cover.employeeMongoId,
              employeeId: cover.employeeId || '',
              employeeName: cover.employeeName || '',
              timeIn: '',
              timeOut: '',
          };
    const coverReason = cleanReason(cover.reason);
    return {
        ...base,
        date: base.date || date,
        statusKey: cover.statusKey,
        statusLabel: LEAVE_COVER_LABEL[cover.statusKey] || cover.statusLabel || cover.statusKey,
        leaveRequestStatus: cover.leaveRequestStatus || (cover.isPending ? 'pending' : 'approved'),
        requestedStatusKey: cover.requestedStatusKey || cover.statusKey,
        requestedStatusLabel: cover.requestedStatusLabel || LEAVE_COVER_LABEL[cover.statusKey] || '',
        leaveRequestFromDate: cover.leaveRequestFromDate || base.leaveRequestFromDate || '',
        leaveRequestToDate: cover.leaveRequestToDate || base.leaveRequestToDate || '',
        leaveRequestGroupId: cover.leaveRequestGroupId || base.leaveRequestGroupId || '',
        leaveRequestKind: cover.leaveRequestKind || base.leaveRequestKind || '',
        reason: coverReason || cleanReason(base.reason),
        approvalStatus: cover.isPending ? base.approvalStatus || '' : 'approved',
        historical: Boolean(cover.historical),
        leaveCoverSource: cover.source || '',
    };
}

function applyCoverToRow(row, externalCover, dateKey) {
    const own = leaveCoverFromAttendanceRow(row);
    const cover = chooseLeaveCover(own, externalCover);
    if (!cover) return row;
    if (row && !isAbsentAttendanceDay(row)) return row;
    return paintLeaveOntoRow(row, cover, dateKey || cover.date || row?.date);
}

/**
 * Replace Absent / Unauthorized days with the leave that already covers them.
 * Days with a punch, or any other status, stay as stored.
 * Missing days get a display row so Mark Attendance does not fall back to Absent.
 */
export function applyLeaveCoverIndex(records, coverIndex, { fillMissing = true } = {}) {
    const index = coverIndex instanceof Map ? coverIndex : new Map();
    const seen = new Set();
    const out = [];
    for (const row of records || []) {
        const id = String(row?.employeeMongoId || '');
        const date = String(row?.date || '');
        const key = coverKey(id, date);
        if (id && date) seen.add(key);
        const painted = applyCoverToRow(row, index.get(key), date);
        if (painted) out.push(painted);
    }
    if (!fillMissing) return out;
    for (const [key, cover] of index) {
        if (seen.has(key)) continue;
        const painted = applyCoverToRow(null, cover, cover.date);
        if (painted) out.push(painted);
    }
    return out;
}

export function enrollmentCoveredDateSet(profile, from, to) {
    const dates = new Set();
    if (!profile) return dates;
    const overlay = overlayHistoricalLeave(profile, { from, to, includeCountOnly: false });
    for (const row of overlay.calendarRecords || []) {
        if (LEAVE_COVER_KEYS.has(String(row?.statusKey || ''))) dates.add(String(row.date || ''));
    }
    return dates;
}

export function enrollmentCoverIndexForEmployee(profile, employee, from, to) {
    const index = new Map();
    addEnrollmentProfile(index, employee, profile, from, to);
    return index;
}

/** Drop unauthorized salary days that are already annual / sick / authorized leave. */
export function omitUnauthorizedLeaveOnDates(leaveRecords, dates) {
    if (!dates || !dates.size) return leaveRecords || [];
    return (leaveRecords || []).filter((row) => {
        const type = String(row?.leaveType || '').trim().toLowerCase();
        if (type !== 'unauthorized') return true;
        const day = String(row?.fromDate || row?.startDate || row?.date || '').trim();
        return !dates.has(day);
    });
}

export async function applyEnrollmentMaskToLiveLeave({
    employeeId,
    from,
    to,
    leaveRecords,
    coveredDates,
}) {
    const profile = await loadHistoricalLeaveProfile(employeeId);
    const dates = enrollmentCoveredDateSet(profile, from, to);
    if (!dates.size) {
        return { leaveRecords: leaveRecords || [], coveredDates };
    }
    const nextCovered = new Set(coveredDates || []);
    for (const date of dates) nextCovered.add(date);
    return {
        leaveRecords: omitUnauthorizedLeaveOnDates(leaveRecords, dates),
        coveredDates: nextCovered,
    };
}

async function loadPeople(employees) {
    if (Array.isArray(employees)) {
        return employees.filter((emp) => emp && !isCompanyShellEmployee(emp));
    }
    const rows = await EmployeeBasic.find({
        profileStatus: 'active',
        status: { $ne: 'Left User' },
        employeeId: { $ne: 'VEGA-HR-0000' },
        ...REAL_EMPLOYEE_MONGO_FILTER,
    })
        .select('_id employeeId firstName lastName')
        .lean();
    return (rows || []).filter((emp) => !isCompanyShellEmployee(emp));
}

/**
 * Approved/pending attendance leave and salary-enrollment leave for each person-day.
 * Key: `${employeeMongoId}|yyyy-MM-dd`.
 */
export async function loadLeaveCoverIndex({ from, to, employees } = {}) {
    const index = new Map();
    const start = String(from || '').trim();
    const end = String(to || '').trim();
    if (!isDateKey(start) || !isDateKey(end) || end < start) return index;

    const people = await loadPeople(employees);
    if (!people.length) return index;
    const ids = people.map((emp) => String(emp._id)).filter(Boolean);
    const profiles = await loadHistoricalLeaveProfilesByEmployeeId(people.map((emp) => emp.employeeId));
    for (const emp of people) {
        addEnrollmentProfile(
            index,
            emp,
            profiles.get(String(emp.employeeId || '').trim()),
            start,
            end,
        );
    }

    const scheduled = await Attendance.find({
        employeeMongoId: { $in: ids },
        leaveRequestStatus: { $in: ['approved', 'pending'] },
        requestedStatusKey: { $in: [...LEAVE_COVER_KEYS] },
        leaveRequestFromDate: { $lte: end },
        leaveRequestToDate: { $gte: start },
    })
        .select(
            'employeeMongoId employeeId employeeName date requestedStatusKey requestedStatusLabel leaveRequestStatus leaveRequestKind leaveRequestGroupId leaveRequestFromDate leaveRequestToDate leaveRequestReason',
        )
        .lean();

    for (const row of scheduled || []) {
        const cover = leaveCoverFromAttendanceRow(row);
        if (!cover?.employeeMongoId) continue;
        const rangeStart = cover.leaveRequestFromDate > start ? cover.leaveRequestFromDate : start;
        const rangeEnd = cover.leaveRequestToDate < end ? cover.leaveRequestToDate : end;
        for (const date of eachDateKey(rangeStart, rangeEnd)) {
            rememberCover(index, { ...cover, date });
        }
    }

    return index;
}

export function coveredEmployeeIdsOnDate(coverIndex, dateKey) {
    const ids = new Set();
    const date = String(dateKey || '').trim();
    for (const cover of coverIndex?.values?.() || []) {
        if (cover?.date === date && cover.employeeMongoId) ids.add(String(cover.employeeMongoId));
    }
    return ids;
}
