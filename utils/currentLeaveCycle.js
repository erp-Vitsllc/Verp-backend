/**
 * Current annual-leave cycle: after the employee takes annual leave,
 * pending / eligible working days restart the next day — days before that
 * leave are not counted again.
 */
import {
    addDays,
    countPolicyEntitlements,
    historicalPeriod,
    isActiveLeave,
    isDateKey,
    policyLeaveMultipliers,
    policyLeaveWorkingDays,
    summarizeLeaveDeductions,
    toSalaryDateKey,
} from './salaryHistoricalCalculations.js';

export function lastTakenAnnualLeaveEnd(annualLeaveRecords = []) {
    const ends = [];
    for (const row of Array.isArray(annualLeaveRecords) ? annualLeaveRecords : []) {
        if (!isActiveLeave(row)) continue;
        const type = String(row?.leaveType || 'annual').toLowerCase();
        if (row?.leaveType && type !== 'annual') continue;
        const end = toSalaryDateKey(row?.endDate || row?.toDate || row?.returnToWorkDate);
        if (isDateKey(end)) ends.push(end);
    }
    ends.sort();
    return ends.at(-1) || '';
}

export function lastAnnualLeaveEndFromAttendance(records = []) {
    let last = '';
    for (const row of Array.isArray(records) ? records : []) {
        if (String(row?.statusKey || '').trim() !== 'on_leave') continue;
        const date = String(row?.date || '').trim();
        if (isDateKey(date) && date > last) last = date;
    }
    return last;
}

export function leaveCycleStart({ joiningDate, lastAnnualLeaveEnd }) {
    if (isDateKey(lastAnnualLeaveEnd)) {
        return addDays(lastAnnualLeaveEnd, 1) || joiningDate || '';
    }
    return isDateKey(joiningDate) ? joiningDate : '';
}

export function laterDateKey(a, b) {
    if (!isDateKey(a)) return isDateKey(b) ? b : '';
    if (!isDateKey(b)) return a;
    return a >= b ? a : b;
}

export function cycleProgress({ accumulatedDays, requiredDays }) {
    const required = Math.max(0, Number(requiredDays) || 0);
    const days = Math.max(0, Number(accumulatedDays) || 0);
    if (required <= 0) {
        return { completedCycles: 0, eligibleDays: days, remainingDays: 0, requiredDays: 0 };
    }
    const { count, remainder } = countPolicyEntitlements(days, required);
    return {
        completedCycles: count,
        eligibleDays: remainder,
        remainingDays: Math.max(0, required - remainder),
        requiredDays: required,
    };
}

function rowWindow(row) {
    const start = toSalaryDateKey(row?.fromDate || row?.startDate);
    const end = toSalaryDateKey(row?.toDate || row?.endDate) || start;
    return { start, end };
}

export function leaveRowsInOpenCycle(rows, { cycleStart, cycleEnd, lastAnnualLeaveEnd } = {}) {
    return (Array.isArray(rows) ? rows : []).filter((row) => {
        if (!isActiveLeave(row)) return false;
        const { start, end } = rowWindow(row);
        if (!start) return true;
        if (isDateKey(lastAnnualLeaveEnd) && end === lastAnnualLeaveEnd) return false;
        if (isDateKey(cycleStart) && end < cycleStart) return false;
        if (isDateKey(cycleEnd) && start > cycleEnd) return false;
        return true;
    });
}

const ENROLL_LEAVE_STATUS = {
    sick: 'sick_leave',
    authorized: 'authorized_leave',
    unauthorized: 'unauthorized_leave',
    annual: 'on_leave',
    compoff: 'compoff_leave',
    compoff_leave: 'compoff_leave',
};

function leaveRowDays(row) {
    return Math.max(0, Number(row?.eligibleWorkingDays ?? row?.actualDays ?? row?.calendarDays) || 0);
}

