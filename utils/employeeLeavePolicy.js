import Attendance from '../models/Attendance.js';
import Holiday from '../models/Holiday.js';
import PayrollSettings from '../models/PayrollSettings.js';
import SalaryEnrollment from '../models/SalaryEnrollment.js';
import WorkingTime from '../models/WorkingTime.js';
import { serializePayrollSettings } from '../controllers/employee/payrollSettingsController.js';
import { mergeEmployeeIdLists } from './salaryPolicyExclusions.js';
import { normalizeStaffTypeKey } from './workLocationHelpers.js';
import {
    getOffWeekdayKeys,
    getWeekForStaffType,
    holidayAppliesToStaff,
    weekdayKeyFromDateKey,
} from './workingTimeHelpers.js';
import { policyLeaveMultipliers, resolveLeaveMultiplierValue } from './salaryHistoricalCalculations.js';

export const DEFAULT_ANNUAL_LEAVE_DAYS = 30;

export const POLICY_LEAVE_STATUS_KEYS = [
    'on_leave',
    'sick_leave',
    'authorized_leave',
    'unauthorized_leave',
    'compoff_leave',
];

const LEAVE_STATUS_SET = new Set(POLICY_LEAVE_STATUS_KEYS);

const LEAVE_BALANCE_LABELS = {
    on_leave: 'Annual leave',
    sick_leave: 'Sick leave',
    authorized_leave: 'Authorized leave',
    unauthorized_leave: 'Unauthorized leave',
    compoff_leave: 'Comp off leave',
};

const MULTIPLIER_BY_STATUS = {
    on_leave: 'annual',
    sick_leave: 'sick',
    authorized_leave: 'authorized',
    unauthorized_leave: 'unauthorized',
    compoff_leave: 'annual',
};

function emptyTypeCounts() {
    return POLICY_LEAVE_STATUS_KEYS.reduce((acc, key) => {
        acc[key] = 0;
        return acc;
    }, {});
}

export function shiftDateKey(dateKey, days) {
    const raw = String(dateKey || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
    const [year, month, day] = raw.split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + Number(days || 0)));
    const y = next.getUTCFullYear();
    const m = String(next.getUTCMonth() + 1).padStart(2, '0');
    const d = String(next.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function latestAnnualLeaveEndFromLeaveRecords(leaveRecords = [], fallback = '') {
    let latest = String(fallback || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(latest)) latest = '';
    for (const row of Array.isArray(leaveRecords) ? leaveRecords : []) {
        if (!isAnnualLeaveType(row?.leaveType)) continue;
        const end = String(row?.toDate || row?.endDate || row?.fromDate || row?.startDate || '').trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(end) && end > latest) latest = end;
    }
    return latest;
}

export function sickDaysAfterAnnualLeave(leaveRecords = [], lastAnnualLeaveEnd = '') {
    const lastEnd = String(lastAnnualLeaveEnd || '').trim();
    let total = 0;
    for (const row of Array.isArray(leaveRecords) ? leaveRecords : []) {
        if (String(row?.leaveType || '').toLowerCase() !== 'sick') continue;
        const dates = sickDateKeysFromLeaveRow(row);
        if (dates.length) {
            total += dates.filter((date) => !lastEnd || date > lastEnd).length;
            continue;
        }
        total += Math.max(1, Number(row.eligibleWorkingDays) || 1);
    }
    return total;
}

export function dateKeysInRange(fromKey, toKey) {
    const keys = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromKey) || !/^\d{4}-\d{2}-\d{2}$/.test(toKey) || toKey < fromKey) {
        return keys;
    }
    for (let cursor = fromKey; cursor <= toKey; cursor = shiftDateKey(cursor, 1)) {
        keys.push(cursor);
        if (keys.length > 400) break;
    }
    return keys;
}

function lateRulesHaveDeduct(rules) {
    return (Array.isArray(rules) ? rules : []).some((row) => String(row?.deduct || '').trim());
}

