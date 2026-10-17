import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { dayDeductionFraction } from './dayDeductionFraction.js';
import { DEDUCTION_STATUS_KEYS } from './deductionWaive.js';
import { loadPayrollPoliciesByEmployee } from './employeeLeavePolicy.js';
import { punchAttendanceKind } from './partialLeaveWindow.js';
import { getWeekForStaffType, loadWorkingTimeDoc } from './workingTimeHelpers.js';

const MONTH_SELECT = [
    'employeeMongoId',
    'date',
    'statusKey',
    'statusLabel',
    'reason',
    'timeIn',
    'timeOut',
    'timeOutDate',
    'punchSessions',
    'flexibleWorkedHours',
    'hourAdjustStatus',
    'hourAdjustKind',
    'hoursApproved',
    'leaveRequestDayPart',
    'leaveDayFraction',
    'leaveDeductionTimes',
    'leaveRequestSession',
    'deductionWaived',
].join(' ');

function monthWindow(date) {
    const ym = String(date || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) return null;
    const [year, month] = ym.split('-').map(Number);
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

function rowNeedsDeduction(row) {
    const key = String(row?.statusKey || '').trim();
    return DEDUCTION_STATUS_KEYS.has(key) || Boolean(punchAttendanceKind(row));
}

function withZero(records) {
    return (Array.isArray(records) ? records : []).map((row) => ({ ...row, deductionDays: 0 }));
}

/** Adds deductionDays: the salary-day fraction for that row. Zero means nothing to waive. */
export async function attachAttendanceDeductionDays(records = []) {
    const list = Array.isArray(records) ? records : [];
    const targets = list.filter(rowNeedsDeduction);
    if (!targets.length) return withZero(list);

    const window = monthWindow(targets.find((row) => String(row?.date || '').length >= 7)?.date);
    const ids = [...new Set(targets.map((row) => String(row.employeeMongoId || '')).filter((id) => /^[a-fA-F0-9]{24}$/.test(id)))];
    if (!window || !ids.length) return withZero(list);

    const [employees, monthRows, workingTime] = await Promise.all([
        EmployeeBasic.find({ _id: { $in: ids } }).select('employeeId staffType').lean(),
        Attendance.find({
            employeeMongoId: { $in: ids },
            date: { $gte: window.from, $lte: window.to },
            statusKey: { $in: [...DEDUCTION_STATUS_KEYS] },
        }).select(MONTH_SELECT).lean(),
        loadWorkingTimeDoc(),
    ]);
    const policies = await loadPayrollPoliciesByEmployee(employees);
    const fallbackPolicy = policies.get('__default__') || {};
    const employeeById = new Map((employees || []).map((employee) => [String(employee._id), employee]));
    const weeks = new Map();
    const weekFor = (employee) => {
        const staff = String(employee?.staffType || '');
        if (!weeks.has(staff)) weeks.set(staff, getWeekForStaffType(workingTime, staff));
        return weeks.get(staff);
    };
    const rowsByEmployee = new Map();
    for (const row of monthRows || []) {
        const id = String(row.employeeMongoId || '');
        const bucket = rowsByEmployee.get(id) || [];
        bucket.push(row);
        rowsByEmployee.set(id, bucket);
    }

    const daysByIdentity = new Map();
    for (const target of targets) {
        const id = String(target.employeeMongoId || '');
        const employee = employeeById.get(id);
        const policy = policies.get(id) || fallbackPolicy;
        const fraction = dayDeductionFraction(
            target,
            rowsByEmployee.get(id) || [],
            policy,
            weekFor(employee),
        );
        daysByIdentity.set(`${id}|${String(target.date || '').slice(0, 10)}`, fraction);
    }

    return list.map((row) => {
        const identity = `${String(row.employeeMongoId || '')}|${String(row.date || '').slice(0, 10)}`;
        return {
            ...row,
            deductionDays: daysByIdentity.has(identity) ? daysByIdentity.get(identity) : 0,
        };
    });
}
