import { clockTimeToMinutes, getScheduledPunchMinutes } from './workingTimeHelpers.js';

function ruleHasValue(row) {
    if (!row || typeof row !== 'object') return false;
    return (
        (row.minutes != null && row.minutes !== '') ||
        (row.events != null && row.events !== '') ||
        Boolean(row.deduct)
    );
}

export function sharedLateRule(policy) {
    const lateIn = Array.isArray(policy?.lateInRules) ? policy.lateInRules[0] : null;
    const lateOut = Array.isArray(policy?.lateOutRules) ? policy.lateOutRules[0] : null;
    if (ruleHasValue(lateIn)) return lateIn;
    if (ruleHasValue(lateOut)) return lateOut;
    return lateIn || lateOut || {};
}

export function lateDeductMultiplier(rule) {
    const deduct = String(rule?.deduct || '').trim().toLowerCase();
    if (deduct === 'full') return 1;
    if (deduct === 'half') return 0.5;
    if (deduct === 'quarter') return 0.25;
    return 0;
}

/** Combined late in + late out events, then one deduct unit per policy event bundle. */
export function chargeableLateEventUnits(totalEvents, policyEvents) {
    const total = Math.max(0, Math.floor(Number(totalEvents) || 0));
    const per = Number(policyEvents);
    if (!Number.isFinite(per) || per <= 0) return total;
    return Math.floor(total / per);
}

function minutesThresholdOf(rule) {
    const n = Number(rule?.minutes);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

const SKIP_LATE_STATUS = new Set([
    'holiday',
    'authorized_leave',
    'unauthorized_leave',
    'sick_leave',
    'on_leave',
    'compoff_leave',
    'not_marked',
    'week_off',
]);

/**
 * Count late-in and late-out as separate events on the same day so they share
 * one monthly total. A day with both is 2 events, not two independent policies.
 */
export function countDayLateInOutEvents({
    timeIn,
    timeOut,
    date,
    week,
    statusKey,
    minutesThreshold,
} = {}) {
    const key = String(statusKey || '');
    if (SKIP_LATE_STATUS.has(key)) return 0;
    if (key !== 'late_arrived' && key !== 'early_go') return 0;

    const threshold = Number(minutesThreshold);
    const minMinutes = Number.isFinite(threshold) && threshold > 0 ? threshold : 0;
    const actualIn = clockTimeToMinutes(timeIn);
    const actualOut = clockTimeToMinutes(timeOut);
    const scheduled = date && week ? getScheduledPunchMinutes(week, date) : null;
    const canUseSchedule = Boolean(scheduled && !scheduled.isOffDay);

    if (canUseSchedule && minMinutes > 0 && (actualIn != null || actualOut != null)) {
        const lateIn =
            actualIn != null &&
            scheduled.startMinutes != null &&
            actualIn - scheduled.startMinutes >= minMinutes;
        const lateOut =
            actualOut != null &&
            scheduled.endMinutes != null &&
            scheduled.endMinutes - actualOut >= minMinutes;
        return (lateIn ? 1 : 0) + (lateOut ? 1 : 0);
    }

    let lateIn = key === 'late_arrived';
    let lateOut = key === 'early_go';
    if (canUseSchedule && (lateIn || lateOut)) {
        if (
            !lateIn &&
            actualIn != null &&
            scheduled.startMinutes != null &&
            actualIn > scheduled.startMinutes + 15
        ) {
            lateIn = true;
        }
        if (
            !lateOut &&
            actualOut != null &&
            scheduled.endMinutes != null &&
            actualOut < scheduled.endMinutes
        ) {
            lateOut = true;
        }
    }
    return (lateIn ? 1 : 0) + (lateOut ? 1 : 0);
}

export function lateDeductionFromEvents(totalEvents, policy) {
    const rule = sharedLateRule(policy);
    const combined = Math.max(0, Math.floor(Number(totalEvents) || 0));
    const units = chargeableLateEventUnits(combined, rule?.events);
    const multiplier = lateDeductMultiplier(rule);
    return {
        rule,
        combinedEvents: combined,
        eventBundle: Number(rule?.events) > 0 ? Number(rule.events) : 0,
        units,
        multiplier,
        minutesThreshold: minutesThresholdOf(rule),
    };
}