export async function resolveEmployeePayrollPolicy(employee) {
    const employeeId = String(employee?.employeeId || '').trim();
    const staffType = normalizeStaffTypeKey(employee?.staffType);
    const [enrollment, group, main] = await Promise.all([
        employeeId ? SalaryEnrollment.findOne({ employeeId }).select('policy').lean() : null,
        staffType ? PayrollSettings.findOne({ key: `group:${staffType}` }).lean() : null,
        PayrollSettings.findOne({ key: 'default' }).lean(),
    ]);
    const mainPolicy = serializePayrollSettings(main || {});
    const groupPolicy = serializePayrollSettings(group || main || {});
    const exclusionLists = {
        attendanceExclusionEmployeeIds: mergeEmployeeIdLists(
            mainPolicy.attendanceExclusionEmployeeIds,
            groupPolicy.attendanceExclusionEmployeeIds,
        ),
        leaveExclusionEmployeeIds: mergeEmployeeIdLists(
            mainPolicy.leaveExclusionEmployeeIds,
            groupPolicy.leaveExclusionEmployeeIds,
        ),
    };
    if (!enrollment?.policy || typeof enrollment.policy !== 'object') {
        return { ...groupPolicy, ...exclusionLists };
    }
    const own = serializePayrollSettings(enrollment.policy);
    return {
        ...groupPolicy,
        ...own,
        authorizedLeaveDeductionDays:
            own.authorizedLeaveDeductionDays ?? groupPolicy.authorizedLeaveDeductionDays,
        unauthorizedLeaveDeductionDays:
            own.unauthorizedLeaveDeductionDays ?? groupPolicy.unauthorizedLeaveDeductionDays,
        lateInRules: lateRulesHaveDeduct(own.lateInRules) ? own.lateInRules : groupPolicy.lateInRules,
        attendanceExclusionEmployeeIds: mergeEmployeeIdLists(
            exclusionLists.attendanceExclusionEmployeeIds,
            own.attendanceExclusionEmployeeIds,
        ),
        leaveExclusionEmployeeIds: mergeEmployeeIdLists(
            exclusionLists.leaveExclusionEmployeeIds,
            own.leaveExclusionEmployeeIds,
        ),
    };
}

export function leavePolicyEntitlements(policy) {
    const rules = policy?.processingRules || {};
    const sickEnabled = Boolean(rules.allowedSickLeavePerYear);
    const sickAllowedRaw = resolveLeaveMultiplierValue(policy?.allowedSickLeaveDaysPerYear);
    const requiredPresentDays =
        Number(policy?.workingDaysRequiredToEligible) > 0
            ? Number(policy.workingDaysRequiredToEligible)
            : 300;
    const leaveWorkingDays =
        Number(policy?.leaveSalaryWorkingDays) > 0
            ? Number(policy.leaveSalaryWorkingDays)
            : requiredPresentDays;
    return {
        annualAllowedDays: DEFAULT_ANNUAL_LEAVE_DAYS,
        annualPeriod: 'year',
        sickEnabled,
        sickAllowedDays: sickAllowedRaw != null ? sickAllowedRaw : sickEnabled ? 0 : null,
        allowedSickLeaveDaysPerYear: sickAllowedRaw,
        sickPeriod: sickEnabled || sickAllowedRaw != null ? 'from last annual leave to next' : null,
        sandwichLeave: Boolean(rules.sandwichLeave),
        requiredPresentDays,
        airTicketRequiredDays: leaveWorkingDays,
        multipliers: policyLeaveMultipliers(policy),
    };
}

export function buildOffDateSet({ from, to, offWeekdays, holidaySet }) {
    const offs = new Set();
    const holidays = holidaySet instanceof Set ? holidaySet : new Set(holidaySet || []);
    const weekdays = offWeekdays instanceof Set ? offWeekdays : new Set(offWeekdays || []);
    for (const key of dateKeysInRange(from, to)) {
        if (holidays.has(key)) {
            offs.add(key);
            continue;
        }
        const weekday = weekdayKeyFromDateKey(key);
        if (weekday && weekdays.has(weekday)) offs.add(key);
    }
    return offs;
}

export async function loadOffDateSet({ staffType, from, to }) {
    const [workingTime, holidays] = await Promise.all([
        WorkingTime.findOne({}).lean(),
        Holiday.find({ date: { $gte: from, $lte: to } }).select('date appliesTo').lean(),
    ]);
    const week = getWeekForStaffType(workingTime, staffType);
    const holidaySet = new Set(
        (holidays || [])
            .filter((row) => holidayAppliesToStaff(row, staffType))
            .map((row) => String(row.date || '').trim())
            .filter(Boolean),
    );
    return buildOffDateSet({
        from,
        to,
        offWeekdays: getOffWeekdayKeys(week),
        holidaySet,
    });
}

