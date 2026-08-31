import Attendance from '../models/Attendance.js';
import Holiday from '../models/Holiday.js';
import PayrollSettings from '../models/PayrollSettings.js';
import SalaryEnrollment from '../models/SalaryEnrollment.js';
import WorkingTime from '../models/WorkingTime.js';
import { serializePayrollSettings } from '../controllers/employee/payrollSettingsController.js';
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

export async function resolveEmployeePayrollPolicy(employee) {
    const employeeId = String(employee?.employeeId || '').trim();
    const staffType = normalizeStaffTypeKey(employee?.staffType);
    const [enrollment, group, main] = await Promise.all([
        employeeId ? SalaryEnrollment.findOne({ employeeId }).select('policy').lean() : null,
        staffType ? PayrollSettings.findOne({ key: `group:${staffType}` }).lean() : null,
        PayrollSettings.findOne({ key: 'default' }).lean(),
    ]);
    if (enrollment?.policy && typeof enrollment.policy === 'object') {
        return serializePayrollSettings(enrollment.policy);
    }
    return serializePayrollSettings(group || main || {});
}

export function leavePolicyEntitlements(policy) {
    const rules = policy?.processingRules || {};
    const sickEnabled = Boolean(rules.allowedSickLeavePerYear);
    const sickAllowedRaw = resolveLeaveMultiplierValue(policy?.allowedSickLeaveDaysPerYear);
    const requiredPresentDays =
        Number(policy?.workingDaysRequiredToEligible) > 0
            ? Number(policy.workingDaysRequiredToEligible)
            : 300;
    const airTicketRequiredDays =
        Number(policy?.workingDaysRequiredForAirTicket) > 0
            ? Number(policy.workingDaysRequiredForAirTicket)
            : requiredPresentDays;
    return {
        annualAllowedDays: DEFAULT_ANNUAL_LEAVE_DAYS,
        sickEnabled,
        sickAllowedDays: sickEnabled ? (sickAllowedRaw ?? 0) : null,
        sandwichLeave: Boolean(rules.sandwichLeave),
        requiredPresentDays,
        airTicketRequiredDays,
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

export function splitDatesBySickAllowance(dates, { taken = 0, allowed, enabled } = {}) {
    const sorted = [...(dates || [])]
        .map((key) => String(key || '').trim())
        .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key))
        .sort();
    if (!enabled || allowed == null) {
        return { sickDates: sorted, authorizedDates: [] };
    }
    const remaining = Math.max(0, Number(allowed) - Number(taken || 0));
    return {
        sickDates: sorted.slice(0, remaining),
        authorizedDates: sorted.slice(remaining),
    };
}

export function reclassifyOverflowSick(leaveByDate, entitlements) {
    const overflow = [];
    if (!(leaveByDate instanceof Map) || !entitlements?.sickEnabled || entitlements.sickAllowedDays == null) {
        return overflow;
    }
    const allowed = Math.max(0, Number(entitlements.sickAllowedDays) || 0);
    const sickDates = [...leaveByDate.entries()]
        .filter(([, statusKey]) => statusKey === 'sick_leave')
        .map(([date]) => date)
        .sort();
    for (const date of sickDates.slice(allowed)) {
        leaveByDate.set(date, 'authorized_leave');
        overflow.push(date);
    }
    return overflow;
}

