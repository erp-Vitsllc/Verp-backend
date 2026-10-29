import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Holiday from '../models/Holiday.js';
import { compensableNonWorkingContext } from './attendanceNonWorkingDay.js';
import { isCompanyShellEmployee, REAL_EMPLOYEE_MONGO_FILTER } from './attendanceEmployeeFilters.js';
import { addDaysKey } from './flexibleAttendance.js';
import {
    isSalaryMonthOpen,
    loadEnrolledLeaveVisibilityByMongoId,
} from './leaveSalaryVisibility.js';
import {
    clockTimeToMinutes,
    getWeekForStaffType,
    loadWorkingTimeDoc,
    normalizeStaffType,
    weekdayKeyFromDateKey,
} from './workingTimeHelpers.js';

export const OFF_DAY_WORK_REQUEST_TYPE = 'Attendance Off Day Work';
export const OFF_DAY_WORK_KIND = 'off_day_work';
export const OFF_DAY_WORK_LOOKBACK_DAYS = 548;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const NOT_WORKED_STATUS = new Set([
    'sick_leave',
    'on_leave',
    'authorized_leave',
    'compoff_leave',
    'work_from_home',
]);

function dubaiDateKey(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Dubai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date);
}

export function formatOffDayDate(dateKey) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || '').trim());
    if (!match) return String(dateKey || '').trim();
    const day = Number(match[3]);
    const month = MONTHS[Number(match[2]) - 1] || '';
    return `${day} ${month} ${match[1]}`;
}

/** Holiday wins. Sunday is named even when it is also the weekly off. */
export function offDayWorkKind({ date, week, holiday, staffType }) {
    const hit = compensableNonWorkingContext({ holiday, week, staffType, date });
    if (!hit) return null;
    if (hit.kind === 'holiday') return { kind: 'holiday', dayLabel: 'Holiday' };
    if (hit.kind === 'sunday' || weekdayKeyFromDateKey(date) === 'sunday') {
        return { kind: 'sunday', dayLabel: 'Sunday' };
    }
    return { kind: 'weekly_off', dayLabel: 'Weekly Off' };
}

function clockPunch(value) {
    const text = String(value || '').trim();
    if (!text || text === 'OT') return false;
    return clockTimeToMinutes(text) != null;
}

/** A finished shift. Check-out is required before OT or comp off can be given. */
export function hasFinishedOffDayShift(row) {
    if (!row) return false;
    if (String(row.flexibleFromOtDate || '').trim()) return false;
    return clockPunch(row.timeIn) && clockPunch(row.timeOut);
}

/** OT hours or a comp-off next day that is Present. A pending request is not given yet. */
export function offDayWorkSettled(row) {
    if (String(row?.flexibleOtStatus || '') !== 'approved') return false;
    const approved = Number(row?.flexibleOtApprovedHours) || 0;
    const nextDay = String(row?.flexibleOtNextDayDate || '').trim();
    return Boolean(nextDay) || approved > 0;
}

export function offDayWorkNoticeCopy({ name, date, dayLabel }) {
    const who = String(name || '').trim() || 'Employee';
    return `${who} worked on ${formatOffDayDate(date)} (${dayLabel})`;
}

function employeeDisplayName(employee, row) {
    const fromRow = String(row?.employeeName || '').trim();
    if (fromRow && !isCompanyShellEmployee(fromRow)) return fromRow;
    return [employee?.firstName, employee?.lastName].filter(Boolean).join(' ').trim() || 'Employee';
}