function nearestNonOffDate(fromDate, direction, { offSet, minDate, maxDate }) {
    let cursor = shiftDateKey(fromDate, direction);
    while (cursor && cursor >= minDate && cursor <= maxDate) {
        if (offSet.has(cursor)) {
            cursor = shiftDateKey(cursor, direction);
            continue;
        }
        return cursor;
    }
    return '';
}

export function dateInSickCycle(date, { start = '', end = '' } = {}) {
    const key = String(date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
    if (start && key < start) return false;
    if (end && key > end) return false;
    return true;
}

/** Day after last annual leave through the day before the next annual leave. */
export function sickCycleBounds({ lastAnnualLeaveEnd = '', nextAnnualLeaveStart = '' } = {}) {
    const lastEnd = String(lastAnnualLeaveEnd || '').trim();
    const nextStart = String(nextAnnualLeaveStart || '').trim();
    return {
        start: /^\d{4}-\d{2}-\d{2}$/.test(lastEnd) ? shiftDateKey(lastEnd, 1) : '',
        end: /^\d{4}-\d{2}-\d{2}$/.test(nextStart) ? shiftDateKey(nextStart, -1) : '',
    };
}

function sickCapDays(entitlements) {
    if (entitlements?.sickAllowedDays == null && entitlements?.sickEnabled !== true) return null;
    return Math.max(0, Number(entitlements?.sickAllowedDays) || 0);
}

function isAnnualLeaveType(type) {
    const key = String(type || '').toLowerCase();
    return !key || key === 'annual' || key === 'on_leave';
}

function holidayIntervalsFromLeaveRecords(leaveRecords = []) {
    const intervals = [];
    for (const row of Array.isArray(leaveRecords) ? leaveRecords : []) {
        if (!isAnnualLeaveType(row?.leaveType)) continue;
        const from = String(row?.fromDate || row?.startDate || '').trim();
        const to = String(row?.toDate || row?.endDate || from).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && to >= from) {
            intervals.push({ start: from, end: to });
        }
    }
    return intervals;
}

function annualLeaveAnchors(leaveByDate, { lastAnnualLeaveEnd = '', nextAnnualLeaveStart = '' } = {}) {
    const onLeaveDates = [...(leaveByDate instanceof Map ? leaveByDate.entries() : [])]
        .filter(([, statusKey]) => statusKey === 'on_leave')
        .map(([date]) => date)
        .sort();
    const ranges = [];
    for (const date of onLeaveDates) {
        const last = ranges.at(-1);
        if (last && shiftDateKey(last.end, 1) === date) last.end = date;
        else ranges.push({ start: date, end: date });
    }
    const ends = ranges.map((row) => row.end);
    const starts = ranges.map((row) => row.start);
    const extraEnd = String(lastAnnualLeaveEnd || '').trim();
    if (
        /^\d{4}-\d{2}-\d{2}$/.test(extraEnd) &&
        !ends.includes(extraEnd) &&
        !ranges.some((row) => extraEnd >= row.start && extraEnd <= row.end)
    ) {
        ends.push(extraEnd);
    }
    const extraStart = String(nextAnnualLeaveStart || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(extraStart) && !starts.includes(extraStart)) {
        starts.push(extraStart);
    }
    ends.sort();
    starts.sort();
    return { ends, starts };
}

function sickCycleKeyForDate(date, { ends = [], starts = [] } = {}) {
    const lastEnd = ends.filter((end) => end < date).at(-1) || '';
    const nextStart = starts.find((start) => start > date) || '';
    return `${lastEnd}|${nextStart}`;
}

function sickDateKeysFromLeaveRow(row) {
    if (String(row?.leaveType || '').toLowerCase() !== 'sick') return [];
    const from = String(row?.fromDate || row?.startDate || '').trim();
    const to = String(row?.toDate || row?.endDate || from).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && to >= from) {
        return dateKeysInRange(from, to);
    }
    return [];
}

