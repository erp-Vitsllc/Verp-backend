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

/** Sun = inside 12 AM–12 PM. Moon = inside 12 PM–12 AM. Both when the span crosses 12. */
export function shiftIcons({ date, timeIn, timeOut, timeOutDate }) {
    const inMin = clockTimeToMinutes(timeIn);
    const outMin = clockTimeToMinutes(timeOut);
    if (inMin == null || outMin == null) return { sun: false, moon: false };
    const outDate = String(timeOutDate || '').trim();
    const crossesMidnight = Boolean(outDate && outDate !== date) || outMin < inMin;
    if (crossesMidnight) return { sun: true, moon: true };
    const inMorning = inMin < 12 * 60;
    const outMorning = outMin < 12 * 60;
    if (inMorning && outMorning) return { sun: true, moon: false };
    if (!inMorning && !outMorning) return { sun: false, moon: true };
    return { sun: true, moon: true };
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
