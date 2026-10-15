import { isLeaveDashboardAttendanceRow } from './notifyLeaveDashboardRequest.js';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function dateKeyOf(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString().slice(0, 10);
    }
    const text = String(value || '').trim();
    if (DATE_KEY.test(text)) return text;
    const prefix = text.slice(0, 10);
    return DATE_KEY.test(prefix) ? prefix : '';
}

function nextDateKey(dateKey) {
    const [year, month, day] = String(dateKey).split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + 1, 12, 0, 0));
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

function daysBetweenInclusive(from, to) {
    if (!from || !to || to < from) return 0;
    let count = 0;
    for (let cursor = from; cursor <= to; cursor = nextDateKey(cursor)) {
        count += 1;
        if (count > 400) break;
    }
    return count;
}

function formatDayMonthYear(dateKey) {
    if (!DATE_KEY.test(dateKey)) return '';
    const [year, month, day] = dateKey.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
    });
}

function formatShortRange(fromKey, toKey) {
    if (!DATE_KEY.test(fromKey)) return '';
    const [year, month, fromDay] = fromKey.split('-').map(Number);
    const monthLabel = new Date(Date.UTC(year, month - 1, fromDay)).toLocaleDateString('en-GB', {
        month: 'short',
        timeZone: 'UTC',
    });
    if (!toKey || toKey === fromKey || !DATE_KEY.test(toKey)) return `${fromDay} ${monthLabel}`;
    const toDay = Number(toKey.slice(8, 10));
    const days = daysBetweenInclusive(fromKey, toKey);
    return `${fromDay}-${toDay} ${monthLabel} - ${days} day${days === 1 ? '' : 's'}`;
}

function daysAgoCount(fromKey, todayKey) {
    if (!DATE_KEY.test(fromKey) || !DATE_KEY.test(todayKey)) return 0;
    return Math.max(0, daysBetweenInclusive(fromKey, todayKey) - 1);
}

function daysAgoLabel(fromKey, todayKey) {
    const days = daysAgoCount(fromKey, todayKey);
    if (!DATE_KEY.test(fromKey) || !DATE_KEY.test(todayKey)) return '';
    if (days <= 0) return 'Today';
    if (days === 1) return '1 day';
    return `${days} days`;
}

function rangeTouchesYear(fromKey, toKey, yearFrom, yearTo) {
    if (!yearFrom || !yearTo) return true;
    const start = DATE_KEY.test(fromKey) ? fromKey : '';
    const end = DATE_KEY.test(toKey) ? toKey : start;
    if (!start) return true;
    return end >= yearFrom && start <= yearTo;
}

function markHref({ date, staffType, employeeMongoId, requestId, requestParam }) {
    const params = new URLSearchParams();
    if (DATE_KEY.test(date)) params.set('date', date);
    params.set('staffType', String(staffType || 'office').trim() || 'office');
    const employee = String(employeeMongoId || '').trim();
    if (employee) params.set('blinkEmployee', employee);
    const id = String(requestId || '').trim();
    if (id && requestParam) params.set(requestParam, id);
    const query = params.toString();
    return query ? `/HRM/Attendance/mark?${query}` : '/HRM/Attendance/mark';
}

function leaveHref(row, staffType) {
    const from = dateKeyOf(row.leaveRequestFromDate) || dateKeyOf(row.date);
    const to = dateKeyOf(row.leaveRequestToDate) || from;
    if (isLeaveDashboardAttendanceRow(row)) {
        const params = new URLSearchParams();
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        if (row._id) params.set('approvalId', String(row._id));
        const query = params.toString();
        return query ? `/HRM/Leave/annual-leave?${query}` : '/HRM/Leave/annual-leave';
    }
    return markHref({
        date: dateKeyOf(row.date) || from,
        staffType,
        employeeMongoId: row.employeeMongoId,
        requestId: row._id,
        requestParam: 'leaveAttendanceId',
    });
}