export function splitDatesBySickAllowance(dates, { taken = 0, allowed, enabled } = {}) {
    const sorted = [...(dates || [])]
        .map((key) => String(key || '').trim())
        .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key))
        .sort();
    if (enabled === false || allowed == null) {
        return { sickDates: sorted, authorizedDates: [] };
    }
    const remaining = Math.max(0, Number(allowed) - Number(taken || 0));
    return {
        sickDates: sorted.slice(0, remaining),
        authorizedDates: sorted.slice(remaining),
    };
}

export function reclassifyOverflowSick(
    leaveByDate,
    entitlements,
    { lastAnnualLeaveEnd = '', nextAnnualLeaveStart = '', priorSickDays = 0 } = {},
) {
    const overflow = [];
    const allowed = sickCapDays(entitlements);
    if (!(leaveByDate instanceof Map) || allowed == null) {
        return overflow;
    }
    const anchors = annualLeaveAnchors(leaveByDate, { lastAnnualLeaveEnd, nextAnnualLeaveStart });
    const usedByCycle = new Map();
    if (priorSickDays > 0) {
        const currentKey = sickCycleKeyForDate(shiftDateKey(String(lastAnnualLeaveEnd || '').trim(), 1) || '0000-01-01', anchors);
        usedByCycle.set(currentKey, Math.max(0, Number(priorSickDays) || 0));
    }
    const sickDates = [...leaveByDate.entries()]
        .filter(([, statusKey]) => statusKey === 'sick_leave')
        .map(([date]) => date)
        .sort();
    for (const date of sickDates) {
        const key = sickCycleKeyForDate(date, anchors);
        const soFar = Number(usedByCycle.get(key) || 0);
        usedByCycle.set(key, soFar + 1);
        if (soFar >= allowed) {
            leaveByDate.set(date, 'authorized_leave');
            overflow.push(date);
        }
    }
    return overflow;
}

function leaveRowForDates(row, dates, leaveType) {
    if (!dates.length) return null;
    const fromDate = dates[0];
    const toDate = dates[dates.length - 1];
    return {
        ...row,
        leaveType,
        fromDate,
        toDate,
        startDate: fromDate,
        endDate: toDate,
    };
}

export function applySickAllowanceToLeaveRecords(
    leaveRecords,
    entitlements,
    { lastAnnualLeaveEnd = '', priorSickDays = 0 } = {},
) {
    const rows = Array.isArray(leaveRecords) ? leaveRecords : [];
    const allowed = sickCapDays(entitlements);
    if (allowed == null) return rows;

    const intervals = holidayIntervalsFromLeaveRecords(rows);
    const extraEnd = String(lastAnnualLeaveEnd || '').trim();
    const ends = [
        ...new Set([
            ...intervals.map((row) => row.end),
            ...(/^\d{4}-\d{2}-\d{2}$/.test(extraEnd) ? [extraEnd] : []),
        ]),
    ].sort();
    const starts = [...new Set(intervals.map((row) => row.start))].sort();
    const usedByCycle = new Map();
    if (priorSickDays > 0) {
        const seedDate = /^\d{4}-\d{2}-\d{2}$/.test(extraEnd) ? shiftDateKey(extraEnd, 1) : '0000-01-01';
        const seedKey = `${ends.filter((end) => end < seedDate).at(-1) || extraEnd || ''}|${starts.find((start) => start > seedDate) || ''}`;
        usedByCycle.set(seedKey, Math.max(0, Number(priorSickDays) || 0));
    }
    const overflow = new Set();
    const orderedDates = [];
    for (const row of rows) {
        for (const date of sickDateKeysFromLeaveRow(row)) {
            orderedDates.push(date);
        }
    }
    orderedDates.sort();
    for (const date of orderedDates) {
        const lastEnd = ends.filter((end) => end < date).at(-1) || extraEnd || '';
        const nextStart = starts.find((start) => start > date) || '';
        const key = `${lastEnd}|${nextStart}`;
        const soFar = Number(usedByCycle.get(key) || 0);
        usedByCycle.set(key, soFar + 1);
        if (soFar >= allowed) overflow.add(date);
    }
    if (!overflow.size) return rows;
    return rows.flatMap((row) => {
        const dates = sickDateKeysFromLeaveRow(row);
        if (!dates.length || !dates.some((date) => overflow.has(date))) return [row];
        const sickDates = dates.filter((date) => !overflow.has(date));
        const authorizedDates = dates.filter((date) => overflow.has(date));
        if (!sickDates.length) return [{ ...row, leaveType: 'authorized' }];
        return [
            leaveRowForDates(row, sickDates, 'sick'),
            leaveRowForDates(row, authorizedDates, 'authorized'),
        ].filter(Boolean);
    });
}

