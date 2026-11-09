import {
    getOffWeekdayKeys,
    getScheduledPunchMinutes,
    weekdayKeyFromDateKey,
} from './workingTimeHelpers.js';
import {
    approvalPlacedAsNextDay,
    buildMonthWorkWeeks,
    buildWeeklySalaryAddition,
    leaveDatesTakenByOvertime,
} from './weeklySalaryAddition.js';

function roundHours(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function overtimePlaceholderDay(row) {
    if (String(row?.statusKey || '') === 'compoff_leave') return true;
    const inn = String(row?.timeIn || '').trim();
    const out = String(row?.timeOut || '').trim();
    if (inn === 'OT' || out === 'OT') return true;
    return Boolean(String(row?.flexibleFromOtDate || '').trim());
}

function punchRowRank(row) {
    const inn = String(row?.timeIn || '').trim();
    return inn && inn !== 'OT' ? 1 : 0;
}

function scheduledHours(week, dateKey, required) {
    if (!required) return 0;
    const slot = getScheduledPunchMinutes(week, dateKey);
    if (slot?.flexible) {
        const minutes = Number(slot.scheduledMinutes) || 0;
        return minutes > 0 ? roundHours(minutes / 60) : 0;
    }
    const start = slot?.startMinutes;
    const end = slot?.endMinutes;
    if (start != null && end != null && end > start) return roundHours((end - start) / 60);
    return 8;
}

/**
 * Hours behind the Leave page "Total OT amount".
 * The amount is these hours × (monthly salary / days in the month) / 10.
 * Returns null when that calendar cannot be built, so the caller can keep its own total.
 */
export async function leavePageApprovedOtHours({
    records = [],
    monthKey = '',
    countTo = '',
    joinKey = '',
    daily = 0,
    week = null,
    holidayDates = new Set(),
    monthlySalary = 0,
} = {}) {
    const month = String(monthKey || '');
    if (!/^\d{4}-\d{2}$/.test(month)) return 0;
    const rows = (records || [])
        .map((row) => {
            const date = String(row?.date || '').trim();
            return /^\d{4}-\d{2}-\d{2}$/.test(date) ? { ...row, date } : null;
        })
        .filter(Boolean);
    const byDate = new Map(rows.map((row) => [row.date, row]));
    const offWeekdays = new Set(getOffWeekdayKeys(week));
    const dayInfo = (dateKey) => {
        const record = byDate.get(dateKey);
        const weekday = weekdayKeyFromDateKey(dateKey);
        const isHoliday = holidayDates?.has?.(dateKey) || record?.statusKey === 'holiday';
        const isWeeklyOff = !isHoliday && (record?.statusKey === 'weekly_off' || offWeekdays.has(weekday));
        const required = Boolean(countTo)
            && dateKey <= countTo
            && (!joinKey || dateKey >= joinKey)
            && dateKey.startsWith(month)
            && !isHoliday
            && !isWeeklyOff;
        return {
            required,
            scheduledHours: scheduledHours(week, dateKey, required),
            weeklyOff: isWeeklyOff,
            holiday: isHoliday,
        };
    };
    const calendarNotes = {};
    const weeks = buildMonthWorkWeeks(month);
    for (const weekRow of weeks) {
        const report = buildWeeklySalaryAddition({
            monthKey: month,
            countTo,
            joinKey,
            records: rows,
            daily,
            flexible: String(week?.timingMode || '').toLowerCase() === 'flexible',
            weekDates: weekRow.dates,
            extraDates: weekRow.extraDates,
            dayInfo,
            monthlySalary,
            monthWorkingDays: 0,
        });
        for (const [date, note] of Object.entries(report?.calendar || {})) {
            const current = calendarNotes[date] || { otHours: 0, givenTo: '', takenFrom: '' };
            calendarNotes[date] = {
                otHours: note?.otHours > 0 ? note.otHours : current.otHours,
                givenTo: note?.givenTo || current.givenTo,
                takenFrom: note?.takenFrom || current.takenFrom,
            };
        }
    }
    return sumLeavePageApprovedOtHours(
        rows,
        month,
        calendarNotes,
        countTo,
        leaveDatesTakenByOvertime(rows, month),
        approvalPlacedAsNextDay,
    );
}

/** Same hour total as the Leave page OT reference for one month. */
export function sumLeavePageApprovedOtHours(
    records,
    monthKey,
    notesByDate = {},
    countTo = '',
    taken = new Map(),
    approvalPlacedAsNextDay = () => false,
) {
    const prefix = String(monthKey || '');
    const byDate = new Map();
    for (const row of records || []) {
        const date = String(row?.date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (prefix && !date.startsWith(prefix))) continue;
        if (String(row?.flexibleOtStatus || '').trim() !== 'approved') continue;
        if (!((Number(row?.flexibleOtApprovedHours) || 0) > 0)) continue;
        if (overtimePlaceholderDay(row)) continue;
        const uses = taken.get(date) || [];
        if (approvalPlacedAsNextDay(row, uses)) continue;
        const inside = !countTo || date <= countTo;
        const noted = Number(notesByDate?.[date]?.otHours) || 0;
        const stored = Number(row.flexibleOtApprovedHours) || 0;
        const approvedHours = inside && noted > 0 ? noted : stored;
        if (!(approvedHours > 0)) continue;
        if (
            inside
            && !(noted > 0)
            && !taken.has(date)
            && !String(notesByDate?.[date]?.givenTo || '').trim()
        ) continue;
        const current = byDate.get(date);
        if (!current || punchRowRank(row) >= punchRowRank(current.row)) {
            byDate.set(date, { row, approvedHours });
        }
    }
    let total = 0;
    for (const item of byDate.values()) total = roundHours(total + item.approvedHours);
    return total;
}
