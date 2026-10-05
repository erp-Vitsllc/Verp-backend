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
 * A half or quarter taken with no approved request becomes unauthorized.
 */
export function partialLeaveOutcome(row, week) {
    const key = String(row?.statusKey || '');
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

    if (key === 'authorized_leave' || key === 'unauthorized_leave') return null;

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
    const label = portion === 'half' ? 'Unauthorized Half Day' : 'Unauthorized Quarter Day';
    return {
        statusKey: 'unauthorized_leave',
        statusLabel: `${label} (${session.toUpperCase()})`,
        leaveRequestDayPart: portion,
        leaveRequestSession: session,
        leaveDayFraction: partialLeavePortion(portion),
        leaveDeductionTimes: 1,
        reason: `${label} taken without an approved request`,
    };
}