export function sandwichDatesForLeave({ leaveByDate, offSet, from, to }) {
    const extras = [];
    if (!(leaveByDate instanceof Map) || !offSet?.size) return extras;
    for (const date of dateKeysInRange(from, to)) {
        if (!offSet.has(date) || leaveByDate.has(date)) continue;
        const prev = nearestNonOffDate(date, -1, { offSet, minDate: from, maxDate: to });
        const next = nearestNonOffDate(date, 1, { offSet, minDate: from, maxDate: to });
        const prevType = leaveByDate.get(prev);
        const nextType = leaveByDate.get(next);
        if (!prevType || !nextType) continue;
        extras.push({
            date,
            statusKey: prevType === nextType ? prevType : prevType,
        });
    }
    return extras;
}

function typeBalance({ taken, sandwichDays, pending, allowed, enabled, multiplier, period }) {
    const cap = enabled && allowed != null ? Number(allowed) : null;
    const remaining = cap == null ? null : Math.max(0, cap - taken);
    return {
        taken,
        sandwichDays,
        pending,
        allowed: cap,
        remaining,
        multiplier,
        period: period || null,
        deductionDays: Number((taken * (Number(multiplier) || 1)).toFixed(2)),
    };
}

export function buildLeaveBalances({
    records,
    entitlements,
    offSet,
    from,
    to,
    excludeGroupId = '',
    excludeDates,
    lastAnnualLeaveEnd = '',
    nextAnnualLeaveStart = '',
    priorSickDays = 0,
} = {}) {
    const skipDates = excludeDates instanceof Set ? excludeDates : new Set(excludeDates || []);
    const skipGroup = String(excludeGroupId || '').trim();
    const leaveByDate = new Map();
    const pendingByDate = new Map();

    for (const row of records || []) {
        const date = String(row?.date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        if (skipDates.has(date)) continue;
        if (skipGroup && String(row?.leaveRequestGroupId || '').trim() === skipGroup) continue;

        const statusKey = String(row?.statusKey || '').trim();
        if (LEAVE_STATUS_SET.has(statusKey)) {
            leaveByDate.set(date, statusKey);
        }

        if (String(row?.leaveRequestStatus || '').trim() !== 'pending') continue;
        const requested = String(row?.requestedStatusKey || '').trim();
        if (!LEAVE_STATUS_SET.has(requested) || leaveByDate.has(date) || pendingByDate.has(date)) continue;
        pendingByDate.set(date, requested);
    }

    const sandwichRows = entitlements?.sandwichLeave
        ? sandwichDatesForLeave({ leaveByDate, offSet: offSet || new Set(), from, to })
        : [];
    const sandwichByType = emptyTypeCounts();
    for (const row of sandwichRows) {
        leaveByDate.set(row.date, row.statusKey);
        sandwichByType[row.statusKey] += 1;
    }

    const overflowSickDates = reclassifyOverflowSick(leaveByDate, entitlements, {
        lastAnnualLeaveEnd,
        nextAnnualLeaveStart,
        priorSickDays,
    });
    const overflowSet = new Set(overflowSickDates);
    for (const row of sandwichRows) {
        const nextKey = leaveByDate.get(row.date);
        if (!nextKey || nextKey === row.statusKey) continue;
        if (sandwichByType[row.statusKey] > 0) sandwichByType[row.statusKey] -= 1;
        sandwichByType[nextKey] += 1;
        row.statusKey = nextKey;
    }

    const allowedSick = sickCapDays(entitlements);
    const anchors = annualLeaveAnchors(leaveByDate, { lastAnnualLeaveEnd, nextAnnualLeaveStart });
    if (allowedSick != null) {
        const usedByCycle = new Map();
        if (priorSickDays > 0) {
            const seedDate =
                shiftDateKey(String(lastAnnualLeaveEnd || '').trim(), 1) || '0000-01-01';
            usedByCycle.set(sickCycleKeyForDate(seedDate, anchors), Math.max(0, Number(priorSickDays) || 0));
        }
        for (const [date, statusKey] of leaveByDate.entries()) {
            if (statusKey !== 'sick_leave') continue;
            const key = sickCycleKeyForDate(date, anchors);
            usedByCycle.set(key, Number(usedByCycle.get(key) || 0) + 1);
        }
        const pendingSick = [...pendingByDate.entries()]
            .filter(([, statusKey]) => statusKey === 'sick_leave')
            .map(([date]) => date)
            .sort();
        for (const date of pendingSick) {
            const key = sickCycleKeyForDate(date, anchors);
            const soFar = Number(usedByCycle.get(key) || 0);
            if (soFar >= allowedSick) {
                pendingByDate.set(date, 'authorized_leave');
                continue;
            }
            usedByCycle.set(key, soFar + 1);
        }
    }

    const currentCycle = sickCycleBounds({ lastAnnualLeaveEnd, nextAnnualLeaveStart });
    const taken = emptyTypeCounts();
    for (const [date, statusKey] of leaveByDate.entries()) {
        if (taken[statusKey] == null) continue;
        if (statusKey === 'sick_leave') {
            if (dateInSickCycle(date, currentCycle)) taken.sick_leave += 1;
            continue;
        }
        if (from && date < from) continue;
        if (to && date > to) continue;
        taken[statusKey] += 1;
    }
    if (priorSickDays > 0) {
        taken.sick_leave += Math.max(0, Number(priorSickDays) || 0);
    }

    const pendingByType = emptyTypeCounts();
    for (const [date, statusKey] of pendingByDate.entries()) {
        if (pendingByType[statusKey] == null) continue;
        if (statusKey === 'sick_leave' && !dateInSickCycle(date, currentCycle)) continue;
        if (from && date < from) continue;
        if (to && date > to) continue;
        pendingByType[statusKey] += 1;
    }

    const multipliers = entitlements?.multipliers || policyLeaveMultipliers({});
    const types = {};
    for (const statusKey of POLICY_LEAVE_STATUS_KEYS) {
        const multiplierKey = MULTIPLIER_BY_STATUS[statusKey];
        const allowed =
            statusKey === 'on_leave'
                ? entitlements?.annualAllowedDays
                : statusKey === 'sick_leave'
                  ? entitlements?.sickAllowedDays
                  : null;
        const enabled =
            statusKey === 'on_leave' ||
            (statusKey === 'sick_leave' &&
                (Boolean(entitlements?.sickEnabled) || entitlements?.sickAllowedDays != null));
        types[statusKey] = typeBalance({
            taken: taken[statusKey] || 0,
            sandwichDays: sandwichByType[statusKey] || 0,
            pending: pendingByType[statusKey] || 0,
            allowed,
            enabled,
            multiplier: multipliers[multiplierKey] ?? 1,
            period:
                statusKey === 'on_leave'
                    ? entitlements?.annualPeriod || 'year'
                    : statusKey === 'sick_leave' &&
                        (Boolean(entitlements?.sickEnabled) || entitlements?.sickAllowedDays != null)
                      ? entitlements?.sickPeriod || 'from last annual leave to next'
                      : null,
        });
    }

    return { types, sandwichRows, overflowSickDates, overflowSet };
}

export function assertLeaveBalance({ statusKey, extraDays, balances }) {
    const key = String(statusKey || '').trim();
    if (key === 'sick_leave') return '';
    const row = balances?.[key];
    const extra = Number(extraDays) || 0;
    if (!row || row.allowed == null || extra <= 0) return '';
    const remaining = Math.max(0, Number(row.allowed) - (Number(row.taken) || 0) - (Number(row.pending) || 0));
    if (extra <= remaining) return '';
    const label = LEAVE_BALANCE_LABELS[key] || 'Leave';
    return `${label} exceeds the salary policy allowance (${row.allowed} days/year). ${remaining} day(s) remaining.`;
}

export async function loadEmployeeLeaveBalances(employee, options = {}) {
    const year = Number(options.year);
    const from = options.from || (Number.isInteger(year) ? `${year}-01-01` : '');
    const to = options.to || (Number.isInteger(year) ? `${year}-12-31` : '');
    const policy = options.policy || (await resolveEmployeePayrollPolicy(employee));
    const entitlements = options.entitlements || leavePolicyEntitlements(policy);
    const clauses = [];
    if (employee?._id) clauses.push({ employeeMongoId: String(employee._id) });
    if (employee?.employeeId) clauses.push({ employeeId: employee.employeeId });

    let lastAnnualLeaveEnd = String(options.lastAnnualLeaveEnd || '').trim();
    if (!lastAnnualLeaveEnd && clauses.length) {
        const lastHoliday = await Attendance.findOne({
            statusKey: 'on_leave',
            $or: clauses,
            ...(to ? { date: { $lte: to } } : {}),
        })
            .sort({ date: -1 })
            .select('date')
            .lean();
        lastAnnualLeaveEnd = String(lastHoliday?.date || '').trim();
    }
    const cycleStart = sickCycleBounds({ lastAnnualLeaveEnd }).start;
    const rangeFrom = cycleStart && from && cycleStart < from ? cycleStart : from;

    const offSet =
        options.offSet ||
        (rangeFrom && to ? await loadOffDateSet({ staffType: employee?.staffType, from: rangeFrom, to }) : new Set());
    let records = options.records;
    if (!records) {
        records = clauses.length
            ? await Attendance.find({
                  date: { $gte: rangeFrom, $lte: to },
                  $or: clauses,
              })
                  .select('date statusKey leaveRequestStatus requestedStatusKey leaveRequestGroupId')
                  .lean()
            : [];
    }
    const nextAnnualLeaveStart =
        String(options.nextAnnualLeaveStart || '').trim() ||
        [...(records || [])]
            .filter((row) => String(row?.statusKey || '') === 'on_leave' && (!lastAnnualLeaveEnd || row.date > lastAnnualLeaveEnd))
            .map((row) => String(row.date || '').trim())
            .filter(Boolean)
            .sort()[0] || '';

    const built = buildLeaveBalances({
        records,
        entitlements,
        offSet,
        from: rangeFrom,
        to,
        excludeGroupId: options.excludeGroupId,
        excludeDates: options.excludeDates,
        lastAnnualLeaveEnd,
        nextAnnualLeaveStart,
        priorSickDays: options.priorSickDays || 0,
    });
    return { policy, entitlements, offSet, lastAnnualLeaveEnd, nextAnnualLeaveStart, ...built };
}

export async function checkEmployeeLeaveAllowance(employee, { statusKey, extraDates = [], excludeGroupId = '' } = {}) {
    if (String(statusKey || '').trim() === 'sick_leave') return '';
    const dates = (Array.isArray(extraDates) ? extraDates : []).filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key));
    if (!dates.length) return '';
    const years = [...new Set(dates.map((key) => Number(key.slice(0, 4))))];
    for (const year of years) {
        const extraDays = dates.filter((key) => Number(key.slice(0, 4)) === year).length;
        const { types } = await loadEmployeeLeaveBalances(employee, { year, excludeGroupId });
        const message = assertLeaveBalance({ statusKey, extraDays, balances: types });
        if (message) return message;
    }
    return '';
}

export async function resolveSickOverflowStatuses(employee, extraDates = [], { excludeGroupId = '' } = {}) {
    const dates = (Array.isArray(extraDates) ? extraDates : []).filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key));
    const result = new Map();
    if (!dates.length) return result;
    const sorted = [...dates].sort();
    const { types, entitlements } = await loadEmployeeLeaveBalances(employee, {
        from: sorted[0],
        to: sorted[sorted.length - 1],
        excludeGroupId,
    });
    const allowed = entitlements.sickAllowedDays;
    const remaining = Math.max(
        0,
        allowed == null
            ? sorted.length
            : Number(types.sick_leave?.remaining ?? allowed - ((types.sick_leave?.taken || 0) + (types.sick_leave?.pending || 0))),
    );
    const split = splitDatesBySickAllowance(sorted, {
        taken: allowed == null ? 0 : Math.max(0, Number(allowed) - remaining),
        allowed,
        enabled: allowed != null,
    });
    split.sickDates.forEach((date) => result.set(date, 'sick_leave'));
    split.authorizedDates.forEach((date) => result.set(date, 'authorized_leave'));
    return result;
}
