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

/**
 * Days that still have an open attendance request.
 * Approved and rejected requests are left out. A next-day overtime date is not a second request.
 */
export function collectPendingCalendarRequests({
    attendanceRows = [],
    changeRows = [],
    employeeNames = new Map(),
    from = '',
    to = '',
} = {}) {
    const byEmployee = new Map();
    const seen = new Set();
    const coveredChange = new Set();

    const add = (employeeId, date, label, requestedBy) => {
        const id = String(employeeId || '').trim();
        const day = dateKey(date);
        const name = String(label || '').trim();
        const person = String(requestedBy || '').trim() || 'Employee';
        if (!id || !day || !name || !inWindow(day, from, to)) return;
        const key = `${id}|${day}|${name.toLowerCase()}|${person.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (!byEmployee.has(id)) byEmployee.set(id, []);
        byEmployee.get(id).push({ date: day, label: name, requestedBy: person });
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
        add(id, day, changeRequestLabel(row), row?.requestedByName || personName(id, row?.employeeName));
    }

    for (const row of attendanceRows || []) {
        const id = String(row?.employeeMongoId || '').trim();
        const day = dateKey(row?.date);
        const who = personName(id, row?.employeeName);
        if (String(row?.leaveRequestStatus || '').trim() === 'pending') {
            add(id, day, attendancePendingRequestLabel(row), who);
        }
        if (
            String(row?.hourAdjustStatus || '').trim() === 'pending' &&
            !coveredChange.has(`${id}|${day}|hour_adjust`)
        ) {
            add(id, day, 'Hour approval request', who);
        }
        if (
            String(row?.flexibleOtStatus || '').trim() === 'pending' &&
            !coveredChange.has(`${id}|${day}|flexible_ot`)
        ) {
            add(id, day, 'Overtime request', who);
        }
    }

    for (const list of byEmployee.values()) {
        list.sort((left, right) => left.date.localeCompare(right.date) || left.label.localeCompare(right.label));
    }
    return byEmployee;
}
