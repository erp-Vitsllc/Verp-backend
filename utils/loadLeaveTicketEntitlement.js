import Attendance from '../models/Attendance.js';
import Holiday from '../models/Holiday.js';
import WorkingTime from '../models/WorkingTime.js';
import SalaryEnrollment from '../models/SalaryEnrollment.js';
import SalaryHistoricalProfile from '../models/SalaryHistoricalProfile.js';
import { applySickAllowanceToLeaveRecords, leavePolicyEntitlements } from './employeeLeavePolicy.js';
import { getScheduledEmailTimeZone, getCalendarPartsInTz } from './scheduleDailyAtMidnight.js';
import {
    processingStartFromEnrollment,
    resolveSalaryProcessingStartDate,
} from './leaveSalaryVisibility.js';
import {
    calculateAnnualLeaveEntitlement,
    calculateHistoricalEligibility,
    consolidateCountOnlyLeaveRecords,
    historicalPeriod,
    inclusiveCalendarDays,
    isDateKey,
    isSalaryProcessingMonthReached,
    LIVE_LEAVE_STATUS_MAP,
    liveLeaveRecordsInProcessingWindow,
    policyLeaveMultipliers,
    policyLeaveWorkingDays,
    policyTicketRate,
    resolveEntitlementCalculationStart,
    salaryProcessingStartDay,
    summarizeAttendanceEligibility,
    uniqueConsumingCycles,
} from './salaryHistoricalCalculations.js';
import {
    remainingLeaveTicketBalances,
} from './salarySlipLeaveTicket.js';
import {
    cycleEligibilitySnapshot,
    cycleLeaveDeductions,
    historicalWindowForCycle,
    lastAnnualLeaveEndFromAttendance,
    lastTakenAnnualLeaveDays,
    lastTakenAnnualLeaveEnd,
    laterDateKey,
    leaveCycleStart,
    liveWindowForCycle,
    policyWorkingDayRequirement,
    enrollLeaveUsedByStatus,
} from './currentLeaveCycle.js';
import {
    getOffWeekdayKeys,
    getWeekForStaffType,
    holidayAppliesToStaff,
    WEEKDAY_KEYS,
} from './workingTimeHelpers.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n) {
    return String(n).padStart(2, '0');
}

function toDateKey(value) {
    if (!value) return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
    }
    const s = String(value).trim();
    if (ISO.test(s)) return s;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fromKey(key) {
    if (!ISO.test(key)) return null;
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
}

function weekdayKey(date) {
    return WEEKDAY_KEYS[date.getDay()];
}

