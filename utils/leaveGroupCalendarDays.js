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
