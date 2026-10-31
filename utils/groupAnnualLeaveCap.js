import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { markGroupLeaveDays } from './annualLeaveCalendar.js';
import { REAL_EMPLOYEE_MONGO_FILTER, isCompanyShellEmployee } from './attendanceEmployeeFilters.js';
import { resolveEmployeePayrollPolicy } from './employeeLeavePolicy.js';
import { floorGroupLeaveSlots } from './groupLeaveSlots.js';
import { employeeIdInList } from './salaryPolicyExclusions.js';
import { isDateKey } from './salaryHistoricalCalculations.js';
import { listActiveWorkLocations, normalizeStaffTypeKey, staffTypeMongoClause } from './workLocationHelpers.js';

const LEAVE_MARK_KEYS = ['on_leave', 'authorized_leave', 'sick_leave', 'compoff_leave'];

function emptyLeaveMarks() {
    return { yellowSpans: [], cappedDates: [], ownLeaveDates: [], otherLeaves: [] };
}

function isAnnualLeaveRow(row) {
    if (String(row?.leaveRequestStatus || '') === 'rejected') return false;
    if (String(row?.statusKey || '') === 'on_leave') return true;
    return (
        String(row?.requestedStatusKey || '') === 'on_leave' &&
        ['pending', 'approved'].includes(String(row?.leaveRequestStatus || ''))
    );
}

/**
 * How many people in this employee's work-location group may be on annual leave,
 * and how many already are on the selected days.
 */
function earlierDate(a, b) {
    if (!isDateKey(a)) return isDateKey(b) ? b : '';
    if (!isDateKey(b)) return a;
    return a < b ? a : b;
}

function laterDate(a, b) {
    if (!isDateKey(a)) return isDateKey(b) ? b : '';
    if (!isDateKey(b)) return a;
    return a > b ? a : b;
}