function leaveTitle(row) {
    const kind = String(row?.leaveRequestKind || '').trim();
    const requested = String(row?.requestedStatusKey || '').trim();
    if (kind === 'future_annual' || requested === 'on_leave') return 'Annual leave request';
    if (kind === 'future_leave' || requested === 'authorized_leave') return 'Authorized leave request';
    if (requested === 'sick_leave') return 'Sick leave request';
    if (requested === 'compoff_leave') return 'Comp off request';
    if (requested === 'unauthorized_leave') return 'Unauthorized leave request';
    if (kind === 'future_late' || kind === 'past_late' || requested === 'late_arrived') return 'Late arrival request';
    if (kind === 'future_early' || requested === 'early_go') return 'Early go request';
    if (kind === 'yellow' || requested === 'mispunch') return 'Attendance Leave Request';
    return 'Attendance Leave Request';
}

function leaveAppliedKey(row) {
    const kind = String(row?.leaveRequestKind || '').trim();
    const requested = String(row?.requestedStatusKey || '').trim();
    if (kind === 'yellow' || requested === 'mispunch') return 'mispunch';
    if (kind === 'future_late' || kind === 'past_late' || requested === 'late_arrived') return 'late_arrived';
    if (kind === 'future_early' || requested === 'early_go') return 'early_go';
    if (requested === 'on_leave' || kind === 'future_annual') return 'on_leave';
    if (requested === 'sick_leave') return 'sick_leave';
    if (requested === 'compoff_leave') return 'compoff_leave';
    if (requested === 'unauthorized_leave') return 'unauthorized_leave';
    return 'authorized_leave';
}

function changeReference(row) {
    const label = String(row?.proposed?.statusLabel || '').trim();
    if (row?.action === 'hour_adjust') return label || 'Hour approval';
    if (row?.action === 'flexible_ot') return label || 'Apply OT';
    const from = String(row?.previous?.statusLabel || 'Not marked').trim() || 'Not marked';
    const to =
        row?.action === 'map'
            ? `Mapped punches (${label || 'Updated'})`
            : label || 'Updated';
    const times = [row?.proposed?.timeIn, row?.proposed?.timeOut]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .join(' – ');
    return `${from} → ${to}${times ? ` (${times})` : ''}`;
}

function changeOwner(row, { reportsTo, hrName }) {
    if (row?.stage === 'pending_hr') return String(row.hrName || hrName || 'HR').trim() || 'HR';
    if (row?.stage === 'pending_requester') {
        return String(row.requestedByName || 'Requester').trim() || 'Requester';
    }
    return String(row.reporteeName || reportsTo || 'Primary reportee').trim() || 'Primary reportee';
}

function changeStatus(stage) {
    if (stage === 'pending_hr') return 'Waiting for HR';
    if (stage === 'pending_requester') return 'Waiting for requester';
    return 'Waiting for primary reportee';
}

function withAge(item, todayKey) {
    const anchor = item.dateKey || item.fromDate;
    return {
        ...item,
        dateLabel: formatDayMonthYear(anchor),
        badge: daysAgoLabel(anchor, todayKey),
        daysAgo: daysAgoCount(anchor, todayKey),
    };
}

/**
 * Open leave, hour, overtime, and attendance-change requests that block salary.
 * Leave-dashboard rows and the attendance bell use different stores; both belong here.
 */
