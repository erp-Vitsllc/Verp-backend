/**
 * Annual leave entitlement across anniversary cycles.
 *
 * Each cycle grants a fixed number of calendar days (30 unless overridden).
 * Approved leave is deducted once, in start-date order:
 * 1. Unused days carried from the previous cycle (valid during the next cycle only).
 * 2. The cycle in which the leave starts.
 * 3. The immediately following cycle, as advance leave.
 * Anything still left is unallocated excess. It is not a salary deduction.
 * Unused days that were not taken by the end of the following cycle expire.
 * Pending, rejected, cancelled, and draft leave is ignored.
 * The same dates are never deducted twice.
 */
import {
    addCalendarMonths,
    addDays,
    inclusiveCalendarDays,
    isDateKey,
    twelveMonthPeriodEnd,
} from './salaryHistoricalCalculations.js';

export const ANNUAL_LEAVE_DAYS_PER_CYCLE = 30;

const SKIPPED_STATUS = new Set(['cancelled', 'rejected', 'pending', 'draft']);
const MAX_CYCLES = 40;
const MAX_SPAN = 4000;

function emptyResult(message, allowedDays = ANNUAL_LEAVE_DAYS_PER_CYCLE) {
    return {
        ok: false,
        message,
        allowedDaysPerCycle: allowedDays,
        totalEntitlement: 0,
        totalLeaveTaken: 0,
        totalDeducted: 0,
        excessLeave: 0,
        expiredLeave: 0,
        advanceDays: 0,
        skippedPendingDays: 0,
        skippedRejectedDays: 0,
        firstEligibilityDate: '',
        cycles: [],
        leaves: [],
    };
}

function dateKey(value) {
    const raw = String(value || '').trim();
    if (isDateKey(raw)) return raw;
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : '';
}

function isAnnualLeave(row) {
    const type = String(row?.leaveType || row?.type || '').trim().toLowerCase();
    if (!type) return true;
    return type === 'annual' || type === 'on_leave';
}

function statusOf(row) {
    return String(row?.status || '').trim().toLowerCase();
}

function countedDays(row, start, end) {
    const span = start && end ? inclusiveCalendarDays(start, end) : 0;
    const stored = Number(row?.eligibleWorkingDays ?? row?.actualDays);
    if (span > 0) {
        if (Number.isFinite(stored) && stored > 0) return Math.max(0, Math.round(Math.min(stored, span)));
        return span;
    }
    if (Number.isFinite(stored) && stored > 0) return Math.max(0, Math.round(stored));
    const calendar = Number(row?.calendarDays);
    if (Number.isFinite(calendar) && calendar > 0) return Math.max(0, Math.round(calendar));
    return 0;
}

function eachDate(start, end) {
    if (!isDateKey(start) || !isDateKey(end) || end < start) return [];
    const dates = [];
    let cursor = start;
    while (cursor && cursor <= end && dates.length < MAX_SPAN) {
        dates.push(cursor);
        cursor = addDays(cursor, 1);
    }
    return dates;
}

function normalizeLeave(row) {
    const start = dateKey(row?.startDate || row?.fromDate);
    const end = dateKey(row?.endDate || row?.toDate) || start;
    if (start && end && end < start) return null;
    const days = countedDays(row, start, end);
    if (!days) return null;
    const source = String(row?.source || '').trim().toLowerCase() === 'system' ? 'system' : 'manual';
    return {
        id: String(row?.id || row?._id || '').trim(),
        start,
        end: end || start,
        days,
        source,
        status: statusOf(row),
        fragment: source === 'system' && Boolean(start) && start === (end || start),
    };
}

function dedupeById(rows) {
    const seen = new Map();
    const out = [];
    for (const row of rows) {
        if (!row.id) {
            out.push(row);
            continue;
        }
        const previous = seen.get(row.id);
        if (!previous) {
            seen.set(row.id, row);
            out.push(row);
            continue;
        }
        if (row.days > previous.days) {
            previous.start = row.start;
            previous.end = row.end;
            previous.days = row.days;
            previous.source = row.source;
            previous.fragment = row.fragment;
        }
    }
    return out;
}

function clipCoveredDates(rows) {
    const covered = new Set();
    const kept = [];
    let duplicateDays = 0;
    for (const row of rows) {
        if (!row.start) {
            kept.push(row);
            continue;
        }
        const end = row.end || row.start;
        const dates = eachDate(row.start, end);
        if (!dates.length) {
            kept.push(row);
            continue;
        }
        const fresh = dates.filter((date) => !covered.has(date));
        if (!fresh.length) {
            duplicateDays += row.days;
            continue;
        }
        const take = Math.min(row.days, fresh.length);
        const used = fresh.slice(0, take);
        used.forEach((date) => covered.add(date));
        duplicateDays += Math.max(0, row.days - take);
        kept.push({
            ...row,
            start: used[0],
            end: used[used.length - 1],
            days: take,
            fragment: row.fragment && used.length === 1,
        });
    }
    return { rows: kept, duplicateDays };
}

