/**
 * Pure historical-salary calculation and validation.
 * Entitlement cycle length comes from payroll settings (leaveSalaryWorkingDays),
 * not from callers hard-coding a number.
 */

export const DEFAULT_ENTITLEMENT_DAYS = 300;

export const LEAVE_MULTIPLIERS = {
    sick: 1,
    authorized: 1,
    unauthorized: 2,
    annual: 1,
};

export const INACTIVE_LEAVE = new Set(['cancelled', 'rejected']);
export const LOCKED_STATUSES = new Set(['locked', 'created']);

export const MESSAGES = {
    verpAfterJoining: 'VERP salary start date must be after the contract joining date.',
    leaveOverlap: 'This leave period overlaps with an existing record.',
    leaveOutsidePeriod: 'Leave dates must be within the historical calculation period.',
    leaveCountRequired: 'Enter a day count for this leave record.',
    annualLeaveDatesRequired: 'Annual leave requires a start date and an end date.',
    cycleAlreadyConsumed: 'This entitlement cycle has already consumed qualifying days.',
    completeBeforeCreate: 'Complete and verify all required sections before creating the salary profile.',
    joiningDateHrOnly: 'Only an authorized HR user can modify the contract joining date.',
    reopenReasonRequired: 'A reason is required before reopening a locked historical profile.',
    endBeforeStart: 'End date cannot be earlier than start date.',
    lockedReadOnly: 'This historical profile is locked. Reopen it to make changes.',
    joiningReasonRequired: 'A reason is required to change the contract joining date.',
    awaitingHrApproval: 'This salary profile is waiting for flowchart HR approval.',
    alreadyAwaitingHr: 'This salary profile is already sent for HR approval.',
    rejectReasonRequired: 'A rejection description is required.',
    createdProfileHrOnly: 'Only flowchart HR can update a created salary profile.',
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function isDateKey(value) {
    return ISO.test(String(value || '').trim());
}

export function resolveEntitlementDays(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_ENTITLEMENT_DAYS;
}

export function resolveLeaveMultiplierValue(value) {
    if (value === '' || value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

export function policyLeaveMultipliers(policy) {
    return {
        sick: resolveLeaveMultiplierValue(policy?.sickLeaveDeductionDays) ?? LEAVE_MULTIPLIERS.sick,
        authorized:
            resolveLeaveMultiplierValue(policy?.authorizedLeaveDeductionDays) ?? LEAVE_MULTIPLIERS.authorized,
        unauthorized:
            resolveLeaveMultiplierValue(policy?.unauthorizedLeaveDeductionDays) ?? LEAVE_MULTIPLIERS.unauthorized,
        annual: resolveLeaveMultiplierValue(policy?.annualLeaveDeductionDays) ?? LEAVE_MULTIPLIERS.annual,
    };
}

export function formatLeaveMultiplier(value) {
    const n = resolveLeaveMultiplierValue(value);
    if (n == null) return '1';
    return String(Number(n.toFixed(2)));
}

export function leaveMultiplier(leaveType, explicit, policyMultipliers) {
    const fromRecord = resolveLeaveMultiplierValue(explicit);
    if (fromRecord != null) return fromRecord;
    const type = String(leaveType || '').toLowerCase();
    const fromPolicy = resolveLeaveMultiplierValue(policyMultipliers?.[type]);
    if (fromPolicy != null) return fromPolicy;
    return LEAVE_MULTIPLIERS[type] || 1;
}

export function inclusiveCalendarDays(from, to) {
    if (!isDateKey(from) || !isDateKey(to) || to < from) return 0;
    const a = new Date(`${from}T00:00:00`);
    const b = new Date(`${to}T00:00:00`);
    return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
}

export function addDays(key, days) {
    if (!isDateKey(key)) return '';
    const d = new Date(`${key}T00:00:00`);
    d.setDate(d.getDate() + Number(days || 0));
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

export function historicalPeriod(joiningDate, verpStartDate) {
    if (!isDateKey(joiningDate) || !isDateKey(verpStartDate)) {
        return { start: joiningDate || '', end: '', calendarDays: 0 };
    }
    const end = addDays(verpStartDate, -1);
    return {
        start: joiningDate,
        end,
        calendarDays: end >= joiningDate ? inclusiveCalendarDays(joiningDate, end) : 0,
    };
}

export function validateVerpStart(joiningDate, verpStartDate) {
    if (!isDateKey(verpStartDate)) return 'VERP salary processing start date is required.';
    if (joiningDate && verpStartDate <= joiningDate) return MESSAGES.verpAfterJoining;
    return '';
}

export function rangesOverlap(aFrom, aTo, bFrom, bTo) {
    if (!isDateKey(aFrom) || !isDateKey(aTo) || !isDateKey(bFrom) || !isDateKey(bTo)) return false;
    return aFrom <= bTo && bFrom <= aTo;
}

export function isActiveLeave(row) {
    return !INACTIVE_LEAVE.has(String(row?.status || '').toLowerCase());
}

export function leaveDeductionDays(row, policyMultipliers) {
    if (!isActiveLeave(row)) return 0;
    const eligible = Math.max(0, Number(row?.eligibleWorkingDays ?? row?.actualDays) || 0);
    const multiplier = leaveMultiplier(row?.leaveType, row?.multiplier ?? row?.rule, policyMultipliers);
    const stored = Number(row?.deductionDays ?? row?.deduction);
    if (Number.isFinite(stored) && stored > 0) return stored;
    return eligible * multiplier;
}

export function findOverlappingLeave(records) {
    const rows = (Array.isArray(records) ? records : []).filter(isActiveLeave);
    const seen = new Set();
    const unique = [];
    rows.forEach((row) => {
        const key = [
            String(row?.leaveType || '').toLowerCase(),
            row?.fromDate || row?.startDate || '',
            row?.toDate || row?.endDate || '',
        ].join('|');
        if (seen.has(key)) return;
        seen.add(key);
        unique.push(row);
    });
    for (let i = 0; i < unique.length; i += 1) {
        for (let j = i + 1; j < unique.length; j += 1) {
            const typeA = String(unique[i]?.leaveType || '').toLowerCase();
            const typeB = String(unique[j]?.leaveType || '').toLowerCase();
            if (typeA && typeB && typeA !== typeB) continue;
            if (
                rangesOverlap(
                    unique[i].fromDate || unique[i].startDate,
                    unique[i].toDate || unique[i].endDate,
                    unique[j].fromDate || unique[j].startDate,
                    unique[j].toDate || unique[j].endDate,
                )
            ) {
                return { a: unique[i], b: unique[j] };
            }
        }
    }
    return null;
}

export function validateLeaveDates(row, periodStart, periodEnd) {
    const type = String(row?.leaveType || '').toLowerCase();
    const isAnnual = type === 'annual';
    const from = row?.fromDate || row?.startDate;
    const to = row?.toDate || row?.endDate;
    const hasFrom = isDateKey(from);
    const hasTo = isDateKey(to);
    const count = Math.max(0, Number(row?.eligibleWorkingDays ?? row?.actualDays ?? row?.calendarDays) || 0);
    if (!hasFrom && !hasTo) {
        if (isAnnual) return MESSAGES.annualLeaveDatesRequired;
        return count > 0 ? '' : MESSAGES.leaveCountRequired;
    }
    if (!hasFrom || !hasTo) {
        return isAnnual ? MESSAGES.annualLeaveDatesRequired : 'Leave start and end dates are required.';
    }
    if (to < from) return MESSAGES.endBeforeStart;
    if (periodStart && periodEnd && (from < periodStart || to > periodEnd)) {
        return MESSAGES.leaveOutsidePeriod;
    }
    return '';
}

export function summarizeLeaveDeductions(leaveRecords, annualLeaveRecords = [], policyMultipliers) {
    const rows = [...(leaveRecords || []), ...(annualLeaveRecords || []).map((row) => ({
        ...row,
        leaveType: 'annual',
        fromDate: row.fromDate || row.startDate,
        toDate: row.toDate || row.endDate,
        eligibleWorkingDays: row.eligibleWorkingDays ?? row.actualDays,
        multiplier: leaveMultiplier('annual', row?.multiplier ?? row?.rule, policyMultipliers),
    }))];

    const totals = { sick: 0, authorized: 0, unauthorized: 0, annual: 0, total: 0 };
    rows.forEach((row) => {
        const type = String(row?.leaveType || 'sick').toLowerCase();
        const days = leaveDeductionDays(row, policyMultipliers);
        if (type === 'sick') totals.sick += days;
        else if (type === 'authorized') totals.authorized += days;
        else if (type === 'unauthorized') totals.unauthorized += days;
        else if (type === 'annual') totals.annual += days;
        totals.total += days;
    });
    return totals;
}

export function isConsumingCycle(cycle, cycleDays) {
    const payment = String(cycle?.paymentStatus || cycle?.status || '').toLowerCase();
    const verification = String(cycle?.verificationStatus || '').toLowerCase();
    if (payment === 'cancelled' || payment === 'rejected' || verification === 'rejected') return false;
    if (payment === 'draft') return false;
    const paid = payment === 'paid';
    if (!paid) return false;
    const entitlement = Number(cycle?.entitlementDays ?? cycle?.qualifyingDays);
    return Number.isFinite(entitlement) ? entitlement > 0 : resolveEntitlementDays(cycleDays) > 0;
}

export const LIVE_WORKING_STATUS_KEYS = new Set([
    'on_office',
    'work_from_home',
    'late_arrived',
    'early_go',
    'mispunch',
]);

export const LIVE_LEAVE_STATUS_MAP = {
    authorized_leave: 'authorized',
    unauthorized_leave: 'unauthorized',
    sick_leave: 'sick',
    on_leave: 'annual',
};

/**
 * Map daily attendance rows (after VERP start) into working days + leave deductions.
 * Policy multipliers are applied later by calculateHistoricalEligibility.
 */
export function summarizeAttendanceEligibility(rows = []) {
    const byDate = new Map();
    (Array.isArray(rows) ? rows : []).forEach((row) => {
        const date = String(row?.date || '').trim();
        if (!isDateKey(date)) return;
        byDate.set(date, row);
    });

    let workingDays = 0;
    const leaveRecords = [];
    for (const row of byDate.values()) {
        const key = String(row?.statusKey || '').trim();
        if (LIVE_WORKING_STATUS_KEYS.has(key)) {
            workingDays += 1;
            continue;
        }
        const leaveType = LIVE_LEAVE_STATUS_MAP[key];
        if (!leaveType) continue;
        const date = String(row.date).trim();
        leaveRecords.push({
            leaveType,
            fromDate: date,
            toDate: date,
            eligibleWorkingDays: 1,
            actualDays: 1,
            calendarDays: 1,
            source: 'system',
            status: 'approved',
        });
    }
    return { workingDays, leaveRecords };
}

export function calculateHistoricalEligibility({
    workingDays = 0,
    calendarDays = 0,
    leaveRecords = [],
    annualLeaveRecords = [],
    paymentCycles = [],
    cycleDays,
    leaveMultipliers,
} = {}) {
    const entitlementDays = resolveEntitlementDays(cycleDays);
    const leave = summarizeLeaveDeductions(leaveRecords, annualLeaveRecords, leaveMultipliers);
    const working = Number(workingDays) || 0;
    const calendar = Number(calendarDays) || 0;
    const netQualifyingDays = working - leave.total;
    const consuming = (paymentCycles || []).filter((row) => isConsumingCycle(row, entitlementDays));
    const consumedEntitlementDays = consuming.length * entitlementDays;
    const remainingAfterCycles = netQualifyingDays - consumedEntitlementDays;
    const eligibleBalance = remainingAfterCycles;
    const daysRequired = Math.max(0, entitlementDays - eligibleBalance);
    const availableCycles =
        eligibleBalance >= entitlementDays ? Math.floor(eligibleBalance / entitlementDays) : 0;
    const towardCycle = eligibleBalance > 0 ? eligibleBalance % entitlementDays : 0;
    const progressFill = eligibleBalance >= entitlementDays ? entitlementDays : towardCycle;

    return {
        calendarDays: calendar,
        workingDays: working,
        sickDeduction: leave.sick,
        authorizedDeduction: leave.authorized,
        unauthorizedDeduction: leave.unauthorized,
        annualDeduction: leave.annual,
        totalLeaveDeduction: leave.total,
        netQualifyingDays,
        paidVerifiedCycles: consuming.length,
        consumedEntitlementDays,
        remainingAfterCycles,
        eligibleBalance,
        daysRequired,
        availableCycles,
        eligibleForBenefit: eligibleBalance >= entitlementDays,
        cycleDays: entitlementDays,
        progressFill,
        towardCycle,
    };
}

export function workflowIsLocked(status) {
    return LOCKED_STATUSES.has(String(status || '').toLowerCase());
}

export function canEditProfile({ workflowStatus, canEdit } = {}) {
    const status = String(workflowStatus || '').toLowerCase();
    if (status === 'pending_hr') return false;
    return Boolean(canEdit) && !workflowIsLocked(workflowStatus);
}

export function canReopenProfile({ workflowStatus, canEdit } = {}) {
    return Boolean(canEdit) && workflowIsLocked(workflowStatus);
}

export function hasRequiredText(value) {
    return Boolean(String(value || '').trim());
}

export function buildReadinessItems({
    joiningDate,
    verpStartDate,
    periodEnd,
    workingDaysCalculated,
    companyMolCode,
    employeeMolId,
    leaveComplete,
    annualComplete,
    benefitsComplete,
    cyclesVerified,
    noOverlap,
    noErrors,
    verified,
} = {}) {
    const items = [
        { key: 'employeeJoining', label: 'Contract joining date available', done: Boolean(joiningDate) },
        { key: 'verpStart', label: 'VERP salary-processing start date entered', done: Boolean(verpStartDate) },
        { key: 'period', label: 'Historical period calculated', done: Boolean(joiningDate && periodEnd) },
        { key: 'workingDays', label: 'Historical working days calculated', done: Boolean(workingDaysCalculated) },
        { key: 'leave', label: 'Existing leave history completed', done: Boolean(leaveComplete) },
        { key: 'annual', label: 'Annual leave history completed', done: Boolean(annualComplete) },
        { key: 'benefits', label: 'Previous leave salary and ticket details completed', done: Boolean(benefitsComplete) },
        { key: 'cycles', label: 'All payment cycles verified', done: Boolean(cyclesVerified) },
        { key: 'overlap', label: 'No duplicate or overlapping records', done: Boolean(noOverlap) },
        { key: 'errors', label: 'No calculation errors', done: Boolean(noErrors) },
        { key: 'verified', label: 'HR verification completed', done: Boolean(verified) },
    ];
    const completed = items.filter((row) => row.done).length;
    const percent = Math.round((completed / items.length) * 100);
    return {
        items,
        completed,
        total: items.length,
        percent,
        canVerify: items.filter((row) => row.key !== 'verified').every((row) => row.done),
        canCreate: items.every((row) => row.done),
    };
}

export function findDuplicateConsumingCycles(paymentCycles = [], cycleDays) {
    const seen = new Set();
    for (const cycle of paymentCycles) {
        if (!isConsumingCycle(cycle, cycleDays)) continue;
        const key = String(cycle.cycleNumber || '');
        if (!key) continue;
        if (seen.has(key)) return cycle;
        seen.add(key);
    }
    return null;
}

export function allCyclesVerified(paymentCycles = []) {
    const rows = Array.isArray(paymentCycles) ? paymentCycles : [];
    if (!rows.length) return true;
    return rows.every((row) => {
        const payment = String(row?.paymentStatus || row?.status || '').toLowerCase();
        const verification = String(row?.verificationStatus || '').toLowerCase();
        if (payment === 'cancelled' || payment === 'rejected') return true;
        return payment === 'paid' && (verification === 'verified' || (!row?.verificationStatus && payment === 'paid'));
    });
}

export function stepStatus({ done, current, error, verified }) {
    if (error) return 'error';
    if (verified) return 'verified';
    if (done) return 'completed';
    if (current) return 'incomplete';
    return 'not_started';
}
