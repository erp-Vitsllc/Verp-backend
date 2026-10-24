import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { REAL_EMPLOYEE_MONGO_FILTER, isCompanyShellEmployee } from './attendanceEmployeeFilters.js';
import { resolveEmployeePayrollPolicy } from './employeeLeavePolicy.js';
import { floorGroupLeaveSlots } from './groupLeaveSlots.js';
import { employeeIdInList } from './salaryPolicyExclusions.js';
import { listActiveWorkLocations, normalizeStaffTypeKey, staffTypeMongoClause } from './workLocationHelpers.js';

function isDateKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

/**
 * How many people in this employee's work-location group may be on annual leave,
 * and how many already are on the selected days.
 */
export async function loadGroupAnnualLeaveCap({ employee, from = '', to = '' } = {}) {
    if (!employee?._id || isCompanyShellEmployee(employee)) {
        return { enabled: false };
    }

    const policy = await resolveEmployeePayrollPolicy(employee);
    if (employeeIdInList(employee.employeeId, policy?.leaveExclusionEmployeeIds)) {
        return { enabled: false };
    }

    const minPercent = policy?.minAllowedLeavePerGroupPercent ?? null;
    const maxPercent = policy?.maxAllowedLeavePerGroupPercent ?? null;
    if (minPercent == null && maxPercent == null) {
        return { enabled: false };
    }

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
    if (hasRange && groupMembers.length) {
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
            date: { $gte: rangeFrom, $lte: rangeTo },
            leaveRequestStatus: { $ne: 'rejected' },
            $or: [
                { statusKey: 'on_leave' },
                {
                    requestedStatusKey: 'on_leave',
                    leaveRequestStatus: { $in: ['pending', 'approved'] },
                },
            ],
        })
            .select({ employeeMongoId: 1, date: 1, leaveRequestStatus: 1, statusKey: 1 })
            .lean()
            .maxTimeMS(8000);

        const byPerson = new Map();
        for (const row of rows || []) {
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
    }

    const projected = !hasRange ? taken : applicantAlreadyCounted ? taken : taken + 1;
    const over = maxAllowed != null && hasRange && projected > maxAllowed;
    const message = over
        ? `Only ${maxAllowed} ${maxAllowed === 1 ? 'employee' : 'employees'} (${maxPercent}%) in ${groupLabel} can be on annual leave on these days. ${taken} already requested or approved.`
        : '';

    return {
        enabled: true,
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
    };
}
