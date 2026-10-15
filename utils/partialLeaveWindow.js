import {
    clockTimeToMinutes,
    flexibleHoursPerDay,
    getScheduledPunchMinutes,
    isFlexibleTiming,
} from './workingTimeHelpers.js';

export function partialLeavePortion(dayPart) {
    if (dayPart === 'half') return 0.5;
    if (dayPart === 'quarter') return 0.25;
    return 1;
}

function hoursDurationLabel(hours) {
    const totalMinutes = Math.max(0, Math.round((Number(hours) || 0) * 60));
    const whole = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    const hourText = `${whole} ${whole === 1 ? 'Hour' : 'Hours'}`;
    if (!mins) return hourText;
    return `${hourText} ${mins} Min`;
}

/** Leave list duration: a whole day is Full time, a partial day is its hours. */
export function leaveListDuration(row, week) {
    const part = String(row?.leaveRequestDayPart || '').trim();
    const stored = Number(row?.leaveDayFraction);
    const fraction =
        part === 'half' || part === 'quarter'
            ? partialLeavePortion(part)
            : stored > 0 && stored < 1
              ? stored
              : 1;
    if (!(fraction < 1)) return { hours: null, label: 'Full time' };

    const required = Number(row?.flexibleRequiredHours) || 0;
    let minutes = required > 0 ? Math.round(required * 60 * fraction) : 0;
    if (!(minutes > 0) && week) {
        const dayPart = part === 'quarter' || fraction <= 0.25 ? 'quarter' : 'half';
        const described = describePartialLeave({
            week,
            dateKey: row?.date,
            dayPart,
            session: row?.leaveRequestSession,
        });
        minutes = Number(described?.leaveMinutes) || 0;
    }
    if (!(minutes > 0)) {
        return { hours: null, label: part === 'quarter' || fraction <= 0.25 ? 'Quarter day' : 'Half day' };
    }
    const hours = Math.round((minutes / 60) * 100) / 100;
    return { hours, label: hoursDurationLabel(hours) };
}

/**
 * Late arrival, early go, and missed punch stay those types.
 * A quarter or half day taken without approval is still one of those, not unauthorized leave.
 */
export function punchAttendanceKind(row) {
    if (!row) return '';
    if (String(row.hourAdjustStatus || '') === 'approved' && row.hourAdjustKind) {
        const approved = String(row.hourAdjustKind);
        if (approved === 'late_arrived' || approved === 'early_go' || approved === 'mispunch') return approved;
    }
    const key = String(row.statusKey || '');
    const text = `${row.statusLabel || ''} ${row.reason || ''}`;
    const session = String(row.leaveRequestSession || '').trim();
    if (key === 'mispunch' || /mispunch/i.test(text)) return 'mispunch';
    if (key === 'early_go') return 'early_go';
    if (key === 'late_arrived') return 'late_arrived';
    if (key !== 'unauthorized_leave') return '';
    if (session === 'pm' || /\(PM\)/i.test(text) || /early/i.test(text)) return 'early_go';
    if (session === 'am' || /\(AM\)/i.test(text) || /late/i.test(text)) return 'late_arrived';
    const punched = Boolean(String(row.timeIn || '').trim() && String(row.timeOut || '').trim());
    if (punched && /unauthorized (half|quarter) day/i.test(text)) return 'late_arrived';
    return '';
}

function punchGapFields(kind, row) {
    const missed = kind === 'mispunch';
    const early = kind === 'early_go';
    const reason = String(row?.reason || '');
    const autoReason = !reason.trim() || /unauthorized (half|quarter) day/i.test(reason);
    let nextReason = reason;
    if (missed) nextReason = autoReason ? 'Missed punch without approval' : reason;
    else if (autoReason) nextReason = early ? 'Early go without approval' : 'Late arrival without approval';
    return {
        statusKey: missed ? 'mispunch' : early ? 'early_go' : 'late_arrived',
        statusLabel: missed ? 'Mispunch' : early ? 'Early Go' : 'Late Arrival',
        leaveRequestDayPart: '',
        leaveRequestSession: missed ? '' : early ? 'pm' : 'am',
        leaveDayFraction: 0,
        leaveDeductionTimes: 0,
        reason: nextReason,
    };
}

