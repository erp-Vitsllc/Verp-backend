import Attendance from '../models/Attendance.js';
import {
    addDays,
    isDateKey,
    policyLeaveWorkingDays,
    twelveMonthPeriodEnd,
} from './salaryHistoricalCalculations.js';
import { calcWorkingDays, dubaiDateKey, toDateKey } from './loadLeaveTicketEntitlement.js';

export const ANNUAL_LEAVE_ALLOWED_DAYS = 30;

const DEDUCTION_STATUS = new Set([
    'authorized_leave',
    'unauthorized_leave',
    'sick_leave',
    'on_leave',
    'compoff_leave',
    'not_marked',
    'absent',
]);

function eachDate(from, to) {
    if (!isDateKey(from) || !isDateKey(to) || to < from) return [];
    const dates = [];
    let cursor = from;
    while (cursor <= to && dates.length < 4000) {
        dates.push(cursor);
        cursor = addDays(cursor, 1);
    }
    return dates;
}

function leaveRange(row) {
    const from = toDateKey(row?.startDate || row?.fromDate);
    const to = toDateKey(row?.endDate || row?.toDate) || from;
    if (!isDateKey(from) || !isDateKey(to) || to < from) return null;
    return { from, to };
}

function isAnnualRow(row) {
    const type = String(row?.leaveType || row?.type || 'annual').toLowerCase();
    return !row?.leaveType || type === 'annual' || type === 'on_leave';
}

function collectHistorical(profile) {
    const deductionDates = [];
    const annual = [];
    let undatedDeduction = 0;
    const rows = [
        ...(Array.isArray(profile?.leaveRecords) ? profile.leaveRecords : []),
        ...(Array.isArray(profile?.annualLeaveRecords) ? profile.annualLeaveRecords : []),
    ];
    for (const row of rows) {
        const status = String(row?.status || '').toLowerCase();
        if (['cancelled', 'rejected', 'draft'].includes(status)) continue;
        const type = String(row?.leaveType || row?.type || '').toLowerCase();
        if (type === 'holiday') continue;
        const range = leaveRange(row);
        if (!range) {
            const days = Math.max(0, Number(row?.eligibleWorkingDays ?? row?.actualDays ?? row?.deductionDays) || 0);
            if (days) undatedDeduction += days;
            continue;
        }
        const dates = eachDate(range.from, range.to);
        deductionDates.push(...dates);
        if (isAnnualRow(row)) {
            annual.push({
                dates,
                status: status === 'pending' ? 'pending' : 'approved',
            });
        }
    }
    return { deductionDates, annual, undatedDeduction };
}

function datesInWindow(dates, start, end) {
    return (dates || []).filter((date) => isDateKey(date) && date >= start && date <= end);
}

function periodByIndex(joiningDate, index) {
    let startDate = joiningDate;
    for (let step = 1; step < index; step += 1) {
        const endDate = twelveMonthPeriodEnd(startDate);
        if (!isDateKey(endDate)) return null;
        startDate = addDays(endDate, 1);
    }
    const endDate = twelveMonthPeriodEnd(startDate);
    if (!isDateKey(startDate) || !isDateKey(endDate)) return null;
    return { startDate, endDate };
}

/**
 * The joining year is worked. Each completed 300-day cycle opens the next
 * 12-month row (300 → the year after joining, 600 → the year after that).
 * Leave taken inside that start and end reduces the 30-day balance.
 * The latest row is Active. Every earlier row is Lapsed.
 */
export function buildAnnualLeaveWindows({
    joiningDate = '',
    workingDateKeys = [],
    deductionDates = [],
    undatedDeduction = 0,
    annualLeaves = [],
    cycleDays = 300,
    allowedDays = ANNUAL_LEAVE_ALLOWED_DAYS,
    today = '',
} = {}) {
    const step = Math.max(1, Number(cycleDays) || 300);
    const allowed = Math.max(0, Number(allowedDays) || ANNUAL_LEAVE_ALLOWED_DAYS);
    const deduct = new Set((deductionDates || []).filter((date) => isDateKey(date)));
    let counted = (workingDateKeys || []).filter((date) => isDateKey(date) && !deduct.has(date));
    const drop = Math.max(0, Math.floor(Number(undatedDeduction) || 0));
    if (drop) counted = counted.slice(drop);
    const completed = Math.floor(counted.length / step);
    const remainderDays = counted.length % step;
    const todayKey = isDateKey(today) ? today : '';
    const joining = isDateKey(joiningDate) ? joiningDate : '';
    const entitled = joining && (!todayKey || joining <= todayKey) ? completed : 0;

    const windows = [];
    for (let index = 1; index <= entitled; index += 1) {
        const period = periodByIndex(joining, index + 1);
        if (!period) break;
        const { startDate, endDate } = period;
        const approved = new Set();
        const pending = new Set();
        for (const leave of annualLeaves || []) {
            const dates = datesInWindow(leave.dates, startDate, endDate);
            const bucket = leave.status === 'pending' ? pending : approved;
            dates.forEach((date) => bucket.add(date));
        }
        pending.forEach((date) => approved.delete(date));
        const approvedDays = approved.size;
        const pendingDays = pending.size;
        const usedDays = approvedDays + pendingDays;
        const status = index < entitled ? 'Lapsed' : 'Active';
        const notStarted = Boolean(todayKey && todayKey < startDate);
        const ended = Boolean(todayKey && todayKey > endDate);
        const balance = Math.max(0, allowed - usedDays);
        const open = status === 'Active' && !notStarted && !ended;
        windows.push({
            index,
            startDate,
            endDate,
            allowedDays: allowed,
            approvedDays,
            pendingDays,
            takenDays: usedDays,
            balance,
            remainingDays: open ? balance : 0,
            leaveDates: [...approved, ...pending].sort(),
            status,
            canTake: open && balance > 0,
        });
    }

    const active = windows.find((row) => row.canTake)
        || windows.find((row) => row.status === 'Active')
        || null;
    return {
        cycleDays: step,
        allowedDays: allowed,
        countedDays: counted.length,
        completedCycles: completed,
        remainderDays,
        entitledPeriods: entitled,
        windows,
        active,
        remainingDays: active ? active.remainingDays : 0,
        startDate: active?.startDate || '',
        endDate: active?.endDate || '',
    };
}

