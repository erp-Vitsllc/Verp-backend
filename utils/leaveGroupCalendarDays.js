import { punchTimeSet } from './attendanceDayLookup.js';

/**
 * Status shown on a group calendar day.
 * An open check-in today, or a closed punch stored as unmarked, counts as present.
 */
export function calendarStatusKey(row, todayKey) {
    if (!row) return '';
    const key = String(row.statusKey || '').trim();
    if (!punchTimeSet(row.timeIn)) return key;
    const closed = punchTimeSet(row.timeOut);
    const today = String(todayKey || '').trim();
    const date = String(row.date || '').trim();
    if ((key === 'not_marked' || key === 'absent' || key === '') && (closed || (today && date === today))) {
        return 'on_office';
    }
    return key;
}

/**
 * Short label inside a calendar cell.
 * Approved overtime stays OT. A comp-off day, or the next day marked from that overtime, is COMPOFF.
 */
export function calendarCellTag(row) {
    if (!row) return '';
    const timeIn = String(row.timeIn || '').trim();
    const timeOut = String(row.timeOut || '').trim();
    const placeholder = timeIn === 'OT' || timeOut === 'OT';
    const status = String(row.statusKey || '');
    const takenFrom = String(row.flexibleFromOtDate || '').trim();
    const givenTo = String(row.flexibleOtNextDayDate || '').trim();
    const compOff = status === 'compoff_leave' || placeholder || Boolean(takenFrom) || Boolean(givenTo);
    const approvedHours = String(row.flexibleOtStatus || '') === 'approved'
        ? Number(row.flexibleOtApprovedHours) || 0
        : 0;
    if (approvedHours > 0 && !compOff) return 'OT';
    if (compOff) return 'COMPOFF';
    return '';
}

/** OT or COMPOFF per date. Days before the employee is on the books are left out. */
export function calendarTagsForEmployee(rows, { visibleFrom = '' } = {}) {
    const start = String(visibleFrom || '').trim();
    const tags = {};
    for (const row of rows || []) {
        const date = String(row?.date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        if (start && date < start) continue;
        const tag = calendarCellTag(row);
        if (tag) tags[date] = tag;
        else delete tags[date];
    }
    return tags;
}

/** One status per date. Days before the employee is on the books are left out. */
export function calendarDaysForEmployee(rows, { todayKey = '', visibleFrom = '' } = {}) {
    const start = String(visibleFrom || '').trim();
    const days = {};
    for (const row of rows || []) {
        const date = String(row?.date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        if (start && date < start) continue;
        const statusKey = calendarStatusKey(row, todayKey);
        if (!statusKey) continue;
        days[date] = statusKey;
    }
    return days;
}
