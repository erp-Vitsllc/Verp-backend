import {
    clockTimeToMinutes,
    flexibleHoursPerDay,
    isFlexibleTiming,
    weekdayKeyFromDateKey,
} from './workingTimeHelpers.js';

export { isFlexibleTiming };

export function addDaysKey(dateKey, days) {
    const date = new Date(`${dateKey}T12:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

export function requiredHoursForDate(week, dateKey) {
    const dayKey = weekdayKeyFromDateKey(dateKey);
    const day = dayKey ? week?.[dayKey] : null;
    if (!day || day.isOffDay) return 0;
    const hours = Number(day.workingHours);
    if (Number.isFinite(hours) && hours > 0) return Math.min(24, hours);
    return flexibleHoursPerDay(week);
}

export function workedMinutesAcross({ date, timeIn, timeOut, timeOutDate }) {
    const start = clockTimeToMinutes(timeIn);
    const end = clockTimeToMinutes(timeOut);
    if (start == null || end == null) return 0;
    const outDate = String(timeOutDate || '').trim();
    if (outDate && outDate > date) {
        const from = new Date(`${date}T12:00:00.000Z`);
        const to = new Date(`${outDate}T12:00:00.000Z`);
        const days = Math.round((to - from) / 86400000);
        return end - start + days * 24 * 60;
    }
    let minutes = end - start;
    if (minutes < 0) minutes += 24 * 60;
    return minutes;
}

const FLEXIBLE_OT_SKIP_KEYS = new Set([
    'on_leave',
    'sick_leave',
    'compoff_leave',
    'authorized_leave',
    'unauthorized_leave',
    'holiday',
    'weekly_off',
    'mispunch',
    'clear_attendance',
    'clear',
]);

/** Same-day clocks stay on this date. A check-out before check-in is the next day. */
export function manualTimeOutDate(date, timeIn, timeOut) {
    const start = clockTimeToMinutes(timeIn);
    const end = clockTimeToMinutes(timeOut);
    if (start == null || end == null) return '';
    if (end < start) return addDaysKey(date, 1);
    return '';
}

/**
 * Overtime follows the current check-in and check-out.
 * The first hour past the required day is not overtime; hours after that are.
 */
export function flexibleOtFieldsFromDuration({
    isFlexible = false,
    date,
    timeIn,
    timeOut,
    timeOutDate = '',
    requiredHours = 0,
    statusKey = '',
    nonWorking = false,
} = {}) {
    const cleared = {
        flexibleWorkedHours: 0,
        flexibleRequiredHours: 0,
        flexibleOtHours: 0,
    };
    const key = String(statusKey || '').trim();
    const inn = String(timeIn || '').trim();
    const out = String(timeOut || '').trim();
    const punches = Boolean(inn && out && inn !== 'OT' && out !== 'OT');
    if (FLEXIBLE_OT_SKIP_KEYS.has(key) || !punches) return cleared;
    // A holiday or weekly off is not a working day, so the time they worked is overtime.
    if (nonWorking) {
        const workedMinutes = workedMinutesAcross({ date, timeIn: inn, timeOut: out, timeOutDate });
        const workedHours = Math.round((Math.max(0, workedMinutes) / 60) * 100) / 100;
        return {
            flexibleWorkedHours: workedHours,
            flexibleRequiredHours: 0,
            flexibleOtHours: workedHours,
        };
    }
    if (!isFlexible) return cleared;
    const result = evaluateFlexibleDay({
        workedMinutes: workedMinutesAcross({ date, timeIn: inn, timeOut: out, timeOutDate }),
        requiredHours,
    });
    return {
        flexibleWorkedHours: result.workedHours,
        flexibleRequiredHours: result.requiredHours,
        flexibleOtHours: result.otHours,
    };
}

/** When the duration's overtime changes, drop a request that was based on the old hours. */
export function mergeFlexibleOtState(existing, fields) {
    const prev = Number(existing?.flexibleOtHours) || 0;
    const next = Number(fields?.flexibleOtHours) || 0;
    const changed = Math.abs(prev - next) >= 0.001;
    if (!changed) {
        return { ...fields, changed: false, revertNextDayDate: '' };
    }
    return {
        ...fields,
        flexibleOtStatus: '',
        flexibleOtApprovedHours: 0,
        flexibleOtReason: '',
        flexibleOtNextDayDate: '',
        changed: true,
        revertNextDayDate:
            String(existing?.flexibleOtStatus || '') === 'approved'
                ? String(existing?.flexibleOtNextDayDate || '').trim()
                : '',
    };
}

export function evaluateFlexibleDay({ workedMinutes, requiredHours }) {
    const required = Number(requiredHours) || 0;
    const workedHours = Math.round((Math.max(0, workedMinutes) / 60) * 100) / 100;
    const same = Math.abs(workedHours - required) < 0.05;
    if (same) {
        return {
            statusKey: 'on_office',
            statusLabel: 'Present',
            reason: '',
            otHours: 0,
            workedHours,
            requiredHours: required,
        };
    }
    if (workedHours < required) {
        return {
            statusKey: 'early_go',
            statusLabel: 'Early Go',
            reason: 'Worked less than the daily hours',
            otHours: 0,
            workedHours,
            requiredHours: required,
        };
    }
    const otHours = Math.max(0, Math.round((workedHours - required - 1) * 100) / 100);
    return {
        statusKey: 'on_office',
        statusLabel: 'Present',
        reason: '',
        otHours,
        workedHours,
        requiredHours: required,
    };
}

/** Sun = same-day shift, including late arrival and early go. Moon = check-out after the next midnight. */
export function shiftIcons({ date, timeIn, timeOut, timeOutDate }) {
    const inMin = clockTimeToMinutes(timeIn);
    const outMin = clockTimeToMinutes(timeOut);
    if (inMin == null || outMin == null) return { sun: false, moon: false };
    const outDate = String(timeOutDate || '').trim();
    const crossesMidnight = Boolean(outDate && outDate !== date) || outMin < inMin;
    if (crossesMidnight) return { sun: false, moon: true };
    return { sun: true, moon: false };
}

export function approvedOtRemainder(approvedHours) {
    const approved = Number(approvedHours) || 0;
    if (approved >= 9) return Math.round((approved - 9) * 100) / 100;
    return Math.round(Math.max(0, approved) * 100) / 100;
}

export function summarizeApprovedFlexibleOvertime(rows = []) {
    const overtimeRecords = [];
    let hours = 0;
    for (const row of rows) {
        if (String(row?.flexibleOtStatus || '') !== 'approved') continue;
        const remain = approvedOtRemainder(row.flexibleOtApprovedHours);
        if (remain <= 0) continue;
        hours += remain;
        overtimeRecords.push({
            date: String(row.date || '').trim(),
            hours: remain,
            days: 0,
            isOffDay: false,
        });
    }
    hours = Math.round(hours * 100) / 100;
    return { hours, days: 0, overtimeRecords };
}