export function annualLeaveRequestBlock(allowance, { from = '', to = '', requestedDates = [] } = {}) {
    const windows = allowance?.windows || [];
    const start = String(from || '').trim();
    const end = String(to || '').trim();
    const dated = isDateKey(start) && isDateKey(end);
    const row = dated
        ? windows.find((item) => start >= item.startDate && end <= item.endDate) || null
        : allowance?.active || windows.find((item) => item.status === 'Active') || null;
    if (!row) {
        return {
            ok: false,
            message: 'Annual leave follows 12-month periods from the contract joining date. These dates are outside every period.',
        };
    }
    if (row.status === 'Lapsed') {
        return {
            ok: false,
            message: `Annual leave for ${row.startDate} to ${row.endDate} has lapsed and those days cannot be taken.`,
        };
    }
    if (row.status !== 'Active') {
        const cycle = allowance?.cycleDays || 300;
        return {
            ok: false,
            message: `Annual leave for ${row.startDate} to ${row.endDate} opens when counted working days complete the next ${cycle}-day cycle.`,
        };
    }
    const days = Array.isArray(requestedDates) ? requestedDates.length : 0;
    if (days > row.remainingDays) {
        return {
            ok: false,
            message: `Only ${row.remainingDays} annual leave day${row.remainingDays === 1 ? '' : 's'} remain in ${row.startDate} to ${row.endDate}.`,
        };
    }
    return { ok: true, message: '' };
}

export async function loadAnnualLeaveAllowance({ employee, profile, policy } = {}) {
    const joiningDate = toDateKey(
        profile?.contractJoiningDate || employee?.contractJoiningDate || employee?.dateOfJoining,
    );
    const today = dubaiDateKey();
    const cycleDays = policyLeaveWorkingDays(policy);
    if (!employee?._id || !isDateKey(joiningDate) || joiningDate > today) {
        return buildAnnualLeaveWindows({ cycleDays, today });
    }

    const [working, attendanceRows] = await Promise.all([
        calcWorkingDays({ from: joiningDate, to: today, staffType: employee.staffType }),
        Attendance.find({
            $or: [
                { employeeMongoId: String(employee._id) },
                ...(employee.employeeId ? [{ employeeId: employee.employeeId }] : []),
            ],
            date: { $gte: joiningDate, $lte: today },
        })
            .select('date statusKey requestedStatusKey leaveRequestStatus')
            .lean()
            .maxTimeMS(8000),
    ]);

    const historical = collectHistorical(profile);
    const deductionDates = [...historical.deductionDates];
    const annualLeaves = [...historical.annual];

    for (const row of attendanceRows || []) {
        const date = toDateKey(row?.date);
        if (!isDateKey(date)) continue;
        const statusKey = String(row?.statusKey || '').trim();
        const requested = String(row?.requestedStatusKey || '').trim();
        const requestStatus = String(row?.leaveRequestStatus || '').trim();
        if (DEDUCTION_STATUS.has(statusKey) || (DEDUCTION_STATUS.has(requested) && requestStatus !== 'rejected')) {
            deductionDates.push(date);
        }
        const annualTaken = statusKey === 'on_leave';
        const annualPending = requested === 'on_leave' && requestStatus === 'pending';
        const annualApproved = requested === 'on_leave' && requestStatus === 'approved' && !annualTaken;
        if (annualTaken || annualApproved) annualLeaves.push({ dates: [date], status: 'approved' });
        else if (annualPending) annualLeaves.push({ dates: [date], status: 'pending' });
    }

    return buildAnnualLeaveWindows({
        joiningDate,
        workingDateKeys: working.workingDateKeys || [],
        deductionDates,
        undatedDeduction: historical.undatedDeduction,
        annualLeaves,
        cycleDays,
        today,
    });
}
