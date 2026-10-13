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

/** Next-day present can land on any day in the same month as the overtime. */
export function isCurrentMonthDate(sourceDate, targetDate) {
    const source = String(sourceDate || '').trim();
    const target = String(targetDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(source) || !/^\d{4}-\d{2}-\d{2}$/.test(target)) return false;
    return source.slice(0, 7) === target.slice(0, 7);
}

export function isAuthorizedLeaveStatus(statusKey, statusLabel = '') {
    const key = String(statusKey || '').trim();
    const label = String(statusLabel || '').trim();
    if (key === 'authorized_leave') return true;
    if (/^auth$/i.test(label)) return true;
    return /auth(?:orized)? leave/i.test(label);
}

export function requiredHoursForDate(week, dateKey) {
    const dayKey = weekdayKeyFromDateKey(dateKey);
    const day = dayKey ? week?.[dayKey] : null;
    if (!day || day.isOffDay) return 0;
    const hours = Number(day.workingHours);
    if (Number.isFinite(hours) && hours > 0) return Math.min(24, hours);
    return flexibleHoursPerDay(week);
}

/** Drop a fraction of an hour. 2.9 hours stays 2. */
export function wholeHourCount(value) {
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours <= 0) return 0;
    return Math.floor(hours + 1e-9);
}

/**
 * Whole hours short of the working-time day.
 * A block counts only after 60 minutes. 7 hours 45 minutes is 7 hours.
 */
export function flexibleLossHours(record, week) {
    const required = wholeHourCount(requiredHoursForDate(week, record?.date));
    let worked = Number(record?.flexibleWorkedHours) || 0;
    if (!(worked > 0)) {
        const minutes = dayWorkedMinutes(record);
        worked = Math.max(0, minutes) / 60;
    }
    return Math.max(0, required - wholeHourCount(worked));
}

function exactWorkedHours(record) {
    const inn = String(record?.timeIn || '').trim();
    const out = String(record?.timeOut || '').trim();
    const punched = Boolean(inn && out && inn !== 'OT' && out !== 'OT');
    const earlier = Array.isArray(record?.punchSessions)
        && record.punchSessions.some((span) => span?.timeIn && span?.timeOut);
    if (punched || earlier) return Math.max(0, dayWorkedMinutes(record)) / 60;
    return Math.max(0, Number(record?.flexibleWorkedHours) || 0);
}

/** Hours actually short, including minutes. 6 hours 15 minutes on a 10-hour day is 3.75. */
export function flexibleExactLossHours(record, week) {
    const required = requiredHoursForDate(week, record?.date);
    if (!(required > 0)) return 0;
    return Math.max(0, required - exactWorkedHours(record));
}

/**
 * Flexible time does not use the late-arrival or early-go salary policy.
 * A 10-hour day with 6 hours 15 minutes worked deducts 3.75/10 of that day's salary.
 */
export function flexibleMissedPayFraction(record, week) {
    if (!isFlexibleTiming(week)) return 0;
    const key = String(record?.statusKey || '');
    if (key !== 'late_arrived' && key !== 'early_go') return 0;
    const required = requiredHoursForDate(week, record?.date);
    if (!(required > 0)) return 0;
    const approved = String(record?.hourAdjustStatus || '') === 'approved';
    const missed = approved ? Number(record?.hoursApproved) || 0 : flexibleExactLossHours(record, week);
    if (!(missed > 0)) return 0;
    return missed / required;
}

/** Completed earlier sessions plus the latest check-in and check-out. */
export function dayWorkedMinutes(record) {
    const date = String(record?.date || '').trim();
    const spans = [
        ...(Array.isArray(record?.punchSessions) ? record.punchSessions : []),
        {
            timeIn: record?.timeIn,
            timeOut: record?.timeOut,
            timeOutDate: record?.timeOutDate,
        },
    ];
    return spans.reduce(
        (sum, span) => sum + workedMinutesAcross({
            date,
            timeIn: span?.timeIn,
            timeOut: span?.timeOut,
            timeOutDate: span?.timeOutDate,
        }),
        0,
    );
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
 * The button appears only after the required hours plus one hour.
 * Once it appears, overtime is every hour after the required hours.
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
    workedMinutes = null,
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
    const spanMinutes = Number.isFinite(workedMinutes)
        ? workedMinutes
        : workedMinutesAcross({ date, timeIn: inn, timeOut: out, timeOutDate });
    if (nonWorking) {
        const workedHours = Math.round((Math.max(0, spanMinutes) / 60) * 100) / 100;
        return {
            flexibleWorkedHours: workedHours,
            flexibleRequiredHours: 0,
            flexibleOtHours: workedHours,
        };
    }
    if (!isFlexible) return cleared;
    const result = evaluateFlexibleDay({
        workedMinutes: spanMinutes,
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
    const pastRequired = Math.round((workedHours - required) * 100) / 100;
    const otHours = pastRequired + 0.001 >= 1 ? pastRequired : 0;
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

function roundHourValue(value) {
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours < 0) return 0;
    return Math.round(hours * 100) / 100;
}

/**
 * Approved hours that cover one system working day become the next day's Present.
 * Hours above that day stay as overtime to approve on the next day.
 * When the working day is unknown, more than 10 hours still covers one 10-hour day.
 */
export function splitApprovedOvertime(approvedHours, dayHours) {
    const approved = roundHourValue(approvedHours);
    let day = roundHourValue(dayHours);
    if (!(day > 0)) {
        if (!(approved > 10)) return { nextDay: false, dayHours: 0, remainderHours: approved };
        day = 10;
    }
    if (approved + 1e-9 < day) return { nextDay: false, dayHours: 0, remainderHours: approved };
    return {
        nextDay: true,
        dayHours: day,
        remainderHours: Math.max(0, Math.floor(approved - day + 1e-9)),
    };
}

/** Hours that stay as overtime on this record. A linked next day consumes this approval. */
export function approvedOtRemainder(approvedHours) {
    const approved = Number(approvedHours) || 0;
    if (approved > 10) return 0;
    return Math.round(Math.max(0, approved) * 100) / 100;
}

export function summarizeApprovedFlexibleOvertime(rows = []) {
    const overtimeRecords = [];
    let hours = 0;
    for (const row of rows) {
        if (String(row?.flexibleOtNextDayDate || '').trim()) continue;
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