export function buildSalaryPreparationPending({
    attendanceRows = [],
    changeRows = [],
    reportsTo = '',
    hrName = '',
    staffType = 'office',
    todayKey = '',
    yearFrom = '',
    yearTo = '',
} = {}) {
    const people = { reportsTo, hrName };
    const coveredHours = new Set();
    const coveredOt = new Set();
    const items = [];

    for (const row of changeRows || []) {
        const date = dateKeyOf(row?.date);
        if (!rangeTouchesYear(date, date, yearFrom, yearTo)) continue;
        const action = String(row?.action || 'mark').trim();
        if (action === 'hour_adjust' && date) coveredHours.add(date);
        if (action === 'flexible_ot' && date) coveredOt.add(date);
        const requestedKey = dateKeyOf(row?.createdAt) || date;
        const hour = action === 'hour_adjust';
        items.push(
            withAge(
                {
                    id: `change-${row._id}`,
                    title: hour ? 'Hour Approval Request' : 'Attendance Change Request',
                    subtitle: changeReference(row),
                    appliedKey: hour ? 'hour_adjust' : 'attendance_change',
                    status: changeStatus(row?.stage),
                    owner: changeOwner(row, people),
                    fromDate: date,
                    toDate: date,
                    dateKey: requestedKey,
                    href: markHref({
                        date,
                        staffType: row?.staffType || staffType,
                        employeeMongoId: row?.employeeMongoId,
                        requestId: row?._id,
                        requestParam: 'changeRequestId',
                    }),
                },
                todayKey,
            ),
        );
    }

    const leaveGroups = new Map();
    for (const row of attendanceRows || []) {
        if (String(row?.leaveRequestStatus || '').trim() !== 'pending') continue;
        const fromDate = dateKeyOf(row.leaveRequestFromDate) || dateKeyOf(row.date);
        const toDate = dateKeyOf(row.leaveRequestToDate) || dateKeyOf(row.date) || fromDate;
        if (!rangeTouchesYear(fromDate, toDate, yearFrom, yearTo)) continue;
        const groupId =
            String(row.leaveRequestGroupId || '').trim() ||
            `${row.date}-${String(row.leaveRequestKind || '')}`;
        const requestedAtKey = dateKeyOf(row.leaveRequestedAt) || fromDate;
        const existing = leaveGroups.get(groupId);
        if (!existing) {
            leaveGroups.set(groupId, {
                row,
                fromDate,
                toDate,
                requestedAtKey,
            });
            continue;
        }
        if (fromDate && (!existing.fromDate || fromDate < existing.fromDate)) existing.fromDate = fromDate;
        if (toDate && (!existing.toDate || toDate > existing.toDate)) existing.toDate = toDate;
        if (requestedAtKey && requestedAtKey < existing.requestedAtKey) {
            existing.requestedAtKey = requestedAtKey;
            existing.row = row;
        }
    }

    for (const [groupId, group] of leaveGroups) {
        const source = group.row;
        items.push(
            withAge(
                {
                    id: `leave-${groupId}`,
                    title: leaveTitle(source),
                    subtitle: formatShortRange(group.fromDate, group.toDate) || 'Awaiting approval',
                    appliedKey: leaveAppliedKey(source),
                    status: '',
                    owner: String(reportsTo || 'Primary reportee').trim() || 'Primary reportee',
                    fromDate: group.fromDate,
                    toDate: group.toDate,
                    dateKey: group.requestedAtKey || group.fromDate,
                    href: leaveHref(source, staffType),
                    spanAllMonths: true,
                },
                todayKey,
            ),
        );
    }

    for (const row of attendanceRows || []) {
        const date = dateKeyOf(row?.date);
        if (!rangeTouchesYear(date, date, yearFrom, yearTo)) continue;
        if (String(row?.hourAdjustStatus || '').trim() === 'pending' && !coveredHours.has(date)) {
            const hours = Number(row.hoursApproved) || 0;
            items.push(
                withAge(
                    {
                        id: `hour-${row._id}`,
                        title: 'Hour Approval Request',
                        subtitle: hours ? `${hours} hr` : formatShortRange(date, date) || 'Hour approval',
                        appliedKey: 'hour_adjust',
                        status: 'Approval Pending',
                        owner: String(hrName || 'HR').trim() || 'HR',
                        fromDate: date,
                        toDate: date,
                        dateKey: dateKeyOf(row.createdAt) || date,
                        href: markHref({
                            date,
                            staffType,
                            employeeMongoId: row.employeeMongoId,
                            requestId: row._id,
                            requestParam: 'hourAttendanceId',
                        }),
                    },
                    todayKey,
                ),
            );
        }
        if (String(row?.flexibleOtStatus || '').trim() === 'pending' && !coveredOt.has(date)) {
            const hours = Number(row.flexibleOtApprovedHours) || 0;
            items.push(
                withAge(
                    {
                        id: `ot-${row._id}`,
                        title: 'Flexible OT Request',
                        subtitle: hours ? `Apply OT ${hours} hr` : 'Apply OT',
                        appliedKey: 'flexible_ot',
                        status: 'Waiting for HR',
                        owner: String(hrName || 'HR').trim() || 'HR',
                        fromDate: date,
                        toDate: date,
                        dateKey: dateKeyOf(row.createdAt) || date,
                        href: markHref({
                            date,
                            staffType,
                            employeeMongoId: row.employeeMongoId,
                            requestId: row._id,
                            requestParam: 'otAttendanceId',
                        }),
                    },
                    todayKey,
                ),
            );
        }
    }

    return items.sort((a, b) => String(b.dateKey || '').localeCompare(String(a.dateKey || '')));
}
