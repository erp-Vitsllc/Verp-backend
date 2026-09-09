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
    holiday: 1,
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
        holiday: LEAVE_MULTIPLIERS.holiday,
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
    if (Object.prototype.hasOwnProperty.call(LEAVE_MULTIPLIERS, type)) return LEAVE_MULTIPLIERS[type];
    return 1;
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

/** First calendar day of the VERP salary processing month (yyyy-MM-01). */
export function salaryProcessingStartDay(verpStartDate) {
    const raw = String(verpStartDate || '').trim();
    if (isDateKey(raw)) return `${raw.slice(0, 7)}-01`;
    if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
    return '';
}

/** System leave/holidays start only once today has reached that month's 1st. */
export function isSalaryProcessingMonthReached(todayKey, verpStartDate) {
    const start = salaryProcessingStartDay(verpStartDate);
    return isDateKey(todayKey) && isDateKey(start) && todayKey >= start;
}

export function liveLeaveRecordsInProcessingWindow(rows, verpStartDate, todayKey) {
    if (!isSalaryProcessingMonthReached(todayKey, verpStartDate)) return [];
    const start = salaryProcessingStartDay(verpStartDate);
    return (Array.isArray(rows) ? rows : []).filter((row) => {
        const from = String(row?.fromDate || row?.startDate || '').trim();
        if (!isDateKey(from)) return false;
        if (from < start) return false;
        return !isDateKey(todayKey) || from <= todayKey;
    });
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
    const type = String(row?.leaveType || '').toLowerCase();
    const eligible = Math.max(0, Number(row?.eligibleWorkingDays ?? row?.actualDays) || 0);
    if (type === 'holiday') {
        return eligible > 0 ? eligible : 1;
    }
    const multiplier = leaveMultiplier(type, row?.multiplier ?? row?.rule, policyMultipliers);
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
    const key = String(type || '').toLowerCase();
    return key === 'annual' || key === 'holiday';
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

    const totals = { sick: 0, authorized: 0, unauthorized: 0, annual: 0, holiday: 0, total: 0 };
    rows.forEach((row) => {
        const type = String(row?.leaveType || 'sick').toLowerCase();
        const days = leaveDeductionDays(row, policyMultipliers);
        if (type === 'holiday') totals.holiday += days;
        else if (type === 'sick') totals.sick += days;
        else if (type === 'authorized') totals.authorized += days;
        else if (type === 'unauthorized') totals.unauthorized += days;
        else if (type === 'annual') totals.annual += days;
        totals.total += days;
    });
    return totals;
}

export function cycleIncludesLeavePayment(cycle) {
    if (!cycle) return false;
    if (cycle.includeLeave === true) return true;
    if (cycle.includeLeave === false) return false;
    return Number(cycle.leaveSalaryAmount ?? cycle.leaveSalary) > 0;
}

export function cycleIncludesTicketPayment(cycle) {
    if (!cycle) return false;
    if (cycle.includeTicket === true) return true;
    if (cycle.includeTicket === false) return false;
    return Number(cycle.ticketAmount) > 0;
}