export function buildOffDayWorkInboxItem({ row, employee, kind }) {
    const name = employeeDisplayName(employee, row);
    const date = String(row?.date || '').trim();
    const sentence = offDayWorkNoticeCopy({
        name,
        date,
        dayLabel: kind?.dayLabel || 'Weekly Off',
    });
    const id = String(row?._id || `${row?.employeeMongoId || ''}:${date}`);
    return {
        id,
        dashboardActionId: id,
        requestType: OFF_DAY_WORK_REQUEST_TYPE,
        requestObjectId: id,
        date,
        employeeMongoId: String(row?.employeeMongoId || employee?._id || ''),
        employeeId: String(row?.employeeId || employee?.employeeId || ''),
        subjectName: name,
        staffType: normalizeStaffType(employee?.staffType),
        leaveRequestKind: OFF_DAY_WORK_KIND,
        offDayKind: kind?.kind || '',
        status: 'Pending',
        requestedDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00.000Z` : null,
        extra1: 'Give OT or Comp Off',
        extra2: sentence,
        message: sentence,
    };
}

export function buildOffDayWorkInboxItems({ rows, employees, holidays, workingTime } = {}) {
    const people = new Map(
        (employees || [])
            .filter((employee) => employee && !isCompanyShellEmployee(employee))
            .map((employee) => [String(employee._id), employee]),
    );
    const holidayByDate = new Map(
        (holidays || []).map((holiday) => [String(holiday.date || ''), holiday]),
    );
    const items = [];
    for (const row of rows || []) {
        if (!hasFinishedOffDayShift(row) || offDayWorkSettled(row)) continue;
        if (NOT_WORKED_STATUS.has(String(row?.statusKey || '').trim())) continue;
        const employee = people.get(String(row?.employeeMongoId || ''));
        if (!employee) continue;
        const staffType = normalizeStaffType(employee.staffType);
        const week = getWeekForStaffType(workingTime, staffType);
        const kind = offDayWorkKind({
            date: row.date,
            week,
            holiday: holidayByDate.get(String(row.date || '')) || null,
            staffType,
        });
        if (!kind) continue;
        items.push(buildOffDayWorkInboxItem({ row, employee, kind }));
    }
    items.sort((left, right) => {
        const byDate = String(right.date).localeCompare(String(left.date));
        if (byDate) return byDate;
        return String(left.subjectName).localeCompare(String(right.subjectName));
    });
    return items.slice(0, 200);
}

/**
 * Primary reportee bell: reportees who worked a Sunday, weekly off, or holiday
 * and have not been given OT or a comp-off next day.
 */
export async function loadOffDayWorkInboxItems(reporteeIds) {
    const ids = [...new Set((reporteeIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) return [];

    const today = dubaiDateKey();
    const from = addDaysKey(today, -OFF_DAY_WORK_LOOKBACK_DAYS);
    const employees = await EmployeeBasic.find({
        _id: { $in: ids },
        profileStatus: 'active',
        status: { $ne: 'Left User' },
        employeeId: { $ne: 'VEGA-HR-0000' },
        ...REAL_EMPLOYEE_MONGO_FILTER,
    })
        .select('_id employeeId firstName lastName staffType')
        .lean()
        .maxTimeMS(8000);
    const people = (employees || []).filter((employee) => !isCompanyShellEmployee(employee));
    if (!people.length) return [];

    const peopleIds = people.map((employee) => String(employee._id));
    const [workingTime, holidays, enrolledFrom] = await Promise.all([
        loadWorkingTimeDoc(),
        Holiday.find({ date: { $gte: from, $lte: today } }).select('date name appliesTo').lean().maxTimeMS(8000),
        loadEnrolledLeaveVisibilityByMongoId(people),
    ]);

    const holidayByDate = new Map((holidays || []).map((holiday) => [String(holiday.date), holiday]));
    const weekByStaff = new Map();
    for (const employee of people) {
        const staffType = normalizeStaffType(employee.staffType);
        if (!weekByStaff.has(staffType)) {
            weekByStaff.set(staffType, getWeekForStaffType(workingTime, staffType));
        }
    }
    const dates = new Set();
    for (const [staffType, week] of weekByStaff) {
        let cursor = from;
        while (cursor <= today) {
            if (offDayWorkKind({
                date: cursor,
                week,
                holiday: holidayByDate.get(cursor) || null,
                staffType,
            })) {
                dates.add(cursor);
            }
            cursor = addDaysKey(cursor, 1);
        }
    }
    if (!dates.size) return [];

    const rows = await Attendance.find({
        employeeMongoId: { $in: peopleIds },
        date: { $in: [...dates] },
        timeIn: { $nin: ['', 'OT', null] },
        timeOut: { $nin: ['', 'OT', null] },
        statusKey: { $nin: [...NOT_WORKED_STATUS] },
    })
        .select(
            'date employeeMongoId employeeId employeeName statusKey timeIn timeOut flexibleOtStatus flexibleOtApprovedHours flexibleOtNextDayDate flexibleFromOtDate',
        )
        .lean()
        .maxTimeMS(8000);

    return buildOffDayWorkInboxItems({
        rows,
        employees: people,
        holidays,
        workingTime,
    }).filter((item) => {
        const start = enrolledFrom.get(String(item.employeeMongoId || ''));
        if (!start) return false;
        return isSalaryMonthOpen(String(item.date || '').slice(0, 7), start);
    });
}
