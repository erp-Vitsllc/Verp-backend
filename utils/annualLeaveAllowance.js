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

function overlapDates(dates, start, end, workingSet) {
    return (dates || []).filter((date) => date >= start && date <= end && workingSet.has(date));
}

/**
 * One 30-day annual leave window for each completed working-day cycle.
 * Older windows stay visible as Lapsed and cannot be used.
 */
export function buildAnnualLeaveWindows({
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
    const workingSet = new Set(workingDateKeys || []);
    const todayKey = isDateKey(today) ? today : '';
    const windows = [];

    for (let index = 0; index < completed; index += 1) {
        const startDate = counted[(index + 1) * step - 1];
        const endDate = twelveMonthPeriodEnd(startDate);
        const isLatest = index === completed - 1;
        const approved = new Set();
        const pending = new Set();
        for (const leave of annualLeaves || []) {
            const dates = overlapDates(leave.dates, startDate, endDate, workingSet);
            const bucket = leave.status === 'pending' ? pending : approved;
            dates.forEach((date) => bucket.add(date));
        }
        pending.forEach((date) => approved.delete(date));
        const approvedDays = approved.size;
        const pendingDays = pending.size;
        const usedDays = approvedDays + pendingDays;
        const balance = Math.max(0, allowed - usedDays);
        const open = isLatest && (!todayKey || !endDate || todayKey <= endDate);
        windows.push({
            index: index + 1,
            startDate,
            endDate,
            allowedDays: allowed,
            approvedDays,
            pendingDays,
            takenDays: usedDays,
            balance,
            remainingDays: open ? balance : 0,
            leaveDates: [...approved, ...pending].sort(),
            status: isLatest ? (open ? 'Active' : 'Ended') : 'Lapsed',
            canTake: open && balance > 0,
        });
    }

    const active = windows.find((row) => row.status === 'Active') || null;
    return {
        cycleDays: step,
        allowedDays: allowed,
        windows,
        active,
        remainingDays: active ? active.remainingDays : 0,
        startDate: active?.startDate || '',
        endDate: active?.endDate || '',
    };
}

export function annualLeaveRequestBlock(allowance, { from = '', to = '', requestedDates = [] } = {}) {
    const active = allowance?.active || (allowance?.windows || []).find((row) => row.status === 'Active') || null;
    if (!active) {
        return {
            ok: false,
            message: 'Annual leave opens after counted working days reach the salary-policy cycle. There is no open period to take.',
        };
    }
    const start = String(from || '').trim();
    const end = String(to || '').trim();
    if (isDateKey(start) && start < active.startDate) {
        return {
            ok: false,
            message: `Annual leave in this period can start from ${active.startDate}.`,
        };
    }
    if (isDateKey(end) && active.endDate && end > active.endDate) {
        return {
            ok: false,
            message: `Annual leave in this period can be taken through ${active.endDate}.`,
        };
    }
    const days = Array.isArray(requestedDates) ? requestedDates.length : 0;
    if (days > active.remainingDays) {
        return {
            ok: false,
            message: `Only ${active.remainingDays} annual leave day${active.remainingDays === 1 ? '' : 's'} remain in ${active.startDate} to ${active.endDate}.`,
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
        workingDateKeys: working.workingDateKeys || [],
        deductionDates,
        undatedDeduction: historical.undatedDeduction,
        annualLeaves,
        cycleDays,
        today,
    });
}