export function isConsumingCycle(cycle, cycleDays) {
    if (cycle?.reduceHistoricalWorkingDays !== true) return false;
    if (!cycleIncludesLeavePayment(cycle) && !cycleIncludesTicketPayment(cycle)) return false;
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
    holiday: 'holiday',
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
                remarks: String(row?.reason || '').trim(),
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
        holidayDays: leave.holiday,
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

export function roundMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function toSalaryDateKey(value) {
    if (!value) return '';
    if (isDateKey(value)) return String(value).trim();
    const raw = String(value).trim();
    const isoDay = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoDay) return isoDay[1];
    const d = value instanceof Date ? value : new Date(raw);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

export function addCalendarMonths(key, months) {
    if (!isDateKey(key)) return '';
    const year = Number(key.slice(0, 4));
    const month = Number(key.slice(5, 7));
    const day = Number(key.slice(8, 10));
    const totalMonths = month - 1 + Number(months || 0);
    const nextYear = year + Math.floor(totalMonths / 12);
    const monthIndex = ((totalMonths % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(nextYear, monthIndex + 1, 0)).getUTCDate();
    const nextDay = Math.min(day, lastDay);
    return `${nextYear}-${String(monthIndex + 1).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}`;
}

export function monthStartKey(monthKey) {
    return /^\d{4}-\d{2}$/.test(monthKey) ? `${monthKey}-01` : '';
}

export function monthEndKey(monthKey) {
    if (!/^\d{4}-\d{2}$/.test(monthKey)) return '';
    const year = Number(monthKey.slice(0, 4));
    const month = Number(monthKey.slice(5, 7));
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${monthKey}-${String(lastDay).padStart(2, '0')}`;
}

export function daysInCalendarMonth(monthKey) {
    if (!/^\d{4}-\d{2}$/.test(monthKey)) return 0;
    const year = Number(monthKey.slice(0, 4));
    const month = Number(monthKey.slice(5, 7));
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function minDateKey(a, b) {
    if (!isDateKey(a)) return isDateKey(b) ? b : '';
    if (!isDateKey(b)) return a;
    return a <= b ? a : b;
}

export function maxDateKey(a, b) {
    if (!isDateKey(a)) return isDateKey(b) ? b : '';
    if (!isDateKey(b)) return a;
    return a >= b ? a : b;
}

export function twelveMonthPeriodEnd(start) {
    if (!isDateKey(start)) return '';
    return addDays(addCalendarMonths(start, 12), -1);
}

export function firstDayOfNextMonth(dateKey) {
    if (!isDateKey(dateKey)) return '';
    const year = Number(dateKey.slice(0, 4));
    const month = Number(dateKey.slice(5, 7));
    if (month === 12) return `${year + 1}-01-01`;
    return `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

/** After each 12-month block, show the first day of the following month. */
export function entitlementDisplayDate(startDate, index) {
    if (!isDateKey(startDate)) return '';
    const count = Math.max(0, Math.floor(Number(index) || 0));
    let cursor = startDate;
    for (let i = 0; i <= count; i += 1) {
        cursor = firstDayOfNextMonth(addCalendarMonths(cursor, 12));
        if (!cursor) return '';
    }
    return cursor;
}

export function listMonthKeysInclusive(from, to) {
    if (!isDateKey(from) || !isDateKey(to) || to < from) return [];
    const keys = [];
    let cursor = from.slice(0, 7);
    const end = to.slice(0, 7);
    while (cursor <= end) {
        keys.push(cursor);
        const year = Number(cursor.slice(0, 4));
        const month = Number(cursor.slice(5, 7));
        cursor = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
        if (keys.length > 240) break;
    }
    return keys;
}

export function normalizeSalaryHistory(rows = []) {
    const list = (Array.isArray(rows) ? rows : [])
        .map((row) => ({
            effectiveFrom: toSalaryDateKey(row?.effectiveFrom ?? row?.fromDate),
            effectiveTo: toSalaryDateKey(row?.effectiveTo ?? row?.toDate),
            basicSalary: Math.max(0, Number(row?.basicSalary ?? row?.basic) || 0),
        }))
        .filter((row) => isDateKey(row.effectiveFrom))
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

    return list.map((row, index) => {
        const nextFrom = list[index + 1]?.effectiveFrom;
        let effectiveTo = row.effectiveTo;
        if (!effectiveTo && nextFrom) effectiveTo = addDays(nextFrom, -1);
        return { ...row, effectiveTo: effectiveTo || '' };
    });
}

export function salarySegmentsInRange(history, from, to) {
    if (!isDateKey(from) || !isDateKey(to) || to < from) return [];
    const segments = [];
    for (const row of Array.isArray(history) ? history : []) {
        if (!isDateKey(row?.effectiveFrom)) continue;
        if (row.effectiveFrom > to) continue;
        if (row.effectiveTo && row.effectiveTo < from) continue;
        const start = maxDateKey(row.effectiveFrom, from);
        const end = minDateKey(row.effectiveTo || to, to);
        if (!isDateKey(start) || !isDateKey(end) || end < start) continue;
        segments.push({
            from: start,
            to: end,
            basicSalary: Math.max(0, Number(row.basicSalary) || 0),
        });
    }
    return segments;
}

export function calculateLeaveSalaryForPeriod(salaryHistory, periodStart, periodEnd) {
    const history = normalizeSalaryHistory(salaryHistory);
    if (!isDateKey(periodStart) || !isDateKey(periodEnd) || periodEnd < periodStart) {
        return { leaveSalary: 0, monthlyBreakdown: [] };
    }
    const monthlyBreakdown = [];
    let total = 0;
    for (const monthKey of listMonthKeysInclusive(periodStart, periodEnd)) {
        const monthDays = daysInCalendarMonth(monthKey);
        const calendarStart = monthStartKey(monthKey);
        const calendarEnd = monthEndKey(monthKey);
        const from = maxDateKey(calendarStart, periodStart);
        const to = minDateKey(calendarEnd, periodEnd);
        if (!from || !to || to < from || monthDays <= 0) continue;
        const segments = salarySegmentsInRange(history, from, to).map((segment) => {
            const days = inclusiveCalendarDays(segment.from, segment.to);
            const accrual = (segment.basicSalary / 12) * (days / monthDays);
            return {
                from: segment.from,
                to: segment.to,
                basicSalary: segment.basicSalary,
                days,
                accrual,
                calculation: `(${segment.basicSalary} / 12) × (${days} / ${monthDays})`,
            };
        });
        const monthAccrual = segments.reduce((sum, segment) => sum + segment.accrual, 0);
        total += monthAccrual;
        const coversFullMonth = from === calendarStart && to === calendarEnd;
        const singleFullSalary =
            coversFullMonth &&
            segments.length === 1 &&
            segments[0].from === calendarStart &&
            segments[0].to === calendarEnd;
        monthlyBreakdown.push({
            month: monthKey,
            basicSalary: segments.length === 1 ? segments[0].basicSalary : null,
            applicableDays: singleFullSalary ? 'Full Month' : segments.map((segment) => `${segment.days} days`).join(', '),
            calculation: singleFullSalary ? `${segments[0].basicSalary} / 12` : segments.map((segment) => segment.calculation).join(' + '),
            leaveSalaryAccrual: monthAccrual,
            segments: singleFullSalary ? [] : segments,
        });
    }
    return { leaveSalary: total, monthlyBreakdown };
}

export function policyTicketRate(policy, fallback) {
    const candidates = [
        policy?.airTicketAmount,
        policy?.ticketAmount,
        policy?.ticketRate,
        policy?.airTicketRate,
        fallback,
    ];
    for (const value of candidates) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
}

export function resolveTicketRateForDate(policyHistory, dateKey, fallback) {
    const rows = (Array.isArray(policyHistory) ? policyHistory : [])
        .map((row) => ({
            from: toSalaryDateKey(row?.effectiveFrom ?? row?.fromDate),
            to: toSalaryDateKey(row?.effectiveTo ?? row?.toDate),
            rate: policyTicketRate(row, row?.airTicketAmount ?? row?.ticketRate ?? row?.ticketAmount),
        }))
        .filter((row) => isDateKey(row.from))
        .sort((a, b) => a.from.localeCompare(b.from));
    if (!rows.length) return policyTicketRate({ airTicketAmount: fallback }, fallback);
    const key = isDateKey(dateKey) ? dateKey : rows[rows.length - 1].from;
    const match = [...rows].reverse().find((row) => row.from <= key && (!row.to || row.to >= key));
    return match?.rate || policyTicketRate({ airTicketAmount: fallback }, fallback);
}

export function resolveEntitlementCalculationStart({
    joiningDate,
    annualLeaveRecords = [],
    paymentCycles = [],
    cycleDays,
} = {}) {
    const ends = [];
    for (const row of annualLeaveRecords || []) {
        if (!isActiveLeave(row)) continue;
        const type = String(row?.leaveType || 'annual').toLowerCase();
        if (row?.leaveType && type !== 'annual') continue;
        if (!isConsumingAnnualLeave(row)) continue;
        const end = toSalaryDateKey(row?.endDate || row?.toDate || row?.returnToWorkDate);
        if (isDateKey(end)) ends.push(end);
    }
    for (const row of paymentCycles || []) {
        if (!isConsumingCycle(row, cycleDays)) continue;
        const end = toSalaryDateKey(
            row?.eligibilityEndDate || row?.leaveSalaryPaymentDate || row?.ticketPaymentDate || row?.paymentDate,
        );
        if (isDateKey(end)) ends.push(end);
    }
    const start = toSalaryDateKey(joiningDate);
    if (!ends.length) return start;
    ends.sort();
    const next = addDays(ends[ends.length - 1], 1);
    return next || start;
}

function annualLeaveTakenRows(annualLeaveHistory, calculationStartDate) {
    return (Array.isArray(annualLeaveHistory) ? annualLeaveHistory : [])
        .filter((row) => isActiveLeave(row))
        .filter((row) => {
            const type = String(row?.leaveType || 'annual').toLowerCase();
            return !row?.leaveType || type === 'annual';
        })
        .map((row) => ({
            startDate: toSalaryDateKey(row?.startDate || row?.fromDate),
            endDate: toSalaryDateKey(row?.endDate || row?.toDate),
            days: Math.max(0, Number(row?.eligibleWorkingDays ?? row?.actualDays ?? row?.calendarDays) || 0),
        }))
        .filter((row) => row.startDate || row.endDate)
        .filter((row) => {
            if (!isDateKey(calculationStartDate)) return true;
            const start = row.startDate || row.endDate;
            return start >= calculationStartDate;
        })
        .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
}

export function calculateAnnualLeaveEntitlement({
    calculationStartDate,
    calculationEndDate,
    eligibleWorkingDays,
    consumedEntitlements = 0,
    reducingCycles = [],
    requiredDaysPerEntitlement,
    salaryHistory = [],
    annualLeaveHistory = [],
    salaryPolicyHistory = [],
    ticketRate,
    leaveWorkingDays,
} = {}) {
    const required = resolveEntitlementDays(requiredDaysPerEntitlement ?? leaveWorkingDays);
    const days = Number(eligibleWorkingDays) || 0;
    const safeDays = days > 0 ? days : 0;
    const cycles = Array.isArray(reducingCycles) ? reducingCycles.filter(Boolean) : [];
    const availableEntitlements = required > 0 ? Math.floor(safeDays / required) : 0;
    const paidFromCycles = cycles.length
        ? cycles.length
        : Math.max(0, Math.floor(Number(consumedEntitlements) || 0));
    const completedEntitlements = Math.min(paidFromCycles, availableEntitlements);
    const remainingDays = required > 0 ? Math.max(0, safeDays - availableEntitlements * required) : safeDays;
    const totalEntitlementDays = required > 0 ? Math.max(required, availableEntitlements * required) : 0;
    const leftoverTowardNext = remainingDays;
    const rowCount = availableEntitlements;
    const start = toSalaryDateKey(calculationStartDate);
    const end = toSalaryDateKey(calculationEndDate);
    const fallbackRate = policyTicketRate({ airTicketAmount: ticketRate }, ticketRate);
    const takenLeaves = annualLeaveTakenRows(annualLeaveHistory, start);
    const entitlements = [];

    for (let index = 0; index < rowCount; index += 1) {
        const salaryPeriodStart = start ? addCalendarMonths(start, index * 12) : '';
        let salaryPeriodEnd = salaryPeriodStart ? twelveMonthPeriodEnd(salaryPeriodStart) : '';
        if (end && salaryPeriodEnd && salaryPeriodEnd > end) salaryPeriodEnd = end;
        const salary = calculateLeaveSalaryForPeriod(salaryHistory, salaryPeriodStart, salaryPeriodEnd);
        const rate = resolveTicketRateForDate(
            salaryPolicyHistory,
            salaryPeriodEnd || salaryPeriodStart,
            fallbackRate,
        );
        const cycle = cycles[index];
        const paid = index < completedEntitlements;
        const withLeave = !cycle || cycleIncludesLeavePayment(cycle);
        const withTicket = !cycle || cycleIncludesTicketPayment(cycle);
        const leaveTaken = takenLeaves[index] || { startDate: '', endDate: '', days: 0 };
        entitlements.push({
            entitlementNo: index + 1,
            eligibilityStartDate: salaryPeriodStart,
            eligibilityEndDate: salaryPeriodEnd,
            eligibleDays: required,
            salaryPeriodStart,
            salaryPeriodEnd,
            entitlementDate: start ? entitlementDisplayDate(start, index) : '',
            leaveSalary: withLeave ? roundMoney(salary.leaveSalary) : 0,
            ticketRate: rate,
            ticketAmount: withTicket ? roundMoney(rate) : 0,
            leaveTaken,
            monthlyBreakdown: salary.monthlyBreakdown,
            status: paid ? 'Eligible' : 'Calculated',
        });
    }

    const nextStart = start ? addCalendarMonths(start, availableEntitlements * 12) : start;
    const nextEntitlement = {
        accumulatedDays: leftoverTowardNext,
        requiredDays: required,
        remainingDays: Math.max(0, required - leftoverTowardNext),
        startDate: nextStart || '',
        endDate: end || '',
        entitlementDate: start ? entitlementDisplayDate(start, availableEntitlements) : '',
        eligibleDays: leftoverTowardNext,
        status: 'In Progress',
    };

    const leaveSalaryCount = cycles.length
        ? cycles.filter(cycleIncludesLeavePayment).length
        : completedEntitlements;
    const ticketCount = cycles.length
        ? cycles.filter(cycleIncludesTicketPayment).length
        : completedEntitlements;
    const totalLeaveSalary = roundMoney(entitlements.reduce((sum, row) => sum + Number(row.leaveSalary || 0), 0));
    const totalTicketAmount = roundMoney(entitlements.reduce((sum, row) => sum + Number(row.ticketAmount || 0), 0));
    const uniqueRates = [...new Set(entitlements.map((row) => Number(row.ticketRate) || 0))];

    return {
        eligibleWorkingDays: remainingDays,
        requiredDaysPerEntitlement: required,
        completedEntitlements,
        availableEntitlements,
        totalEntitlementDays,
        remainingDays,
        leaveSalaryCount,
        totalLeaveSalary,
        ticketCount,
        totalTicketAmount,
        ticketRate: uniqueRates.length === 1 ? uniqueRates[0] : fallbackRate,
        entitlements,
        nextEntitlement,
        calculationStartDate: start,
        calculationEndDate: end,
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
