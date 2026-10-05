import { clockTimeToMinutes, getScheduledPunchMinutes, isFlexibleTiming } from './workingTimeHelpers.js';

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

/**
 * The policy count is the free allowance for the month.
 * A count of 4 means events 1–4 deduct nothing, and event 5 takes the first deduct.
 * The next deduct starts one event after the next full count.
 */
export function chargeableLateEventUnits(totalEvents, policyEvents) {
    const total = Math.max(0, Math.floor(Number(totalEvents) || 0));
    const per = Number(policyEvents);
    if (!Number.isFinite(per) || per <= 0) return total;
    if (total <= per) return 0;
    return Math.floor((total - 1) / per);
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
export function sharedLateSides({
    timeIn,
    timeOut,
    date,
    week,
    statusKey,
    minutesThreshold,
} = {}) {
    const none = { in: false, out: false };
    const key = String(statusKey || '');
    if (SKIP_LATE_STATUS.has(key)) return none;
    if (key !== 'late_arrived' && key !== 'early_go') return none;

    const threshold = Number(minutesThreshold);
    const minMinutes = Number.isFinite(threshold) && threshold > 0 ? threshold : 0;
    const actualIn = clockTimeToMinutes(timeIn);
    const actualOut = clockTimeToMinutes(timeOut);
    const scheduled = date && week ? getScheduledPunchMinutes(week, date) : null;
    const canUseSchedule = Boolean(scheduled && !scheduled.isOffDay);

    if (canUseSchedule && minMinutes > 0 && (actualIn != null || actualOut != null)) {
        return {
            in:
                actualIn != null &&
                scheduled.startMinutes != null &&
                actualIn - scheduled.startMinutes >= minMinutes,
            out:
                actualOut != null &&
                scheduled.endMinutes != null &&
                scheduled.endMinutes - actualOut >= minMinutes,
        };
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
    return { in: lateIn, out: lateOut };
}

export function countDayLateInOutEvents(args = {}) {
    const sides = sharedLateSides(args);
    return (sides.in ? 1 : 0) + (sides.out ? 1 : 0);
}

function isMissedPunchTitle(title) {
    return /miss(?:ed)?[\s-]*punch|mis[\s-]*punch/i.test(String(title || ''));
}

/** Group policy field wins. An older extra rule titled Missed punch still applies until that field is set. */
export function missedPunchRuleOf(policy) {
    const dedicated = policy?.missedPunchRule;
    if (lateDeductMultiplier(dedicated) > 0) return dedicated;
    const extra = (Array.isArray(policy?.extraLateRules) ? policy.extraLateRules : []).find(
        (row) => isMissedPunchTitle(row?.title) && lateDeductMultiplier(row) > 0,
    );
    return extra || dedicated || {};
}

export function missedPunchDeduction(totalEvents, policy) {
    const rule = missedPunchRuleOf(policy);
    const combined = Math.max(0, Math.floor(Number(totalEvents) || 0));
    const units = chargeableLateEventUnits(combined, rule?.events);
    const multiplier = lateDeductMultiplier(rule);
    return {
        rule,
        combinedEvents: combined,
        eventBundle: Number(rule?.events) > 0 ? Number(rule.events) : 0,
        units,
        dayFraction: multiplier * units,
        multiplier,
    };
}

const EXTRA_LATE_SKIP = new Set([
    'holiday',
    'weekly_off',
    'week_off',
    'on_leave',
    'sick_leave',
    'authorized_leave',
    'unauthorized_leave',
    'compoff_leave',
]);

export function extraLateRuleDirection(rule) {
    const title = String(rule?.title || '').toLowerCase();
    if (/late\s*out|early/.test(title)) return 'out';
    if (/late\s*in/.test(title)) return 'in';
    return '';
}

function prepareExtraLateRules(policy) {
    return (Array.isArray(policy?.extraLateRules) ? policy.extraLateRules : [])
        .map((rule, index) => ({ rule, index, direction: extraLateRuleDirection(rule) }))
        .filter(
            (row) =>
                row.direction &&
                lateDeductMultiplier(row.rule) > 0 &&
                !isMissedPunchTitle(row.rule?.title),
        );
}

function highestExtraMatch(minutes, indexes, rules) {
    if (minutes <= 0) return null;
    const match = indexes.find(
        (index) => minutes >= Math.max(0, Number(rules[index].rule?.minutes) || 0),
    );
    return match == null ? null : match;
}

function splitFraction(total, inCount, outCount) {
    const fraction = Math.max(0, Number(total) || 0);
    const weights = { in: Math.max(0, inCount), out: Math.max(0, outCount) };
    const sum = weights.in + weights.out;
    if (!fraction || !sum) return { in: 0, out: 0 };
    const inn = Math.round(fraction * (weights.in / sum) * 100) / 100;
    const out = Math.round((fraction - inn) * 100) / 100;
    return { in: inn, out: Math.max(0, out) };
}

/**
 * One result for late in and one for late out.
 * A day that meets a stricter minute band is counted only on that band,
 * not also on the shared late in / late out allowance.
 */
export function lateInOutSummary(rows, policy, week) {
    const rules = prepareExtraLateRules(policy);
    const counts = rules.map(() => 0);
    const order = { in: [], out: [] };
    rules.forEach((row, index) => order[row.direction].push(index));
    const byMinutes = (a, b) => (Number(rules[b].rule?.minutes) || 0) - (Number(rules[a].rule?.minutes) || 0);
    order.in.sort(byMinutes);
    order.out.sort(byMinutes);
    const flexible = isFlexibleTiming(week);
    const threshold = minutesThresholdOf(sharedLateRule(policy));
    let sharedLateIn = 0;
    let sharedLateOut = 0;

    for (const row of rows || []) {
        const statusKey = String(row?.statusKey || '');
        let extraIn = false;
        let extraOut = false;
        if (!flexible && rules.length && !EXTRA_LATE_SKIP.has(statusKey)) {
            const date = String(row?.date || '').slice(0, 10);
            const scheduled = getScheduledPunchMinutes(week, date);
            if (scheduled && !scheduled.isOffDay && scheduled.startMinutes != null && scheduled.endMinutes != null) {
                const actualIn = clockTimeToMinutes(row?.timeIn);
                const actualOut = clockTimeToMinutes(row?.timeOut);
                const gaps = {
                    in: actualIn == null ? 0 : actualIn - scheduled.startMinutes,
                    out: actualOut == null ? 0 : scheduled.endMinutes - actualOut,
                };
                const matchIn = highestExtraMatch(gaps.in, order.in, rules);
                const matchOut = highestExtraMatch(gaps.out, order.out, rules);
                if (matchIn != null) {
                    counts[matchIn] += 1;
                    extraIn = true;
                }
                if (matchOut != null) {
                    counts[matchOut] += 1;
                    extraOut = true;
                }
            }
        }
        const sharedSides = sharedLateSides({
            timeIn: row?.timeIn,
            timeOut: row?.timeOut,
            date: row?.date,
            week,
            statusKey,
            minutesThreshold: threshold,
        });
        if (!extraIn && sharedSides.in) sharedLateIn += 1;
        if (!extraOut && sharedSides.out) sharedLateOut += 1;
    }

    const extra = rules.map((row, index) => extraLateCharge(row, counts[index]));
    const shared = lateDeductionFromEvents(sharedLateIn + sharedLateOut, policy);
    const extraIn = extra.filter((row) => row.direction === 'in');
    const extraOut = extra.filter((row) => row.direction === 'out');
    const extraInFraction = extraIn.reduce((sum, row) => sum + row.dayFraction, 0);
    const extraOutFraction = extraOut.reduce((sum, row) => sum + row.dayFraction, 0);
    const sharedSplit = splitFraction(shared.dayFraction, sharedLateIn, sharedLateOut);
    const roundFraction = (value) => Math.round(value * 100) / 100;
    return {
        sharedLateIn,
        sharedLateOut,
        shared,
        extra,
        lateIn: {
            count: sharedLateIn + extraIn.reduce((sum, row) => sum + row.count, 0),
            sharedCount: sharedLateIn,
            dayFraction: roundFraction(sharedSplit.in + extraInFraction),
        },
        lateOut: {
            count: sharedLateOut + extraOut.reduce((sum, row) => sum + row.count, 0),
            sharedCount: sharedLateOut,
            dayFraction: roundFraction(sharedSplit.out + extraOutFraction),
        },
    };
}

/**
 * Each extra late rule is its own deduction.
 * A day matches only the highest minute band in that direction.
 * An event count of 0 means every matching day deducts.
 */
export function countExtraLateRules(rows, policy, week) {
    return lateInOutSummary(rows, policy, week).extra;
}

function extraLateCharge(row, count) {
    const units = chargeableLateEventUnits(count, row.rule?.events);
    const multiplier = lateDeductMultiplier(row.rule);
    const minutes = Math.max(0, Math.floor(Number(row.rule?.minutes) || 0));
    const name = String(row.rule?.title || '').trim() || (row.direction === 'out' ? 'Late out' : 'Late in');
    return {
        ...row,
        count,
        units,
        multiplier,
        dayFraction: multiplier * units,
        label: minutes > 0 ? `${name} ${minutes} min` : name,
    };
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
        dayFraction: multiplier * units,
        multiplier,
        minutesThreshold: minutesThresholdOf(rule),
    };
}
