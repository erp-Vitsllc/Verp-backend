function shiftDateKey(dateKey, deltaDays) {
    const [year, month, day] = String(dateKey).split('-').map(Number);
    const dt = new Date(Date.UTC(year, month - 1, day + deltaDays, 12, 0, 0));
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function suspensionWindow(employee) {
    if (String(employee?.attendanceAccountStatus || 'active').trim().toLowerCase() !== 'suspended') {
        return null;
    }
    const fromDate = String(employee?.attendanceSuspension?.fromDate || '').trim();
    const untilDate = String(employee?.attendanceSuspension?.untilDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(untilDate)) return null;
    if (untilDate < fromDate) return null;
    return {
        fromDate,
        untilDate,
        description: String(employee?.attendanceSuspension?.description || '').trim(),
    };
}

export function isAttendanceSuspendedOn(employee, dateKey) {
    const window = suspensionWindow(employee);
    const day = String(dateKey || '').trim();
    if (!window || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    return day >= window.fromDate && day <= window.untilDate;
}

export function suspendedAttendanceView(employee, dateKey) {
    const window = suspensionWindow(employee);
    const name = [employee?.firstName, employee?.lastName].filter(Boolean).join(' ').trim();
    return {
        date: dateKey,
        employeeMongoId: String(employee?._id || ''),
        employeeId: employee?.employeeId || '',
        employeeName: name,
        statusKey: 'suspended',
        statusLabel: 'Suspended',
        reason: window?.description || 'Attendance suspended',
        timeIn: '',
        timeOut: '',
        attendanceSuspended: true,
    };
}

/** Replace days inside the suspension window. Stored attendance rows are left unchanged. */
export function overlaySuspendedAttendance(records, employee, from, to) {
    const window = suspensionWindow(employee);
    const list = Array.isArray(records) ? records : [];
    if (!window) return list;
    const start = from && from > window.fromDate ? from : window.fromDate;
    const end = to && to < window.untilDate ? to : window.untilDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
        return list;
    }
    const covered = new Set();
    const next = list.map((row) => {
        const day = String(row?.date || '').trim();
        if (day < window.fromDate || day > window.untilDate) return row;
        covered.add(day);
        return suspendedAttendanceView(employee, day);
    });
    for (let day = start; day <= end; day = shiftDateKey(day, 1)) {
        if (!covered.has(day)) next.push(suspendedAttendanceView(employee, day));
    }
    return next;
}