function dubaiDateKey(date = new Date()) {
    const parts = getCalendarPartsInTz(date, getScheduledEmailTimeZone());
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function pickEmployeeLeaveSalary(salaryDoc) {
    const fromSalary = Number(salaryDoc?.basic ?? salaryDoc?.basicSalary) || 0;
    if (fromSalary > 0) return fromSalary;
    const history = Array.isArray(salaryDoc?.salaryHistory) ? salaryDoc.salaryHistory : [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
        const basic = Number(history[i]?.basic) || 0;
        if (basic > 0) return basic;
    }
    return 0;
}

function serializeSalaryHistory(salaryDoc, fallbackFrom) {
    const history = Array.isArray(salaryDoc?.salaryHistory) ? salaryDoc.salaryHistory : [];
    const rows = history
        .map((row) => ({
            effectiveFrom: toDateKey(row?.fromDate),
            effectiveTo: toDateKey(row?.toDate),
            basicSalary: Math.max(0, Number(row?.basic) || 0),
        }))
        .filter((row) => isDateKey(row.effectiveFrom));
    if (rows.length) return rows;
    const basic = pickEmployeeLeaveSalary(salaryDoc);
    if (basic > 0 && isDateKey(fallbackFrom)) {
        return [{ effectiveFrom: fallbackFrom, effectiveTo: '', basicSalary: basic }];
    }
    return [];
}

function latestRecordedTicketAmount(paymentCycles = []) {
    const rows = Array.isArray(paymentCycles) ? paymentCycles : [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const amount = Number(rows[i]?.ticketAmount) || 0;
        if (amount > 0) return amount;
    }
    return 0;
}

function annualLeaveHistoryForEntitlement(leaveRecords = [], annualLeaveRecords = []) {
    const fromLeave = (Array.isArray(leaveRecords) ? leaveRecords : []).filter(
        (row) => String(row?.leaveType || '').toLowerCase() === 'annual',
    );
    return [...(Array.isArray(annualLeaveRecords) ? annualLeaveRecords : []), ...fromLeave];
}

function normalizeLeaveSource(value) {
    const raw = String(value || 'manual').trim().toLowerCase();
    if (raw === 'erp' || raw === 'system') return 'system';
    return 'manual';
}

function historicalLeaveOnly(rows) {
    return (Array.isArray(rows) ? rows : []).filter(
        (row) => normalizeLeaveSource(row?.source) !== 'system',
    );
}

function toHiddenSystemLeave(value) {
    const seen = new Set();
    const out = [];
    for (const row of Array.isArray(value) ? value : []) {
        const leaveType = String(row?.leaveType || '').trim().toLowerCase();
        if (!leaveType) continue;
        const rawFrom = String(row?.fromDate || row?.startDate || '').trim();
        if (rawFrom === '*') {
            const key = `${leaveType}|*|*`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ leaveType, fromDate: '*', toDate: '*' });
            continue;
        }
        const fromDate = toDateKey(rawFrom);
        const toDate = toDateKey(row?.toDate || row?.endDate) || fromDate;
        if (!fromDate) continue;
        const key = `${leaveType}|${fromDate}|${toDate}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ leaveType, fromDate, toDate });
    }
    return out;
}

function isHiddenSystemLeaveRow(row, hidden) {
    const type = String(row?.leaveType || '').trim().toLowerCase();
    const from = toDateKey(row?.fromDate || row?.startDate);
    const to = toDateKey(row?.toDate || row?.endDate) || from;
    if (!type) return false;
    return (hidden || []).some((item) => {
        if (String(item?.leaveType || '').toLowerCase() !== type) return false;
        if (String(item?.fromDate || '') === '*') return true;
        const hideFrom = toDateKey(item?.fromDate);
        const hideTo = toDateKey(item?.toDate) || hideFrom;
        if (!from || !hideFrom) return false;
        return from <= hideTo && to >= hideFrom;
    });
}

function filterHiddenSystemLeave(rows, hidden) {
    const list = toHiddenSystemLeave(hidden);
    if (!list.length) return Array.isArray(rows) ? rows : [];
    return (Array.isArray(rows) ? rows : []).filter((row) => !isHiddenSystemLeaveRow(row, list));
}

async function calcWorkingDays({ from, to, staffType }) {
    const startDate = fromKey(from);
    const endDate = fromKey(to);
    const calendarDays = isDateKey(from) && isDateKey(to) && to >= from ? inclusiveCalendarDays(from, to) : 0;
    if (!startDate || !endDate || endDate < startDate) {
        return { workingDays: 0, weeklyOffs: 0, holidays: 0, calendarDays: 0 };
    }
    const [workingTime, holidays] = await Promise.all([
        WorkingTime.findOne({}).lean(),
        Holiday.find({ date: { $gte: from, $lte: to } }).lean(),
    ]);
    const week = getWeekForStaffType(workingTime, staffType);
    const offKeys = new Set(getOffWeekdayKeys(week));
    const holidayDates = new Set(
        (holidays || [])
            .filter((row) => holidayAppliesToStaff(row, staffType))
            .map((row) => String(row.date)),
    );
    let workingDays = 0;
    let weeklyOffs = 0;
    let holidayHits = 0;
    const cursor = new Date(startDate.getTime());
    const last = new Date(endDate.getTime());
    while (cursor <= last) {
        const key = `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}-${pad2(cursor.getDate())}`;
        const day = weekdayKey(cursor);
        if (holidayDates.has(key)) holidayHits += 1;
        else if (offKeys.has(day)) weeklyOffs += 1;
        else workingDays += 1;
        cursor.setDate(cursor.getDate() + 1);
    }
    return { workingDays, weeklyOffs, holidays: holidayHits, calendarDays };
}

/**
 * Same working-day total as salary enroll Eligibility Summary:
 * historical working days (joining → day before VERP start) plus live days after processing start.
 */
export async function loadEmployeeSalaryWorkingDays(employee, profileHint = null) {
    const empty = { historicalWorkingDays: 0, liveWorkingDays: 0, workingDays: 0 };
    const employeeId = String(employee?.employeeId || '').trim();
    if (!employeeId && !profileHint) return empty;

    const [profile, enrollment] = await Promise.all([
        profileHint
            ? Promise.resolve(profileHint)
            : employeeId
              ? SalaryHistoricalProfile.findOne({ employeeId })
                    .select('contractJoiningDate verpStartDate')
                    .lean()
                    .maxTimeMS(12000)
              : null,
        employeeId
            ? SalaryEnrollment.findOne({ employeeId })
                  .select('fromMonth salaryDate processDate')
                  .lean()
                  .maxTimeMS(12000)
            : null,
    ]);

    const joiningDate = toDateKey(
        profile?.contractJoiningDate || employee.contractJoiningDate || employee.dateOfJoining,
    );
    const verpStartDate =
        toDateKey(profile?.verpStartDate) ||
        resolveSalaryProcessingStartDate({
            verpStartDate: profile?.verpStartDate,
            enrollment,
        }) ||
        processingStartFromEnrollment(enrollment);
    const period = historicalPeriod(joiningDate, verpStartDate);
    const staffType = employee.staffType;
    const historical =
        joiningDate && period.end
            ? await calcWorkingDays({ from: joiningDate, to: period.end, staffType })
            : { workingDays: 0 };
    const todayKey = dubaiDateKey();
    const live =
        isSalaryProcessingMonthReached(todayKey, verpStartDate)
            ? await calcWorkingDays({
                  from: salaryProcessingStartDay(verpStartDate) || verpStartDate,
                  to: todayKey,
                  staffType,
              })
            : { workingDays: 0 };
    const historicalWorkingDays = Number(historical.workingDays) || 0;
    const liveWorkingDays = Number(live.workingDays) || 0;
    return {
        historicalWorkingDays,
        liveWorkingDays,
        workingDays: historicalWorkingDays + liveWorkingDays,
    };
}

async function loadLiveAttendanceEligibility({ employee, from, to, staffType }) {
    if (!isDateKey(from) || !employee) {
        return { workingDays: 0, leaveRecords: [], from: '', to: '' };
    }
    const periodStart = salaryProcessingStartDay(from) || from;
    const periodEnd = isDateKey(to) && to >= periodStart ? to : '';
    if (!periodEnd) {
        return { workingDays: 0, leaveRecords: [], from: '', to: '' };
    }
    const clauses = [];
    if (employee._id) clauses.push({ employeeMongoId: String(employee._id) });
    if (employee.employeeId) clauses.push({ employeeId: employee.employeeId });
    const stats = await calcWorkingDays({ from: periodStart, to: periodEnd, staffType });
    if (!clauses.length) {
        return { workingDays: stats.workingDays, leaveRecords: [], from: periodStart, to: periodEnd };
    }
    const leaveStatusKeys = Object.keys(LIVE_LEAVE_STATUS_MAP);
    const rows = await Attendance.find({
        date: { $gte: periodStart, $lte: periodEnd },
        $and: [
            { $or: clauses },
            {
                $or: [
                    { statusKey: { $in: leaveStatusKeys } },
                    { leaveRequestStatus: { $in: ['approved', 'pending'] } },
                ],
            },
        ],
    })
        .select('date statusKey leaveRequestStatus requestedStatusKey reason')
        .lean();
    const live = summarizeAttendanceEligibility(rows);
    return {
        workingDays: stats.workingDays,
        leaveRecords: liveLeaveRecordsInProcessingWindow(live.leaveRecords, periodStart, periodEnd),
        from: periodStart,
        to: periodEnd,
    };
}

const leaveTicketStateCache = new Map();

export function clearLeaveTicketEntitlementCache(employeeId) {
    if (!employeeId) {
        leaveTicketStateCache.clear();
        return;
    }
    leaveTicketStateCache.delete(String(employeeId).trim().toLowerCase());
}

/**
 * Same remaining leave-salary / ticket totals as Historical Salary Setup.
 */
export async function loadLeaveTicketEntitlement({ employee, profile, salaryDoc, policy }) {
    const empty = {
        entitlements: { entitlements: [], totalLeaveSalary: 0, totalTicketAmount: 0 },
        cycles: [],
        leaveRemaining: 0,
        ticketRemaining: 0,
        leaveDue: 0,
        ticketDue: 0,
        cycleDays: policyLeaveWorkingDays(policy),
    };
    const cacheKey = String(employee?.employeeId || profile?.employeeId || '').trim().toLowerCase();
    const hit = cacheKey ? leaveTicketStateCache.get(cacheKey) : null;
    if (hit && Date.now() - hit.at < 20_000) return hit.value;

    if (!employee || !profile) return empty;

    const joiningDate = toDateKey(
        profile?.contractJoiningDate || employee.contractJoiningDate || employee.dateOfJoining,
    );
    const verpStartDate = toDateKey(profile?.verpStartDate);
    const period = historicalPeriod(joiningDate, verpStartDate);
    const cycleDays = policyLeaveWorkingDays(policy);
    const leaveMultipliers = policyLeaveMultipliers(policy);
    const leaveRecords = consolidateCountOnlyLeaveRecords(
        historicalLeaveOnly(profile?.leaveRecords),
        leaveMultipliers,
    );
    const annualLeaveRecords = historicalLeaveOnly(profile?.annualLeaveRecords);
    const paymentCycles = Array.isArray(profile?.paymentCycles) ? profile.paymentCycles : [];
    const todayKey = dubaiDateKey();
    const liveAttendance = isSalaryProcessingMonthReached(todayKey, verpStartDate)
        ? await loadLiveAttendanceEligibility({
              employee,
              from: verpStartDate,
              to: todayKey,
              staffType: employee.staffType,
          })
        : { workingDays: 0, leaveRecords: [], from: '', to: '' };

    const stats =
        joiningDate && period.end
            ? await calcWorkingDays({
                  from: joiningDate,
                  to: period.end,
                  staffType: employee.staffType,
              })
            : { workingDays: 0, calendarDays: 0 };

    const priorSickDaysByYear = {};
    for (const row of leaveRecords || []) {
        if (String(row?.leaveType || '').toLowerCase() !== 'sick') continue;
        const year = String(row.fromDate || row.toDate || '').slice(0, 4);
        if (!/^\d{4}$/.test(year)) continue;
        priorSickDaysByYear[year] =
            (priorSickDaysByYear[year] || 0) + Math.max(1, Number(row.eligibleWorkingDays) || 1);
    }
    liveAttendance.leaveRecords = applySickAllowanceToLeaveRecords(
        filterHiddenSystemLeave(liveAttendance.leaveRecords || [], profile?.hiddenSystemLeave),
        leavePolicyEntitlements(policy),
        { priorSickDaysByYear },
    );

    const calculation = calculateHistoricalEligibility({
        workingDays: stats.workingDays + (Number(liveAttendance.workingDays) || 0),
        calendarDays: stats.calendarDays,
        leaveRecords: [...leaveRecords, ...(liveAttendance.leaveRecords || [])],
        annualLeaveRecords,
        paymentCycles,
        cycleDays,
        leaveMultipliers,
    });
    const salaryHistory = serializeSalaryHistory(salaryDoc, joiningDate);
    const annualLeaveHistory = annualLeaveHistoryForEntitlement(leaveRecords, annualLeaveRecords);
    const calculationStartDate = resolveEntitlementCalculationStart({
        joiningDate,
        annualLeaveRecords: annualLeaveHistory,
        paymentCycles,
        cycleDays,
    });
    const ticketRate = policyTicketRate(policy) || latestRecordedTicketAmount(paymentCycles);
    const reducingCycles = uniqueConsumingCycles(paymentCycles, cycleDays);
    const entitlements = calculateAnnualLeaveEntitlement({
        calculationStartDate,
        calculationEndDate: liveAttendance.to || period.end || joiningDate,
        eligibleWorkingDays: Math.max(0, Number(calculation.netQualifyingDays) || 0),
        consumedEntitlements: reducingCycles.length,
        reducingCycles,
        requiredDaysPerEntitlement: cycleDays,
        salaryHistory,
        annualLeaveHistory,
        salaryPolicyHistory: [
            {
                effectiveFrom: calculationStartDate || joiningDate,
                airTicketAmount: ticketRate,
            },
        ],
        ticketRate,
    });
    const remaining = remainingLeaveTicketBalances(entitlements, paymentCycles);
    const value = {
        entitlements,
        cycles: paymentCycles,
        leaveRemaining: remaining.leaveRemaining,
        ticketRemaining: remaining.ticketRemaining,
        leaveDue: remaining.leaveDue,
        ticketDue: remaining.ticketDue,
        cycleDays,
    };
    if (cacheKey) leaveTicketStateCache.set(cacheKey, { at: Date.now(), value });
    return value;
}

async function loadAttendanceLeaveInRange({ employee, from, to }) {
    if (!isDateKey(from) || !isDateKey(to) || to < from || !employee) return [];
    const clauses = [];
    if (employee._id) clauses.push({ employeeMongoId: String(employee._id) });
    if (employee.employeeId) clauses.push({ employeeId: employee.employeeId });
    if (!clauses.length) return [];
    const leaveStatusKeys = Object.keys(LIVE_LEAVE_STATUS_MAP);
    const rows = await Attendance.find({
        date: { $gte: from, $lte: to },
        $and: [
            { $or: clauses },
            {
                $or: [
                    { statusKey: { $in: leaveStatusKeys } },
                    { leaveRequestStatus: { $in: ['approved', 'pending'] } },
                ],
            },
        ],
    })
        .select('date statusKey leaveRequestStatus requestedStatusKey reason')
        .lean();
    return summarizeAttendanceEligibility(rows).leaveRecords || [];
}

function countLiveMarksSince(records = [], fromKey) {
    const out = {
        work_from_home: 0,
        late_arrived: 0,
        early_go: 0,
        mispunch: 0,
    };
    for (const row of records) {
        const date = String(row?.date || '').trim();
        if (fromKey && date < fromKey) continue;
        const key = String(row?.statusKey || '').trim();
        if (out[key] != null) out[key] += 1;
    }
    return out;
}

/**
 * Working days and remaining days in the open annual-leave cycle.
 * The cycle starts the day after the last taken annual leave (enroll or attendance).
 */
export async function loadCurrentLeaveCycleEligibility({
    employee,
    profile,
    policy,
    attendanceRecords = [],
} = {}) {
    const joiningDate = toDateKey(
        profile?.contractJoiningDate || employee?.contractJoiningDate || employee?.dateOfJoining,
    );
    const verpStartDate = toDateKey(profile?.verpStartDate);
    const todayKey = dubaiDateKey();
    const entitlements = leavePolicyEntitlements(policy);
    const requiredDays = policyWorkingDayRequirement(policy);
    const annualHistory = annualLeaveHistoryForEntitlement(
        historicalLeaveOnly(profile?.leaveRecords),
        historicalLeaveOnly(profile?.annualLeaveRecords),
    );
    const liveOpen = isSalaryProcessingMonthReached(todayKey, verpStartDate);
    const lastAnnualLeaveEnd = laterDateKey(
        lastTakenAnnualLeaveEnd(annualHistory),
        liveOpen ? lastAnnualLeaveEndFromAttendance(attendanceRecords) : '',
    );
    const cycleStart = leaveCycleStart({ joiningDate, lastAnnualLeaveEnd });
    const processingStart = salaryProcessingStartDay(verpStartDate) || verpStartDate;
    const histWin = historicalWindowForCycle({ joiningDate, verpStartDate, cycleStart });
    const liveWin = liveWindowForCycle({
        verpStartDate: processingStart,
        cycleStart,
        todayKey,
        liveOpen,
    });

    const [historical, liveWorking, liveLeaveRecords, salaryWorking] = await Promise.all([
        histWin.from
            ? calcWorkingDays({ from: histWin.from, to: histWin.to, staffType: employee?.staffType })
            : { workingDays: 0 },
        liveWin.from
            ? calcWorkingDays({ from: liveWin.from, to: liveWin.to, staffType: employee?.staffType })
            : { workingDays: 0 },
        liveOpen && processingStart
            ? loadAttendanceLeaveInRange({ employee, from: processingStart, to: todayKey })
            : [],
        loadEmployeeSalaryWorkingDays(employee, profile),
    ]);

    const enrollLeaveRecords = consolidateCountOnlyLeaveRecords(
        historicalLeaveOnly(profile?.leaveRecords),
        policyLeaveMultipliers(policy),
    );
    const leaveRecords = [...enrollLeaveRecords, ...(liveLeaveRecords || [])];
    const used = enrollLeaveUsedByStatus({
        leaveRecords,
        annualLeaveRecords: annualHistory,
        allRecords: true,
    });
    const deductions = cycleLeaveDeductions({
        leaveRecords,
        annualLeaveRecords: annualHistory,
        policy,
        cycleStart,
        cycleEnd: todayKey,
        lastAnnualLeaveEnd,
    });
    const workingDays = (Number(historical.workingDays) || 0) + (Number(liveWorking.workingDays) || 0);
    const accumulatedDays = Math.max(0, workingDays - (Number(deductions.total) || 0));
    const liveMarks = countLiveMarksSince(attendanceRecords, liveOpen ? processingStart : '');
    const officeDays = Number(salaryWorking?.workingDays) || 0;
    const absentDays =
        (Number(used.on_leave) || 0) +
        (Number(used.sick_leave) || 0) +
        (Number(used.authorized_leave) || 0) +
        (Number(used.unauthorized_leave) || 0) +
        (Number(used.compoff_leave) || 0);

    return {
        ...cycleEligibilitySnapshot({
            accumulatedDays,
            requiredDays,
            airTicketRequiredDays: entitlements.airTicketRequiredDays || requiredDays,
            lastAnnualLeaveEnd,
            cycleStart,
            lastAnnualLeaveDays: lastTakenAnnualLeaveDays(annualHistory, lastAnnualLeaveEnd),
        }),
        presentDays: officeDays,
        historicalWorkingDays: Number(salaryWorking?.historicalWorkingDays) || 0,
        liveWorkingDays: Number(salaryWorking?.liveWorkingDays) || 0,
        accumulatedDays,
        used,
        attendance: {
            office: officeDays,
            wfh: liveMarks.work_from_home,
            absent: absentDays,
            late: liveMarks.late_arrived,
            early: liveMarks.early_go,
            mispunch: liveMarks.mispunch,
        },
    };
}