export function applySickAllowanceToLeaveRecords(leaveRecords, entitlements, { priorSickDaysByYear = {} } = {}) {
    const rows = Array.isArray(leaveRecords) ? leaveRecords : [];
    if (!entitlements?.sickEnabled || entitlements.sickAllowedDays == null) return rows;
    const allowed = Math.max(0, Number(entitlements.sickAllowedDays) || 0);
    const used = { ...priorSickDaysByYear };
    const overflow = new Set();
    const sickDates = rows
        .filter((row) => String(row?.leaveType || '').toLowerCase() === 'sick')
        .map((row) => String(row?.fromDate || row?.toDate || '').trim())
        .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
        .sort();
    for (const date of sickDates) {
        const year = date.slice(0, 4);
        const soFar = Number(used[year] || 0);
        used[year] = soFar + 1;
        if (soFar >= allowed) overflow.add(date);
    }
    if (!overflow.size) return rows;
    return rows.map((row) => {
        const date = String(row?.fromDate || row?.toDate || '').trim();
        if (String(row?.leaveType || '').toLowerCase() !== 'sick' || !overflow.has(date)) return row;
        return { ...row, leaveType: 'authorized' };
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

function typeBalance({ taken, sandwichDays, pending, allowed, enabled, multiplier }) {
    const cap = enabled && allowed != null ? Number(allowed) : null;
    const remaining = cap == null ? null : Math.max(0, cap - taken);
    return {
        taken,
        sandwichDays,
        pending,
        allowed: cap,
        remaining,
        multiplier,
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

    const overflowSickDates = reclassifyOverflowSick(leaveByDate, entitlements);
    const overflowSet = new Set(overflowSickDates);
    for (const row of sandwichRows) {
        const nextKey = leaveByDate.get(row.date);
        if (!nextKey || nextKey === row.statusKey) continue;
        if (sandwichByType[row.statusKey] > 0) sandwichByType[row.statusKey] -= 1;
        sandwichByType[nextKey] += 1;
        row.statusKey = nextKey;
    }

    const taken = emptyTypeCounts();
    for (const statusKey of leaveByDate.values()) {
        if (taken[statusKey] != null) taken[statusKey] += 1;
    }

    if (entitlements?.sickEnabled && entitlements.sickAllowedDays != null) {
        const remaining = Math.max(0, Number(entitlements.sickAllowedDays) - (taken.sick_leave || 0));
        const pendingSick = [...pendingByDate.entries()]
            .filter(([, statusKey]) => statusKey === 'sick_leave')
            .map(([date]) => date)
            .sort();
        for (const date of pendingSick.slice(remaining)) {
            pendingByDate.set(date, 'authorized_leave');
        }
    }

    const pendingByType = emptyTypeCounts();
    for (const statusKey of pendingByDate.values()) {
        if (pendingByType[statusKey] != null) pendingByType[statusKey] += 1;
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
            statusKey === 'on_leave' || (statusKey === 'sick_leave' && Boolean(entitlements?.sickEnabled));
        types[statusKey] = typeBalance({
            taken: taken[statusKey] || 0,
            sandwichDays: sandwichByType[statusKey] || 0,
            pending: pendingByType[statusKey] || 0,
            allowed,
            enabled,
            multiplier: multipliers[multiplierKey] ?? 1,
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
    const offSet =
        options.offSet ||
        (from && to ? await loadOffDateSet({ staffType: employee?.staffType, from, to }) : new Set());
    let records = options.records;
    if (!records) {
        const clauses = [];
        if (employee?._id) clauses.push({ employeeMongoId: String(employee._id) });
        if (employee?.employeeId) clauses.push({ employeeId: employee.employeeId });
        records = clauses.length
            ? await Attendance.find({
                  date: { $gte: from, $lte: to },
                  $or: clauses,
              })
                  .select('date statusKey leaveRequestStatus requestedStatusKey leaveRequestGroupId')
                  .lean()
            : [];
    }
    const built = buildLeaveBalances({
        records,
        entitlements,
        offSet,
        from,
        to,
        excludeGroupId: options.excludeGroupId,
        excludeDates: options.excludeDates,
    });
    return { policy, entitlements, offSet, ...built };
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
    const years = [...new Set(dates.map((key) => Number(key.slice(0, 4))))];
    for (const year of years) {
        const yearDates = dates.filter((key) => Number(key.slice(0, 4)) === year).sort();
        const { types, entitlements } = await loadEmployeeLeaveBalances(employee, { year, excludeGroupId });
        if (!entitlements.sickEnabled) {
            yearDates.forEach((date) => result.set(date, 'sick_leave'));
            continue;
        }
        const split = splitDatesBySickAllowance(yearDates, {
            taken: (types.sick_leave?.taken || 0) + (types.sick_leave?.pending || 0),
            allowed: entitlements.sickAllowedDays,
            enabled: true,
        });
        split.sickDates.forEach((date) => result.set(date, 'sick_leave'));
        split.authorizedDates.forEach((date) => result.set(date, 'authorized_leave'));
    }
    return result;
}
