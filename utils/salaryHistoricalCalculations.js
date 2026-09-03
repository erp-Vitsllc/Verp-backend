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

export const INACTIVE_LEAVE = new Set(['cancelled', 'rejected', 'pending', 'draft']);
export const LOCKED_STATUSES = new Set(['locked', 'created']);

export const MESSAGES = {
    verpAfterJoining: 'VERP salary start date must be after the contract joining date.',
    leaveOverlap: 'This leave period overlaps with an existing record.',
    leaveOutsidePeriod: 'Leave dates cannot be before the contract joining date.',
    leaveCountRequired: 'Enter a day count for this leave record.',
    leaveDatesRequired: 'This leave type requires a start date and an end date.',
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
    notAwaitingHr: 'This salary profile is not waiting for HR approval.',
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

export function policyLeaveWorkingDays(policy, fallback) {
    const leaveDays = Number(policy?.leaveSalaryWorkingDays);
    if (Number.isFinite(leaveDays) && leaveDays > 0) return leaveDays;
    const eligibleDays = Number(policy?.workingDaysRequiredToEligible);
    if (Number.isFinite(eligibleDays) && eligibleDays > 0) return eligibleDays;
    return resolveEntitlementDays(fallback);
}

/** Subtract the policy leave-day threshold until remaining days are below it. */
export function countPolicyEntitlements(days, threshold) {
    const step = Number(threshold);
    if (!Number.isFinite(step) || step <= 0) return { count: 0, remainder: Math.max(0, Number(days) || 0) };
    let remaining = Number(days) || 0;
    let count = 0;
    while (remaining >= step) {
        remaining -= step;
        count += 1;
        if (count > 500) break;
    }
    return { count, remainder: remaining };
}

export function leaveTicketEligibility({
    days,
    leaveWorkingDays,
    airTicketWorkingDays,
    basicSalary,
} = {}) {
    const { count, remainder } = countPolicyEntitlements(days, leaveWorkingDays);
    const basic = Math.max(0, Number(basicSalary) || 0);
    const ticketDays = Math.max(0, Number(airTicketWorkingDays) || 0);
    return {
        count,
        remainder,
        eligibleLeaveSalary: basic * count,
        eligibleTicketDays: ticketDays * count,
    };
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

export function enrollmentRecordOverlapsPeriod(from, to, period) {
    if (!isDateKey(period?.start) || !isDateKey(period?.end)) return false;
    const a = isDateKey(from) ? from : isDateKey(to) ? to : '';
    const b = isDateKey(to) ? to : a;
    if (!isDateKey(a) || !isDateKey(b)) return false;
    return rangesOverlap(a, b, period.start, period.end);
}

export function leaveRecordPeriodRange(row) {
    return {
        from: row?.fromDate || row?.startDate || '',
        to: row?.toDate || row?.endDate || row?.fromDate || row?.startDate || '',
    };
}

export function annualLeavePeriodRange(row) {
    return {
        from: row?.startDate || row?.fromDate || '',
        to: row?.endDate || row?.toDate || row?.startDate || '',
    };
}

export function paymentCyclePeriodRange(row) {
    const from =
        row?.eligibilityStartDate ||
        row?.leaveSalaryPaymentDate ||
        row?.ticketPaymentDate ||
        row?.paymentDate ||
        '';
    const to = row?.eligibilityEndDate || from;
    return { from, to };
}

export function partitionEnrollmentRows(rows, period, getRange) {
    const archived = [];
    const kept = [];
    for (const row of Array.isArray(rows) ? rows : []) {
        const range = typeof getRange === 'function' ? getRange(row) || {} : {};
        if (enrollmentRecordOverlapsPeriod(range.from, range.to, period)) archived.push(row);
        else kept.push(row);
    }
    return { archived, kept };
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

export function isDatedLeaveType(type) {
    return String(type || '').toLowerCase() === 'annual';
}

export function isOptionalDateLeaveType(type) {
    return String(type || '').toLowerCase() === 'sick';
}

export function isCountOnlyLeaveType(type) {
    const key = String(type || '').toLowerCase();
    return key === 'authorized' || key === 'unauthorized';
}

export function normalizeLeaveSourceKey(value) {
    const raw = String(value || 'manual').trim().toLowerCase();
    if (raw === 'erp' || raw === 'system') return 'system';
    return 'manual';
}

export function consolidateCountOnlyLeaveRecords(rows, policyMultipliers) {
    const kept = [];
    const buckets = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        const type = String(row?.leaveType || '').toLowerCase();
        if (!isCountOnlyLeaveType(type)) {
            kept.push(row);
            continue;
        }
        const source = normalizeLeaveSourceKey(row?.source);
        const key = `${type}|${source}`;
        const days = Math.max(
            0,
            Number(row?.eligibleWorkingDays ?? row?.actualDays ?? row?.calendarDays) || 0,
        );
        const multiplier = leaveMultiplier(type, row?.multiplier ?? row?.rule, policyMultipliers);
        const existing = buckets.get(key);
        if (!existing) {
            buckets.set(key, {
                ...row,
                leaveType: type,
                source,
                fromDate: '',
                toDate: '',
                startDate: '',
                endDate: '',
                eligibleWorkingDays: days,
                actualDays: days,
                calendarDays: days,
                multiplier,
                rule: multiplier,
                deductionDays: days * multiplier,
                deduction: days * multiplier,
            });
            continue;
        }
        existing.eligibleWorkingDays += days;
        existing.actualDays += days;
        existing.calendarDays += days;
        existing.deductionDays = existing.eligibleWorkingDays * existing.multiplier;
        existing.deduction = existing.deductionDays;
    }
    return [...kept, ...buckets.values()];
}

export function validateLeaveDates(row, periodStart, periodEnd) {
    const type = String(row?.leaveType || '').toLowerCase();
    const needsDates = isDatedLeaveType(type);
    const from = row?.fromDate || row?.startDate;
    const to = row?.toDate || row?.endDate;
    const hasFrom = isDateKey(from);
    const hasTo = isDateKey(to);
    const count = Math.max(0, Number(row?.eligibleWorkingDays ?? row?.actualDays ?? row?.calendarDays) || 0);
    const datesRequiredMessage =
        type === 'annual' ? MESSAGES.annualLeaveDatesRequired : MESSAGES.leaveDatesRequired;
    if (!hasFrom && !hasTo) {
        if (needsDates) return datesRequiredMessage;
        return count > 0 ? '' : MESSAGES.leaveCountRequired;
    }
    if (!hasFrom || !hasTo) {
        return needsDates
            ? datesRequiredMessage
            : 'Enter both a start date and an end date, or leave both blank.';
    }
    if (to < from) return MESSAGES.endBeforeStart;
    if (periodStart && (from < periodStart || to < periodStart)) {
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
    if (cycle?.reduceHistoricalWorkingDays === false) return false;
    const payment = String(cycle?.paymentStatus || cycle?.status || '').toLowerCase();
    const verification = String(cycle?.verificationStatus || '').toLowerCase();
    if (payment === 'cancelled' || payment === 'rejected' || verification === 'rejected') return false;
    if (payment === 'draft') return false;
    const paid = payment === 'paid';
    if (!paid) return false;
    const entitlement = Number(cycle?.entitlementDays ?? cycle?.qualifyingDays);
    return Number.isFinite(entitlement) ? entitlement > 0 : resolveEntitlementDays(cycleDays) > 0;
}

export function cycleAnnualLeaveConsumeKey(cycle) {
    const key = String(cycle?.annualLeaveKey || '').trim();
    if (key) return `leave:${key}`;
    const from = String(cycle?.eligibilityStartDate || '').trim();
    const to = String(cycle?.eligibilityEndDate || '').trim();
    if (from || to) return `dates:${from}|${to}`;
    return '';
}

export function annualLeaveConsumeKey(row) {
    const from = String(row?.fromDate || row?.startDate || '').trim();
    const to = String(row?.toDate || row?.endDate || '').trim();
    if (from || to) return `dates:${from}|${to}`;
    const id = String(row?._id || row?.id || '').trim();
    return id ? `id:${id}` : '';
}

export function isConsumingAnnualLeave(row) {
    if (!isActiveLeave(row)) return false;
    return row?.reduceHistoricalWorkingDays === true;
}

/** Count a policy leave-day reduction only once per annual leave. */
export function uniqueConsumingCycles(paymentCycles = [], cycleDays) {
    const seen = new Set();
    const out = [];
    for (const row of paymentCycles || []) {
        if (!isConsumingCycle(row, cycleDays)) continue;
        const key = cycleAnnualLeaveConsumeKey(row);
        if (key) {
            if (seen.has(key)) continue;
            seen.add(key);
        }
        out.push(row);
    }
    return out;
}

export function uniqueEntitlementConsumers({
    paymentCycles = [],
    annualLeaveRecords = [],
    cycleDays,
} = {}) {
    const seen = new Set();
    const annual = [];
    for (const row of annualLeaveRecords || []) {
        if (!isConsumingAnnualLeave(row)) continue;
        const key = annualLeaveConsumeKey(row);
        if (key) {
            if (seen.has(key)) continue;
            seen.add(key);
        }
        annual.push(row);
    }
    const cycles = [];
    for (const row of paymentCycles || []) {
        if (!isConsumingCycle(row, cycleDays)) continue;
        const key = cycleAnnualLeaveConsumeKey(row);
        if (key) {
            if (seen.has(key)) continue;
            seen.add(key);
        }
        cycles.push(row);
    }
    return {
        annual,
        cycles,
        count: annual.length + cycles.length,
    };
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
    compoff_leave: 'annual',
};

export const OWNED_LEAVE_REQUEST_STATUSES = new Set(['approved', 'pending']);

/** Leave this employee owns: marked leave days, plus their approved/pending leave requests. */
export function resolveOwnedAttendanceLeave(row) {
    const statusKey = String(row?.statusKey || '').trim();
    const statusType = LIVE_LEAVE_STATUS_MAP[statusKey];
    if (statusType) {
        return { leaveType: statusType, status: 'approved' };
    }
    const requestStatus = String(row?.leaveRequestStatus || '').trim().toLowerCase();
    if (!OWNED_LEAVE_REQUEST_STATUSES.has(requestStatus)) return null;
    const requestedType = LIVE_LEAVE_STATUS_MAP[String(row?.requestedStatusKey || '').trim()];
    if (!requestedType) return null;
    return {
        leaveType: requestedType,
        status: requestStatus === 'pending' ? 'pending' : 'approved',
    };
}

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
        const owned = resolveOwnedAttendanceLeave(row);
        if (owned) {
            const date = String(row.date).trim();
            leaveRecords.push({
                leaveType: owned.leaveType,
                fromDate: date,
                toDate: date,
                eligibleWorkingDays: 1,
                actualDays: 1,
                calendarDays: 1,
                source: 'system',
                status: owned.status,
            });
            continue;
        }
        const key = String(row?.statusKey || '').trim();
        if (LIVE_WORKING_STATUS_KEYS.has(key)) workingDays += 1;
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
    const consumers = uniqueEntitlementConsumers({
        paymentCycles,
        annualLeaveRecords,
        cycleDays: entitlementDays,
    });
    const consumedEntitlementDays = consumers.count * entitlementDays;
    const remainingAfterCycles = netQualifyingDays - consumedEntitlementDays;
    const eligibleBalance = remainingAfterCycles;
    const daysRequired = Math.max(0, entitlementDays - eligibleBalance);
    const availableCycles = countPolicyEntitlements(eligibleBalance, entitlementDays).count;
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
        paidVerifiedCycles: consumers.cycles.length,
        consumedAnnualLeaveCycles: consumers.annual.length,
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
