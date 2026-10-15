import { inferLeaveApprovalStage, LEAVE_STAGE_HR, openingLeaveApprovalStage } from './leaveRequestApproval.js';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function dateKey(value) {
    const text = String(value || '').trim();
    return DATE_KEY.test(text) ? text : '';
}

function inWindow(day, from, to) {
    return Boolean(day) && (!from || day >= from) && (!to || day <= to);
}

/** Name of a leave, late, early, or missed-punch request that is still waiting. */
export function attendancePendingRequestLabel(row) {
    const kind = String(row?.leaveRequestKind || '').trim();
    const requested = String(row?.requestedStatusKey || '').trim();
    const label = String(row?.requestedStatusLabel || '').trim();
    if (kind === 'yellow' || requested === 'mispunch') return 'Missed punch request';
    if (kind === 'future_late' || kind === 'past_late' || requested === 'late_arrived') return 'Late in request';
    if (kind === 'future_early' || requested === 'early_go') return 'Early out request';
    if (kind === 'future_annual' || requested === 'on_leave') return 'Annual leave request';
    if (requested === 'sick_leave') return 'Sick leave request';
    if (requested === 'compoff_leave') return 'Comp off request';
    if (requested === 'unauthorized_leave') return 'Unauthorized leave request';
    if (kind === 'future_leave' || requested === 'authorized_leave') {
        return label ? `${label} request` : 'Authorized leave request';
    }
    if (label) return `${label} request`;
    return 'Leave request';
}

export function changeRequestLabel(row) {
    const action = String(row?.action || 'mark').trim();
    const proposed = String(row?.proposed?.statusLabel || '').trim();
    if (action === 'hour_adjust') return 'Hour approval request';
    if (action === 'flexible_ot') return 'Overtime request';
    if (action === 'map') return 'Map attendance request';
    if (action === 'clear') return 'Clear attendance request';
    if (proposed) return `${proposed} request`;
    return 'Attendance change request';
}

function named(value, fallback) {
    return String(value || '').trim() || fallback;
}

/** Person who must act on an open attendance-change request right now. */
export function changePendingWithName(row) {
    const stage = String(row?.stage || '').trim();
    if (stage === 'pending_hr') return named(row?.hrName, 'HR');
    if (stage === 'pending_requester') return named(row?.requestedByName, 'Requester');
    return named(row?.reporteeName, 'Primary reportee');
}

function approverOf(approversByEmployee, employeeId) {
    if (!approversByEmployee || typeof approversByEmployee.get !== 'function') return {};
    return approversByEmployee.get(String(employeeId || '').trim()) || {};
}

/** Person who must act on a pending leave, late, early, or missed-punch request. */
export function leavePendingWithName(row, approver = {}) {
    const stage = inferLeaveApprovalStage(row, {
        reporteeId: approver.reporteeId || '',
        hrId: approver.hrId || '',
    });
    if (stage === LEAVE_STAGE_HR) return named(approver.hrName, 'HR');
    return named(approver.reporteeName, 'Primary reportee');
}

function chainPendingWithName(approver = {}) {
    const stage = openingLeaveApprovalStage(approver.reporteeId || '', approver.hrId || '');
    if (stage === LEAVE_STAGE_HR) return named(approver.hrName, 'HR');
    return named(approver.reporteeName, 'Primary reportee');
}

/**
 * Days that still have an open attendance request.
 * Approved and rejected requests are left out. A next-day overtime date is not a second request.
 */
export function collectPendingCalendarRequests({
    attendanceRows = [],
    changeRows = [],
    employeeNames = new Map(),
    approversByEmployee = new Map(),
    from = '',
    to = '',
} = {}) {
    const byEmployee = new Map();
    const seen = new Set();
    const coveredChange = new Set();

    const add = (employeeId, date, label, requestedBy, pendingWith = '') => {
        const id = String(employeeId || '').trim();
        const day = dateKey(date);
        const name = String(label || '').trim();
        const person = String(requestedBy || '').trim() || 'Employee';
        const waiting = String(pendingWith || '').trim();
        if (!id || !day || !name || !inWindow(day, from, to)) return;
        const key = `${id}|${day}|${name.toLowerCase()}|${person.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (!byEmployee.has(id)) byEmployee.set(id, []);
        byEmployee.get(id).push({
            date: day,
            label: name,
            requestedBy: person,
            pendingWith: waiting,
        });
    };

    const personName = (employeeId, fallback) => {
        const named = employeeNames.get(String(employeeId || '').trim());
        return String(named || fallback || '').trim();
    };

    for (const row of changeRows || []) {
        const stage = String(row?.stage || '').trim();
        if (stage && stage !== 'pending_reportee' && stage !== 'pending_hr' && stage !== 'pending_requester') continue;
        const id = String(row?.employeeMongoId || '').trim();
        const day = dateKey(row?.date);
        const action = String(row?.action || 'mark').trim();
        if (id && day) coveredChange.add(`${id}|${day}|${action}`);
        add(
            id,
            day,
            changeRequestLabel(row),
            row?.requestedByName || personName(id, row?.employeeName),
            changePendingWithName(row),
        );
    }

    for (const row of attendanceRows || []) {
        const id = String(row?.employeeMongoId || '').trim();
        const day = dateKey(row?.date);
        const who = personName(id, row?.employeeName);
        const approver = approverOf(approversByEmployee, id);
        if (String(row?.leaveRequestStatus || '').trim() === 'pending') {
            add(id, day, attendancePendingRequestLabel(row), who, leavePendingWithName(row, approver));
        }
        if (
            String(row?.hourAdjustStatus || '').trim() === 'pending' &&
            !coveredChange.has(`${id}|${day}|hour_adjust`)
        ) {
            add(id, day, 'Hour approval request', who, chainPendingWithName(approver));
        }
        if (
            String(row?.flexibleOtStatus || '').trim() === 'pending' &&
            !coveredChange.has(`${id}|${day}|flexible_ot`)
        ) {
            add(id, day, 'Overtime request', who, chainPendingWithName(approver));
        }
    }

    for (const list of byEmployee.values()) {
        list.sort((left, right) => left.date.localeCompare(right.date) || left.label.localeCompare(right.label));
    }
    return byEmployee;
}