function mergeSystemFragments(rows) {
    const merged = [];
    for (const row of rows) {
        const last = merged[merged.length - 1];
        const touches = last && row.start && row.start === addDays(last.end, 1);
        if (last && touches && last.fragment && row.fragment) {
            last.end = row.end || row.start;
            last.days += row.days;
            continue;
        }
        merged.push({ ...row });
    }
    return merged;
}

function prepareLeaves(leaveRecords) {
    const skipped = { pendingDays: 0, rejectedDays: 0 };
    const normalized = [];
    for (const row of Array.isArray(leaveRecords) ? leaveRecords : []) {
        if (!row || !isAnnualLeave(row)) continue;
        const status = statusOf(row);
        const start = dateKey(row?.startDate || row?.fromDate);
        const end = dateKey(row?.endDate || row?.toDate) || start;
        const days = countedDays(row, start, end);
        if (SKIPPED_STATUS.has(status)) {
            if (status === 'pending') skipped.pendingDays += days;
            else skipped.rejectedDays += days;
            continue;
        }
        const next = normalizeLeave(row);
        if (next) normalized.push(next);
    }
    normalized.sort((a, b) => {
        if (a.start !== b.start) return a.start < b.start ? -1 : 1;
        return b.days - a.days;
    });
    const unique = dedupeById(normalized);
    const clipped = clipCoveredDates(unique);
    const merged = mergeSystemFragments(clipped.rows).filter((row) => row.days > 0 && row.start);
    merged.sort((a, b) => (a.start === b.start ? a.end.localeCompare(b.end) : a.start < b.start ? -1 : 1));
    return {
        leaves: merged.map((row, index) => ({
            id: row.id || `leave-${index + 1}`,
            start: row.start,
            end: row.end,
            days: row.days,
            source: row.source,
            byCycle: {},
            advanceByCycle: {},
            excess: 0,
        })),
        skipped,
        duplicateDays: clipped.duplicateDays,
    };
}

function makeCycle(joiningDate, index, allowed) {
    const startDate = index === 1 ? joiningDate : addCalendarMonths(joiningDate, (index - 1) * 12);
    const endDate = twelveMonthPeriodEnd(startDate);
    if (!isDateKey(startDate) || !isDateKey(endDate)) return null;
    return {
        index,
        startDate,
        endDate,
        entitlement: allowed,
        deducted: 0,
        expired: 0,
        remaining: allowed,
        allocations: {},
    };
}

function cyclesThrough(joiningDate, asOf, allowed) {
    const cycles = [];
    if (!isDateKey(joiningDate) || !isDateKey(asOf) || joiningDate > asOf) return cycles;
    for (let index = 1; index <= MAX_CYCLES; index += 1) {
        const cycle = makeCycle(joiningDate, index, allowed);
        if (!cycle || cycle.startDate > asOf) break;
        cycles.push(cycle);
    }
    return cycles;
}

function extendThroughLeave(cycles, joiningDate, leaveStart, allowed) {
    if (!isDateKey(leaveStart)) return;
    while (cycles.length < MAX_CYCLES) {
        const last = cycles[cycles.length - 1];
        if (last && leaveStart <= last.endDate) return;
        const next = makeCycle(joiningDate, cycles.length + 1, allowed);
        if (!next) return;
        cycles.push(next);
        if (leaveStart <= next.endDate) return;
    }
}

function homeIndex(cycles, start) {
    const found = cycles.findIndex((cycle) => start >= cycle.startDate && start <= cycle.endDate);
    if (found >= 0) return found;
    if (cycles.length && start < cycles[0].startDate) return 0;
    return -1;
}

function takeFromCycle(cycle, leave, amount, advance) {
    const room = cycle.entitlement - cycle.deducted;
    const used = Math.min(Math.max(0, room), Math.max(0, amount));
    if (!used) return 0;
    cycle.deducted += used;
    cycle.allocations[leave.id] = (cycle.allocations[leave.id] || 0) + used;
    leave.byCycle[cycle.index] = (leave.byCycle[cycle.index] || 0) + used;
    if (advance) leave.advanceByCycle[cycle.index] = (leave.advanceByCycle[cycle.index] || 0) + used;
    return used;
}

