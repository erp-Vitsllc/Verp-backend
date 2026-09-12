import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import PayrollSettings from '../models/PayrollSettings.js';
import {
    isCompanyShellEmployee,
    REAL_EMPLOYEE_MONGO_FILTER,
} from './attendanceEmployeeFilters.js';
import { loadEnrolledLeaveVisibilityByMongoId } from './leaveSalaryVisibility.js';
import { floorGroupLeaveSlots, readGroupLeavePercent } from './groupLeaveSlots.js';
import {
    listActiveWorkLocations,
    normalizeStaffTypeKey,
    staffTypeMongoClause,
} from './workLocationHelpers.js';

export { floorGroupLeaveSlots, readGroupLeavePercent } from './groupLeaveSlots.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isDateKey(value) {
    return ISO_DATE.test(String(value || '').trim());
}

function emptyGroupCap(extra = {}) {
    return {
        enabled: false,
        over: false,
        groupKey: '',
        groupLabel: '',
        employeeCount: 0,
        minPercent: null,
        maxPercent: null,
        minAllowed: 0,
        maxAllowed: 0,
        taken: 0,
        ...extra,
    };
}

function isAnnualLeaveOccupyingDay(row) {
    const status = String(row?.leaveRequestStatus || '').trim().toLowerCase();
    const requested = String(row?.requestedStatusKey || '').trim();
    if (status === 'rejected') return false;
    if (String(row?.statusKey || '').trim() === 'on_leave') return true;
    if (requested !== 'on_leave') return false;
    return status === 'pending' || status === 'approved';
}

async function loadGroupLeavePercents(staffType) {
    const key = normalizeStaffTypeKey(staffType);
    const [group, main] = await Promise.all([
        key
            ? PayrollSettings.findOne({ key: `group:${key}` })
                  .select('minAllowedLeavePerGroupPercent maxAllowedLeavePerGroupPercent')
                  .lean()
            : null,
        PayrollSettings.findOne({ key: 'default' })
            .select('minAllowedLeavePerGroupPercent maxAllowedLeavePerGroupPercent')
            .lean(),
    ]);
    const pick = (field) => {
        const fromGroup = readGroupLeavePercent(group?.[field]);
        if (fromGroup != null) return fromGroup;
        return readGroupLeavePercent(main?.[field]);
    };
    return {
        minPercent: pick('minAllowedLeavePerGroupPercent'),
        maxPercent: pick('maxAllowedLeavePerGroupPercent'),
    };
}

async function loadEnrolledGroupEmployees(staffType) {
    const key = normalizeStaffTypeKey(staffType);
    const rows = await EmployeeBasic.find({
        profileStatus: 'active',
        status: { $ne: 'Left User' },
        employeeId: { $ne: 'VEGA-HR-0000' },
        ...REAL_EMPLOYEE_MONGO_FILTER,
        ...staffTypeMongoClause(key),
    })
        .select('_id employeeId firstName lastName staffType')
        .lean()
        .maxTimeMS(12000);

    const people = (rows || []).filter((row) => !isCompanyShellEmployee(row));
    const visibility = await loadEnrolledLeaveVisibilityByMongoId(people);
    return people.filter((row) => visibility.has(String(row._id)));
}

/**
 * Max unique other group members already on requested or approved annual leave
 * on any day in [from, to]. The applicant is never counted.
 */
export async function loadGroupAnnualLeaveCap({
    employee,
    from = '',
    to = '',
} = {}) {
    const groupKey = normalizeStaffTypeKey(employee?.staffType);
    if (!employee?._id || !groupKey) return emptyGroupCap();

    const [{ minPercent, maxPercent }, members, locations] = await Promise.all([
        loadGroupLeavePercents(groupKey),
        loadEnrolledGroupEmployees(groupKey),
        listActiveWorkLocations(),
    ]);

    const groupLabel =
        (locations || []).find((row) => row.key === groupKey)?.label || groupKey;
    const employeeCount = members.length;
    const enabled = minPercent != null || maxPercent != null;
    const minAllowed = minPercent == null ? 0 : floorGroupLeaveSlots(employeeCount, minPercent);
    const maxAllowed = maxPercent == null ? 0 : floorGroupLeaveSlots(employeeCount, maxPercent);
    const start = isDateKey(from) ? from : '';
    const end = isDateKey(to) && start && to >= from ? to : start;
    const applicantId = String(employee._id);
    const memberIds = members.map((row) => String(row._id)).filter((id) => id && id !== applicantId);

    let taken = 0;
    if (start && end && memberIds.length) {
        const rows = await Attendance.find({
            date: { $gte: start, $lte: end },
            employeeMongoId: { $in: memberIds },
            $or: [
                { statusKey: 'on_leave' },
                { leaveRequestStatus: 'pending', requestedStatusKey: 'on_leave' },
                { leaveRequestStatus: 'approved', requestedStatusKey: 'on_leave' },
            ],
        })
            .select('date employeeMongoId statusKey requestedStatusKey leaveRequestStatus')
            .lean()
            .maxTimeMS(8000);

        const byDate = new Map();
        for (const row of rows || []) {
            if (!isAnnualLeaveOccupyingDay(row)) continue;
            const dateKey = String(row.date || '').trim();
            const empId = String(row.employeeMongoId || '').trim();
            if (!dateKey || !empId || empId === applicantId) continue;
            if (!byDate.has(dateKey)) byDate.set(dateKey, new Set());
            byDate.get(dateKey).add(empId);
        }
        for (const ids of byDate.values()) {
            if (ids.size > taken) taken = ids.size;
        }
    }

    const over = maxPercent != null && taken >= maxAllowed;

    return {
        enabled,
        over,
        groupKey,
        groupLabel,
        employeeCount,
        minPercent,
        maxPercent,
        minAllowed,
        maxAllowed,
        taken,
    };
}