export function enrollLeaveUsedByStatus({
    leaveRecords,
    annualLeaveRecords,
    cycleStart,
    cycleEnd,
    lastAnnualLeaveEnd,
    allRecords = false,
} = {}) {
    const used = {
        on_leave: 0,
        sick_leave: 0,
        authorized_leave: 0,
        unauthorized_leave: 0,
        compoff_leave: 0,
    };
    const window = { cycleStart, cycleEnd, lastAnnualLeaveEnd };
    const pick = (rows) =>
        allRecords
            ? (Array.isArray(rows) ? rows : []).filter(isActiveLeave)
            : leaveRowsInOpenCycle(rows, window);
    const nonAnnual = pick(leaveRecords).filter(
        (row) => String(row?.leaveType || '').toLowerCase() !== 'annual',
    );
    const annual = pick(
        (Array.isArray(annualLeaveRecords) ? annualLeaveRecords : []).map((row) => ({
            ...row,
            leaveType: 'annual',
        })),
    );
    for (const row of [...nonAnnual, ...annual]) {
        const type = String(row?.leaveType || '').toLowerCase();
        const statusKey = ENROLL_LEAVE_STATUS[type];
        if (!statusKey) continue;
        used[statusKey] += leaveRowDays(row);
    }
    return used;
}

export function lastTakenAnnualLeaveDays(annualLeaveRecords = [], lastAnnualLeaveEnd) {
    if (!isDateKey(lastAnnualLeaveEnd)) return 0;
    for (const row of Array.isArray(annualLeaveRecords) ? annualLeaveRecords : []) {
        if (!isActiveLeave(row)) continue;
        const type = String(row?.leaveType || 'annual').toLowerCase();
        if (row?.leaveType && type !== 'annual') continue;
        const end = toSalaryDateKey(row?.endDate || row?.toDate || row?.returnToWorkDate);
        if (end !== lastAnnualLeaveEnd) continue;
        return Math.max(0, Number(row?.eligibleWorkingDays ?? row?.actualDays ?? row?.calendarDays) || 0);
    }
    return 0;
}

export function cycleLeaveDeductions({
    leaveRecords,
    annualLeaveRecords,
    policy,
    cycleStart,
    cycleEnd,
    lastAnnualLeaveEnd,
} = {}) {
    const window = { cycleStart, cycleEnd, lastAnnualLeaveEnd };
    return summarizeLeaveDeductions(
        leaveRowsInOpenCycle(leaveRecords, window),
        leaveRowsInOpenCycle(annualLeaveRecords, window),
        policyLeaveMultipliers(policy),
    );
}

export function historicalWindowForCycle({ joiningDate, verpStartDate, cycleStart }) {
    const period = historicalPeriod(joiningDate, verpStartDate);
    const from = laterDateKey(cycleStart, period.start);
    const to = period.end;
    if (!isDateKey(from) || !isDateKey(to) || from > to) return { from: '', to: '' };
    return { from, to };
}

export function liveWindowForCycle({ verpStartDate, cycleStart, todayKey, liveOpen }) {
    if (!isDateKey(todayKey)) return { from: '', to: '' };
    if (!isDateKey(verpStartDate)) {
        const from = isDateKey(cycleStart) ? cycleStart : '';
        if (!from || from > todayKey) return { from: '', to: '' };
        return { from, to: todayKey };
    }
    if (!liveOpen) return { from: '', to: '' };
    const from = laterDateKey(cycleStart, verpStartDate);
    if (!isDateKey(from) || from > todayKey) return { from: '', to: '' };
    return { from, to: todayKey };
}

export function cycleEligibilitySnapshot({
    accumulatedDays,
    requiredDays,
    airTicketRequiredDays,
    lastAnnualLeaveEnd,
    cycleStart,
    lastAnnualLeaveDays,
} = {}) {
    const progress = cycleProgress({ accumulatedDays, requiredDays });
    const ticketNeed = Math.max(0, Number(airTicketRequiredDays) || progress.requiredDays);
    const leaveEligible = progress.requiredDays <= 0 || progress.completedCycles > 0;
    return {
        lastAnnualLeaveEnd: lastAnnualLeaveEnd || '',
        cycleStart: cycleStart || '',
        requiredPresentDays: progress.requiredDays,
        eligibleDays: progress.eligibleDays,
        completedCycles: progress.completedCycles,
        leaveEligible,
        leaveSalaryDays: Math.max(0, Number(lastAnnualLeaveDays) || 0),
        remainingDays: progress.remainingDays,
        airTicketEligible: ticketNeed > 0 && (progress.completedCycles > 0 || progress.eligibleDays >= ticketNeed),
        airTicketRequiredDays: ticketNeed,
        period: 'year',
    };
}

export function policyWorkingDayRequirement(policy) {
    return policyLeaveWorkingDays(policy);
}