export async function loadGroupAnnualLeaveCap({
    employee,
    from = '',
    to = '',
    markFrom = '',
    markTo = '',
} = {}) {
    if (!employee?._id || isCompanyShellEmployee(employee)) {
        return { enabled: false, ...emptyLeaveMarks() };
    }

    const policy = await resolveEmployeePayrollPolicy(employee);
    if (employeeIdInList(employee.employeeId, policy?.leaveExclusionEmployeeIds)) {
        return { enabled: false, ...emptyLeaveMarks() };
    }

    const minPercent = policy?.minAllowedLeavePerGroupPercent ?? null;
    const maxPercent = policy?.maxAllowedLeavePerGroupPercent ?? null;

    const staffType = normalizeStaffTypeKey(employee.staffType);
    const [locations, members] = await Promise.all([
        listActiveWorkLocations().catch(() => []),
        EmployeeBasic.find({
            ...REAL_EMPLOYEE_MONGO_FILTER,
            ...staffTypeMongoClause(staffType),
            status: { $ne: 'Left User' },
        })
            .select({ _id: 1, employeeId: 1, firstName: 1, lastName: 1 })
            .lean()
            .maxTimeMS(8000),
    ]);

    const groupMembers = members.filter(
        (row) => !employeeIdInList(row.employeeId, policy?.leaveExclusionEmployeeIds),
    );
    const employeeCount = groupMembers.length;
    const minAllowed = minPercent == null ? null : floorGroupLeaveSlots(employeeCount, minPercent);
    const maxAllowed = maxPercent == null ? null : floorGroupLeaveSlots(employeeCount, maxPercent);
    const groupLabel =
        (Array.isArray(locations) ? locations : []).find((row) => row.key === staffType)?.label ||
        staffType ||
        'Group';

    const rangeFrom = String(from || '').trim();
    const rangeTo = String(to || '').trim();
    const hasRange = isDateKey(rangeFrom) && isDateKey(rangeTo) && rangeTo >= rangeFrom;

    let taken = 0;
    let applicantAlreadyCounted = false;
    let blockers = [];
    let otherLeaves = [];
    let marks = emptyLeaveMarks();
    const queryFrom = earlierDate(markFrom, hasRange ? rangeFrom : '');
    const queryTo = laterDate(markTo, hasRange ? rangeTo : '');
    if (queryFrom && queryTo && queryTo >= queryFrom && groupMembers.length) {
        const ids = groupMembers.map((row) => String(row._id));
        const names = new Map(
            groupMembers.map((row) => [
                String(row._id),
                {
                    employeeId: row.employeeId || '',
                    name: [row.firstName, row.lastName].filter(Boolean).join(' ').trim() || row.employeeId || 'Employee',
                },
            ]),
        );
        const rows = await Attendance.find({
            employeeMongoId: { $in: ids },
            date: { $gte: queryFrom, $lte: queryTo },
            leaveRequestStatus: { $ne: 'rejected' },
            $or: [
                { statusKey: { $in: LEAVE_MARK_KEYS } },
                {
                    requestedStatusKey: { $in: LEAVE_MARK_KEYS },
                    leaveRequestStatus: { $in: ['pending', 'approved'] },
                },
            ],
        })
            .select({ employeeMongoId: 1, date: 1, leaveRequestStatus: 1, statusKey: 1, requestedStatusKey: 1 })
            .lean()
            .maxTimeMS(8000);

        const annualInRange = (rows || []).filter(
            (row) => hasRange && isAnnualLeaveRow(row) && row.date >= rangeFrom && row.date <= rangeTo,
        );
        const byPerson = new Map();
        for (const row of annualInRange) {
            const id = String(row.employeeMongoId || '');
            if (!id) continue;
            const current = byPerson.get(id) || {
                employeeMongoId: id,
                employeeId: names.get(id)?.employeeId || '',
                name: names.get(id)?.name || 'Employee',
                status: String(row.leaveRequestStatus || '').trim() || (row.statusKey === 'on_leave' ? 'approved' : ''),
                dates: [],
            };
            if (row.date) current.dates.push(String(row.date));
            if (row.statusKey === 'on_leave' || row.leaveRequestStatus === 'approved') current.status = 'approved';
            byPerson.set(id, current);
        }
        blockers = [...byPerson.values()].map((row) => ({
            ...row,
            dates: [...new Set(row.dates)].sort(),
        }));
        const people = new Set(blockers.map((row) => row.employeeMongoId));
        taken = people.size;
        applicantAlreadyCounted = people.has(String(employee._id));
        const applicantId = String(employee._id);
        const others = new Map();
        for (const row of rows || []) {
            const id = String(row.employeeMongoId || '');
            const date = String(row.date || '');
            if (!id || id === applicantId || !isDateKey(date)) continue;
            const current = others.get(id) || {
                employeeMongoId: id,
                name: names.get(id)?.name || 'Employee',
                dates: [],
            };
            current.dates.push(date);
            others.set(id, current);
        }
        otherLeaves = [...others.values()].map((row) => ({
            ...row,
            dates: [...new Set(row.dates)].sort(),
        }));
        marks = markGroupLeaveDays(
            (rows || []).map((row) => ({
                employeeMongoId: row.employeeMongoId,
                date: row.date,
                countsTowardCap: isAnnualLeaveRow(row),
            })),
            { applicantId: String(employee._id), maxAllowed },
        );
    }

    const projected = !hasRange ? taken : applicantAlreadyCounted ? taken : taken + 1;
    const enabled = minPercent != null || maxPercent != null;
    const over = enabled && maxAllowed != null && hasRange && projected > maxAllowed;
    const message = over
        ? `Only ${maxAllowed} ${maxAllowed === 1 ? 'employee' : 'employees'} (${maxPercent}%) in ${groupLabel} can be on annual leave on these days. ${taken} already requested or approved.`
        : '';

    return {
        enabled,
        groupLabel,
        employeeCount,
        minPercent,
        maxPercent,
        minAllowed,
        maxAllowed,
        taken,
        over,
        message,
        blockers,
        ...marks,
        otherLeaves,
    };
}