function allocateLeave(cycles, leave, joiningDate, allowed) {
    extendThroughLeave(cycles, joiningDate, leave.start, allowed);
    const home = homeIndex(cycles, leave.start);
    if (home < 0) {
        leave.excess = leave.days;
        return;
    }
    let left = leave.days;
    const order = [];
    if (home > 0) order.push(home - 1);
    order.push(home);
    for (const index of order) {
        if (left <= 0) break;
        left -= takeFromCycle(cycles[index], leave, left, false);
    }
    if (left > 0) {
        if (home + 1 === cycles.length && cycles.length < MAX_CYCLES) {
            const next = makeCycle(joiningDate, cycles.length + 1, allowed);
            if (next) cycles.push(next);
        }
        if (home + 1 < cycles.length) left -= takeFromCycle(cycles[home + 1], leave, left, true);
    }
    leave.excess = left;
}

function applyExpiry(cycles, asOf) {
    let expiredLeave = 0;
    for (let index = 0; index < cycles.length; index += 1) {
        const cycle = cycles[index];
        const unused = Math.max(0, cycle.entitlement - cycle.deducted);
        const following = cycles[index + 1];
        const expired = following && isDateKey(asOf) && asOf > following.endDate ? unused : 0;
        cycle.expired = expired;
        cycle.remaining = unused - expired;
        expiredLeave += expired;
    }
    return expiredLeave;
}

function sum(values) {
    return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

/**
 * Build the entitlement, utilization, and excess view for one employee.
 * Pure: records are not changed, and repeating the call cannot deduct twice.
 */
export function buildLeaveEntitlementCalculation({
    joiningDate = '',
    asOf = '',
    leaveRecords = [],
    allowedDays = ANNUAL_LEAVE_DAYS_PER_CYCLE,
    firstEligibilityDate = '',
} = {}) {
    const allowed = Math.max(1, Math.round(Number(allowedDays) || ANNUAL_LEAVE_DAYS_PER_CYCLE));
    const joining = dateKey(joiningDate);
    const asOfDate = dateKey(asOf);
    const eligibility = dateKey(firstEligibilityDate);
    if (!isDateKey(joining)) {
        return emptyResult('Add a contract joining date to calculate annual leave entitlement.', allowed);
    }
    if (!isDateKey(asOfDate)) {
        return emptyResult('A salary period is required before leave entitlement can be calculated.', allowed);
    }
    if (joining > asOfDate) {
        return emptyResult('Leave cycles start on the contract joining date.', allowed);
    }

    const prepared = prepareLeaves(leaveRecords);
    const cycles = cyclesThrough(joining, asOfDate, allowed);
    for (const leave of prepared.leaves) allocateLeave(cycles, leave, joining, allowed);
    const expiredLeave = applyExpiry(cycles, asOfDate);

    const leaves = prepared.leaves.map((leave, index) => {
        const allocations = cycles.map((cycle) => leave.byCycle[cycle.index] || 0);
        const advance = cycles.map((cycle) => leave.advanceByCycle[cycle.index] || 0);
        const allocated = sum(allocations);
        return {
            index: index + 1,
            id: leave.id,
            startDate: leave.start,
            endDate: leave.end,
            days: leave.days,
            allocated,
            excess: leave.excess,
            allocations,
            advance,
            beforeFirstEligibility: Boolean(eligibility && leave.start < eligibility),
        };
    });

    const cycleRows = cycles.map((cycle) => ({
        index: cycle.index,
        startDate: cycle.startDate,
        endDate: cycle.endDate,
        entitlement: cycle.entitlement,
        deducted: cycle.deducted,
        expired: cycle.expired,
        remaining: cycle.remaining,
        allocations: leaves.map((leave) => cycle.allocations[leave.id] || 0),
    }));

    const totalEntitlement = sum(cycleRows.map((cycle) => cycle.entitlement));
    const totalDeducted = sum(cycleRows.map((cycle) => cycle.deducted));
    const totalLeaveTaken = sum(leaves.map((leave) => leave.days));
    const excessLeave = sum(leaves.map((leave) => leave.excess));
    const advanceDays = sum(leaves.map((leave) => sum(leave.advance)));

    return {
        ok: true,
        message: '',
        allowedDaysPerCycle: allowed,
        totalEntitlement,
        totalLeaveTaken,
        totalDeducted,
        excessLeave,
        expiredLeave,
        advanceDays,
        skippedPendingDays: prepared.skipped.pendingDays,
        skippedRejectedDays: prepared.skipped.rejectedDays,
        firstEligibilityDate: eligibility,
        cycles: cycleRows,
        leaves,
    };
}