/** Stored unauthorized leave that is really a late, early, or missed punch. */
export function storedPunchGapPatch(row) {
    if (String(row?.hourAdjustStatus || '') === 'approved') return null;
    if (String(row?.statusKey || '') !== 'unauthorized_leave') return null;
    const kind = punchAttendanceKind(row);
    if (!kind) return null;
    return punchGapFields(kind, row);
}

export function formatDurationMinutes(minutes) {
    const total = Math.max(0, Math.round(Number(minutes) || 0));
    const hours = Math.floor(total / 60);
    const mins = total % 60;
    const hourLabel = `${hours} hr${hours === 1 ? '' : 's'}`;
    if (!mins) return hourLabel;
    return `${hourLabel} ${mins} min`;
}

export function formatClockMinutes(minutes) {
    const value = Math.round(Number(minutes) || 0);
    const hour24 = Math.floor(value / 60) % 24;
    const mins = ((value % 60) + 60) % 60;
    const suffix = hour24 >= 12 ? 'PM' : 'AM';
    const hour = hour24 % 12 || 12;
    return `${hour}:${String(mins).padStart(2, '0')} ${suffix}`;
}

function clockHHmm(minutes) {
    const value = Math.round(Number(minutes) || 0);
    const hour = Math.floor(value / 60) % 24;
    const mins = ((value % 60) + 60) % 60;
    return `${String(hour).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function portionName(dayPart) {
    return dayPart === 'quarter' ? 'quarter day' : 'half day';
}

/**
 * Allowed work window for an authorized half or quarter day.
 * AM leave is the first portion. PM leave is the last portion.
 */
export function describePartialLeave({ week, dateKey, dayPart, session } = {}) {
    const portion = partialLeavePortion(dayPart);
    if (portion >= 1) return null;
    const side = session === 'pm' ? 'pm' : 'am';
    const flexible = isFlexibleTiming(week);
    const schedule = getScheduledPunchMinutes(week, dateKey);
    const duration = flexible
        ? Math.round(flexibleHoursPerDay(week) * 60)
        : schedule?.startMinutes != null && schedule?.endMinutes != null
          ? schedule.endMinutes - schedule.startMinutes
          : 0;
    if (duration <= 0) return null;
    const leaveMinutes = Math.round(duration * portion);
    const workMinutes = duration - leaveMinutes;
    const name = portionName(dayPart);
    const sideLabel = side.toUpperCase();
    const hoursLabel = formatDurationMinutes(leaveMinutes);

    if (flexible || schedule?.startMinutes == null || schedule?.endMinutes == null) {
        return {
            flexible: true,
            portion,
            session: side,
            leaveMinutes,
            workMinutes,
            workStart: '',
            workEnd: '',
            message:
                `You have ${hoursLabel} authorized ${name} (${sideLabel}). ` +
                `Complete the other ${formatDurationMinutes(workMinutes)}. ` +
                'If you do not, the deduction is 2×.',
        };
    }

    const start = schedule.startMinutes;
    const end = schedule.endMinutes;
    const leaveStart = side === 'am' ? start : end - leaveMinutes;
    const leaveEnd = leaveStart + leaveMinutes;
    const workStart = side === 'am' ? leaveEnd : start;
    const workEnd = side === 'am' ? end : leaveStart;
    const leaveText = `${formatClockMinutes(leaveStart)}–${formatClockMinutes(leaveEnd)}`;
    const workText = `${formatClockMinutes(workStart)}–${formatClockMinutes(workEnd)}`;
    const penalty =
        side === 'am'
            ? `If you punch in after ${formatClockMinutes(workStart)}, the deduction is 2×.`
            : `If you punch out before ${formatClockMinutes(workEnd)}, the deduction is 2×.`;
    return {
        flexible: false,
        portion,
        session: side,
        leaveMinutes,
        workMinutes,
        workStart: clockHHmm(workStart),
        workEnd: clockHHmm(workEnd),
        leaveStart: clockHHmm(leaveStart),
        leaveEnd: clockHHmm(leaveEnd),
        message:
            `You have ${hoursLabel} authorized ${name} (${sideLabel}). ` +
            `Authorized leave is ${leaveText}. Work ${workText}. ${penalty}`,
    };
}

function workedMinutes(row) {
    const start = clockTimeToMinutes(row?.timeIn);
    const end = clockTimeToMinutes(row?.timeOut);
    if (start == null || end == null) return 0;
    const date = String(row?.date || '').trim();
    const outDate = String(row?.timeOutDate || '').trim();
    if (outDate && date && outDate > date) {
        const from = new Date(`${date}T12:00:00.000Z`);
        const to = new Date(`${outDate}T12:00:00.000Z`);
        const days = Math.round((to - from) / 86400000);
        return end - start + days * 24 * 60;
    }
    let diff = end - start;
    if (diff < 0) diff += 24 * 60;
    return diff;
}

function requiredMinutes(week, dateKey) {
    if (isFlexibleTiming(week)) return Math.round(flexibleHoursPerDay(week) * 60);
    const schedule = getScheduledPunchMinutes(week, dateKey);
    if (schedule?.isOffDay) return 0;
    if (schedule?.startMinutes == null || schedule?.endMinutes == null) return 0;
    return Math.max(0, schedule.endMinutes - schedule.startMinutes);
}

const SKIP_PARTIAL_STATUS = new Set([
    'holiday',
    'weekly_off',
    'on_leave',
    'sick_leave',
    'compoff_leave',
    'mispunch',
    'not_marked',
]);

/**
 * Approved partial leave punched outside the allowed window doubles that deduction.
 * A half or quarter taken with no approved request stays late arrival or early go.
 */
export function partialLeaveOutcome(row, week) {
    const key = String(row?.statusKey || '');
    if (String(row?.hourAdjustStatus || '') === 'approved') return null;
    if (key === 'unauthorized_leave') return storedPunchGapPatch(row);
    if (SKIP_PARTIAL_STATUS.has(key)) return null;
    const dateKey = String(row?.date || '');
    const required = requiredMinutes(week, dateKey);
    if (required <= 0) return null;
    const timeIn = clockTimeToMinutes(row?.timeIn);
    const timeOut = clockTimeToMinutes(row?.timeOut);
    if (timeIn == null || timeOut == null) return null;

    const dayPart = String(row?.leaveRequestDayPart || '');
    const approvedPartial =
        key === 'authorized_leave' &&
        String(row?.leaveRequestStatus || '') === 'approved' &&
        (dayPart === 'half' || dayPart === 'quarter');
    if (approvedPartial) {
        if (Number(row?.leaveDeductionTimes) === 2) return null;
        const described = describePartialLeave({
            week,
            dateKey,
            dayPart,
            session: row?.leaveRequestSession,
        });
        if (!described) return null;
        let violated = false;
        if (described.flexible) {
            violated = workedMinutes(row) + 15 < described.workMinutes;
        } else if (described.session === 'am') {
            const boundary = clockTimeToMinutes(described.workStart);
            violated = boundary != null && timeIn > boundary;
        } else {
            const boundary = clockTimeToMinutes(described.workEnd);
            violated = boundary != null && timeOut < boundary;
        }
        return violated ? { leaveDeductionTimes: 2 } : null;
    }

    if (key === 'authorized_leave') return null;

    const schedule = getScheduledPunchMinutes(week, dateKey);
    const grace = 15;
    const halfAt = required * 0.5;
    const quarterAt = required * 0.25;
    let gap = 0;
    let session = 'am';
    if (!isFlexibleTiming(week) && schedule?.startMinutes != null && schedule?.endMinutes != null) {
        const late = Math.max(0, timeIn - schedule.startMinutes);
        const early = Math.max(0, schedule.endMinutes - timeOut);
        gap = Math.max(late, early);
        session = late >= early ? 'am' : 'pm';
    } else {
        gap = Math.max(0, required - workedMinutes(row));
    }
    let portion = '';
    if (gap + grace >= halfAt && halfAt > 0) portion = 'half';
    else if (gap + grace >= quarterAt && quarterAt > 0) portion = 'quarter';
    if (!portion) return null;
    return punchGapFields(session === 'pm' ? 'early_go' : 'late_arrived', row);
}
