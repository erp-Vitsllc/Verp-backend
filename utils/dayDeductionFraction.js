import { explicitAuthorizedHourShare, isDeductionWaived, isHourLossWaived } from './deductionWaive.js';
import { lateInOutSummary, missedPunchDeduction } from './lateDeductionPolicy.js';
import { partialLeavePortion, punchAttendanceKind } from './partialLeaveWindow.js';

function policyTimes(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function roundFraction(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.round(n * 1e6) / 1e6;
}

function dateKey(row) {
    return String(row?.date || '').slice(0, 10);
}

function salaryKind(row) {
    return punchAttendanceKind(row) || String(row?.statusKey || '').trim();
}

function leavePortion(row) {
    const part = String(row?.leaveRequestDayPart || '');
    if (part === 'half' || part === 'quarter') return partialLeavePortion(part);
    if (Number(row?.leaveDayFraction) > 0 && Number(row.leaveDayFraction) < 1) return Number(row.leaveDayFraction);
    return 1;
}

function leaveChargeWeight(row, authorized) {
    const doubled = authorized && Number(row?.leaveDeductionTimes) === 2 ? 2 : 1;
    return leavePortion(row) * doubled;
}

function rowsWithTarget(monthRows, target) {
    const day = dateKey(target);
    const rest = (Array.isArray(monthRows) ? monthRows : []).filter((row) => dateKey(row) !== day);
    return [...rest, target];
}

function lateFraction(rows, policy, week) {
    const summary = lateInOutSummary(rows, policy, week);
    return (Number(summary?.lateIn?.dayFraction) || 0) + (Number(summary?.lateOut?.dayFraction) || 0);
}

/**
 * Salary-day fraction this attendance row deducts.
 * Leave uses the policy day multiplier. Late, early go, and mispunch use the
 * change in the month total if this day is removed, so a free allowance stays at 0.
 */
export function dayDeductionFraction(target, monthRows = [], policy = {}, week = null) {
    if (!target || isDeductionWaived(target)) return 0;
    const kind = salaryKind(target);
    if (kind === 'authorized_leave') {
        const share = explicitAuthorizedHourShare(target);
        if (share != null) return roundFraction(share * leavePortion(target));
        return roundFraction(policyTimes(policy?.authorizedLeaveDeductionDays, 1) * leaveChargeWeight(target, true));
    }
    if (kind === 'unauthorized_leave') {
        return roundFraction(policyTimes(policy?.unauthorizedLeaveDeductionDays, 2) * leaveChargeWeight(target, false));
    }
    const rows = rowsWithTarget(monthRows, target);
    if (kind === 'mispunch') {
        if (isHourLossWaived(target)) return 0;
        const count = rows.filter((row) => (
            !isDeductionWaived(row)
            && !isHourLossWaived(row)
            && salaryKind(row) === 'mispunch'
        )).length;
        const withDay = missedPunchDeduction(count, policy).dayFraction;
        const withoutDay = missedPunchDeduction(Math.max(0, count - 1), policy).dayFraction;
        return roundFraction(withDay - withoutDay);
    }
    if (kind === 'late_arrived' || kind === 'early_go') {
        const without = rows.map((row) => (dateKey(row) === dateKey(target) ? { ...row, deductionWaived: true } : row));
        return roundFraction(lateFraction(rows, policy, week) - lateFraction(without, policy, week));
    }
    return 0;
}
