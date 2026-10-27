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
 * Row 1 starts on the contract joining date. Each later row starts the day
 * after the previous leave eligible date. A row counts annual leave from its
 * joining date through the next row's leave eligible date, up to 30 days.
 * Days past 30 move to the next row. The row stays Inactive until that
 * 300-day cycle is complete, then Active. It becomes Lapsed once the next
 * row's leave eligible date is today or earlier.
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

    const periods = [];
    if (joining && (!todayKey || joining <= todayKey)) {
        for (let index = 1; index < 80; index += 1) {
            const period = periodByIndex(joining, index);
            if (!period) break;
            if (todayKey && period.startDate > todayKey) break;
            const next = periodByIndex(joining, index + 1);
            periods.push({
                index,
                startDate: period.startDate,
                endDate: period.endDate,
                takeUntil: next?.endDate || period.endDate,
            });
        }
    }

    const leaveDates = [];
    for (const leave of annualLeaves || []) {
        for (const date of leave?.dates || []) {
            if (!isDateKey(date)) continue;
            leaveDates.push({ date, pending: leave.status === 'pending' });
        }
    }
    leaveDates.sort((a, b) => a.date.localeCompare(b.date) || Number(a.pending) - Number(b.pending));
    const seen = new Set();
    const uniqueLeaves = [];
    for (const leave of leaveDates) {
        if (seen.has(leave.date)) continue;
        seen.add(leave.date);
        uniqueLeaves.push(leave);
    }

    const countedOnRow = periods.map(() => []);
    const placeOnRow = (rowIndex, leave) => {
        countedOnRow[rowIndex].push(leave);
    };
    for (const leave of uniqueLeaves) {
        let placed = false;
        for (let index = 0; index < periods.length; index += 1) {
            const period = periods[index];
            if (leave.date < period.startDate || leave.date > period.takeUntil) continue;
            if (countedOnRow[index].length >= allowed) continue;
            placeOnRow(index, leave);
            placed = true;
            break;
        }
        if (placed) continue;
        for (let index = 0; index < periods.length; index += 1) {
            const period = periods[index];
            if (leave.date > period.takeUntil) continue;
            if (countedOnRow[index].length >= allowed) continue;
            placeOnRow(index, leave);
            break;
        }
    }

    const windows = periods.map((period, index) => {
        const countedHere = countedOnRow[index];
        const pendingDays = countedHere.filter((leave) => leave.pending).length;
        const approvedDays = countedHere.length - pendingDays;
        const usedDays = countedHere.length;
        const cycleReady = counted.length >= (index + 1) * step;
        const lapsed = Boolean(todayKey && period.takeUntil <= todayKey);
        const status = lapsed ? 'Lapsed' : cycleReady ? 'Active' : 'Inactive';
        const eligible = status !== 'Inactive';
        const balance = eligible ? Math.max(0, allowed - usedDays) : 0;
        const dates = countedHere.map((leave) => leave.date).sort();
        return {
            index: period.index,
            startDate: period.startDate,
            endDate: period.endDate,
            takeUntil: period.takeUntil,
            allowedDays: eligible ? allowed : 0,
            approvedDays,
            pendingDays,
            takenDays: usedDays,
            balance,
            remainingDays: status === 'Active' ? balance : 0,
            leaveDates: dates,
            status,
            canTake: status === 'Active' && balance > 0,
        };
    });

    const active = windows.find((row) => row.canTake)
        || windows.find((row) => row.status === 'Active')
        || null;
    return {
        cycleDays: step,
        allowedDays: allowed,
        countedDays: counted.length,
        completedCycles: completed,
        remainderDays,
        entitledPeriods: windows.filter((row) => row.status !== 'Inactive').length,
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
    const datedRow = dated
        ? windows.find((item) => start >= item.startDate && end <= item.takeUntil && item.remainingDays > 0 && item.status === 'Active')
            || windows.find((item) => start >= item.startDate && end <= item.takeUntil)
        : null;
    const row = datedRow || allowance?.active || windows.find((item) => item.status === 'Active') || null;
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
    let capacity = 0;
    let started = false;
    for (const item of windows) {
        if (item.index === row.index) started = true;
        if (!started) continue;
        if (dated && end > item.takeUntil) break;
        if (item.status !== 'Active') break;
        capacity += item.remainingDays;
    }
    if (days > capacity) {
        return {
            ok: false,
            message: `Only ${capacity} annual leave day${capacity === 1 ? '' : 's'} remain in ${row.startDate} to ${row.takeUntil}.`,
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
