import mongoose from 'mongoose';
import Attendance from '../../models/Attendance.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import Holiday from '../../models/Holiday.js';
import {
    isCompanyShellEmployee,
    REAL_EMPLOYEE_MONGO_FILTER,
} from '../../utils/attendanceEmployeeFilters.js';
import { preferPunchedRows } from '../../utils/attendanceDayLookup.js';
import { applyLeaveCoverIndex, loadLeaveCoverIndex } from '../../utils/attendanceLeaveDayCover.js';
import { calendarDaysForEmployee, calendarStatusKey } from '../../utils/leaveGroupCalendarDays.js';
import { overlaySuspendedAttendance } from '../../utils/attendanceSuspension.js';
import { storedPunchGapPatch } from '../../utils/partialLeaveWindow.js';
import EmployeeSalary from '../../models/EmployeeSalary.js';
import AttendanceChangeRequest from '../../models/AttendanceChangeRequest.js';
import { ATTENDANCE_CHANGE_OPEN_STAGES } from '../../utils/attendanceChangeApproval.js';
import { collectPendingCalendarRequests } from '../../utils/groupCalendarRequests.js';
import { resolveFlowchartHrEmployee } from '../../utils/resolveFlowchartHrEmployee.js';
import { loadEnrolledLeaveVisibilityByMongoId } from '../../utils/leaveSalaryVisibility.js';
import { getScheduledEmailTimeZone, getZonedParts } from '../../utils/scheduleDailyAtMidnight.js';
import {
    getOffWeekdayKeys,
    getWeekForStaffType,
    holidayAppliesToStaff,
    loadWorkingTimeDoc,
    normalizeStaffType,
} from '../../utils/workingTimeHelpers.js';

function pad2(value) {
    return String(value).padStart(2, '0');
}

function dubaiTodayKey() {
    const parts = getZonedParts(new Date(), getScheduledEmailTimeZone());
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function dateKeyOf(value) {
    if (!value) return '';
    const raw = value instanceof Date ? '' : String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    const parsed = value instanceof Date ? value : new Date(raw);
    if (Number.isNaN(parsed.getTime())) return '';
    const parts = getZonedParts(parsed, getScheduledEmailTimeZone());
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function employeeName(emp) {
    return [emp?.firstName, emp?.lastName].filter(Boolean).join(' ').trim();
}

function laterDate(left, right) {
    const dates = [left, right].filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')));
    dates.sort();
    return dates[dates.length - 1] || '';
}

function slimGroupAttendanceRecord(row, todayKey) {
    if (!row) return null;
    return {
        date: row.date,
        statusKey: calendarStatusKey(row, todayKey) || row.statusKey || '',
        statusLabel: row.statusLabel || '',
        timeIn: row.timeIn || '',
        timeOut: row.timeOut || '',
        timeOutDate: row.timeOutDate || '',
        checkInLocation: row.checkInLocation || null,
        checkOutLocation: row.checkOutLocation || null,
        reason: row.reason || '',
        leaveRequestReason: row.leaveRequestReason || '',
        hourAdjustReason: row.hourAdjustReason || '',
        flexibleOtReason: row.flexibleOtReason || '',
        hourAdjustStatus: row.hourAdjustStatus || '',
        hourAdjustKind: row.hourAdjustKind || '',
        deductionWaived: row.deductionWaived === true,
        leaveRequestSession: row.leaveRequestSession || '',
        attendanceSuspended: row.attendanceSuspended === true || row.statusKey === 'suspended',
        leaveRequestStatus: row.leaveRequestStatus || '',
        flexibleOtStatus: row.flexibleOtStatus || '',
        flexibleOtApprovedHours: row.flexibleOtApprovedHours || 0,
        approvalStatus: row.approvalStatus || '',
        hoursApproved: row.hoursApproved,
        hoursTaken: row.hoursTaken,
        flexibleWorkedHours: row.flexibleWorkedHours,
        flexibleRequiredHours: row.flexibleRequiredHours,
        flexibleFromOtDate: row.flexibleFromOtDate || '',
        flexibleOtNextDayDate: row.flexibleOtNextDayDate || '',
        compOff: row.compOff || null,
        leavePayType: row.leavePayType || '',
    };
}

/** Same day status the employee calendar shows: punch gaps, then suspension grey. */
function displayRowsForEmployee(rows, employee, from, to) {
    const patched = (rows || []).map((row) => {
        const patch = storedPunchGapPatch(row);
        return patch ? { ...row, ...patch } : row;
    });
    return overlaySuspendedAttendance(patched, employee, from, to);
}

function monthWindow(month) {
    if (!/^\d{4}-\d{2}$/.test(month)) return null;
    const year = Number(month.slice(0, 4));
    const monthNum = Number(month.slice(5, 7));
    if (!Number.isFinite(year) || monthNum < 1 || monthNum > 12) return null;
    const from = `${month}-01`;
    const lastDay = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
    return { month, from, to: `${month}-${pad2(lastDay)}` };
}

/**
 * GET /api/Leave/group-calendars?month=yyyy-MM&staffType=office
 * Current-month attendance colors for every enrolled employee in one group.
 */
export async function getLeaveGroupCalendars(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const staffTypeRaw = String(req.query.staffType || '').trim();
        const detail = String(req.query.detail || '') === '1';
        if (!staffTypeRaw) {
            return res.status(400).json({ message: 'A group is required.' });
        }
        const staffType = normalizeStaffType(staffTypeRaw);
        const today = dubaiTodayKey();
        const requestedMonth = String(req.query.month || '').trim() || today.slice(0, 7);
        const window = monthWindow(requestedMonth);
        if (!window) {
            return res.status(400).json({ message: 'Valid month (yyyy-MM) is required.' });
        }

        const rows = await EmployeeBasic.find({
            profileStatus: 'active',
            status: { $ne: 'Left User' },
            employeeId: { $ne: 'VEGA-HR-0000' },
            ...REAL_EMPLOYEE_MONGO_FILTER,
        })
            .select('_id employeeId firstName lastName staffType dateOfJoining primaryReportee attendanceAccountStatus attendanceSuspension')
            .lean()
            .maxTimeMS(12000);

        const activeEmployees = (rows || []).filter((emp) => !isCompanyShellEmployee(emp));
        const visibility = await loadEnrolledLeaveVisibilityByMongoId(activeEmployees);
        const people = activeEmployees.filter((emp) => {
            if (!visibility.has(String(emp._id))) return false;
            return normalizeStaffType(emp.staffType) === staffType;
        });

        const mongoIds = people.map((emp) => String(emp._id));
        const mongoIdSet = new Set(mongoIds);
        const codes = people.map((emp) => String(emp.employeeId || '').trim()).filter(Boolean);
        const mongoByCode = new Map(people.map((emp) => [String(emp.employeeId || '').trim(), String(emp._id)]));
        const reporteeIds = [...new Set(
            people.map((emp) => String(emp.primaryReportee || '').trim()).filter(Boolean),
        )];

        const [storedRecords, coverIndex, workingTime, holidayRows, salaryRows, changeRows, reporteePeople, hrResolved] = await Promise.all([
            mongoIds.length
                ? Attendance.find({
                      date: { $gte: window.from, $lte: window.to },
                      $or: [
                          { employeeMongoId: { $in: mongoIds } },
                          ...(codes.length ? [{ employeeId: { $in: codes } }] : []),
                      ],
                  })
                      .select(detail
                          ? 'employeeMongoId employeeId employeeName date statusKey statusLabel timeIn timeOut timeOutDate checkInLocation checkOutLocation reason leaveRequestReason hourAdjustReason flexibleOtReason hourAdjustStatus hourAdjustKind deductionWaived leaveRequestSession leaveRequestStatus leaveApprovalStage leaveRequestKind requestedStatusKey requestedStatusLabel flexibleOtStatus flexibleOtApprovedHours approvalStatus hoursApproved hoursTaken flexibleWorkedHours flexibleRequiredHours flexibleFromOtDate flexibleOtNextDayDate compOff leavePayType updatedAt historical'
                          : 'employeeMongoId employeeId date statusKey timeIn timeOut updatedAt historical')
                      .lean()
                      .maxTimeMS(12000)
                : [],
            loadLeaveCoverIndex({ from: window.from, to: window.to, employees: people }),
            loadWorkingTimeDoc(),
            Holiday.find({ date: { $gte: window.from, $lte: window.to } })
                .select('date name appliesTo')
                .lean()
                .maxTimeMS(8000),
            detail && codes.length
                ? EmployeeSalary.find({ employeeId: { $in: codes } })
                    .select('employeeId monthlySalary totalSalary')
                    .lean()
                    .maxTimeMS(8000)
                : [],
            detail && mongoIds.length
                ? AttendanceChangeRequest.find({
                      employeeMongoId: { $in: mongoIds },
                      stage: { $in: ATTENDANCE_CHANGE_OPEN_STAGES },
                      date: { $gte: window.from, $lte: window.to },
                  })
                    .select('employeeMongoId employeeName date action stage requestedByName reporteeId reporteeName hrId hrName proposed.statusLabel proposed.statusKey')
                    .lean()
                    .maxTimeMS(8000)
                : [],
            detail && reporteeIds.length
                ? EmployeeBasic.find({ _id: { $in: reporteeIds } })
                    .select('firstName lastName')
                    .lean()
                    .maxTimeMS(8000)
                : [],
            detail ? resolveFlowchartHrEmployee().catch(() => null) : null,
        ]);
        const salaryByCode = new Map(
            (salaryRows || []).map((row) => [
                String(row.employeeId || '').trim(),
                Number(row.monthlySalary) || Number(row.totalSalary) || 0,
            ]),
        );

        const owned = [];
        for (const row of storedRecords || []) {
            const id = visibility.has(String(row.employeeMongoId || ''))
                ? String(row.employeeMongoId)
                : mongoByCode.get(String(row.employeeId || '').trim()) || '';
            if (!id || !mongoIdSet.has(id)) continue;
            owned.push({ ...row, employeeMongoId: id });
        }

        const byEmployee = new Map();
        for (const row of owned) {
            const id = String(row.employeeMongoId);
            if (!byEmployee.has(id)) byEmployee.set(id, []);
            byEmployee.get(id).push(row);
        }
        const preferred = [];
        for (const list of byEmployee.values()) preferred.push(...preferPunchedRows(list));
        const covered = applyLeaveCoverIndex(preferred, coverIndex);

        const hrEmployee = hrResolved?.employee || null;
        const hrId = hrEmployee?._id ? String(hrEmployee._id) : '';
        const hrName = employeeName(hrEmployee);
        const nameById = new Map(
            (reporteePeople || []).map((person) => [String(person._id), employeeName(person)]),
        );
        if (hrId && hrName) nameById.set(hrId, hrName);
        const missingApproverIds = new Set();
        for (const row of changeRows || []) {
            const reporteeId = String(row?.reporteeId || '').trim();
            const rowHrId = String(row?.hrId || '').trim();
            if (!String(row?.reporteeName || '').trim() && reporteeId && !nameById.has(reporteeId)) {
                missingApproverIds.add(reporteeId);
            }
            if (!String(row?.hrName || '').trim() && rowHrId && !nameById.has(rowHrId)) {
                missingApproverIds.add(rowHrId);
            }
        }
        if (missingApproverIds.size) {
            const extraPeople = await EmployeeBasic.find({ _id: { $in: [...missingApproverIds] } })
                .select('firstName lastName')
                .lean()
                .maxTimeMS(8000);
            for (const person of extraPeople || []) nameById.set(String(person._id), employeeName(person));
        }
        for (const row of changeRows || []) {
            if (!String(row?.reporteeName || '').trim() && row?.reporteeId) {
                row.reporteeName = nameById.get(String(row.reporteeId)) || '';
            }
            if (!String(row?.hrName || '').trim() && row?.hrId) {
                row.hrName = nameById.get(String(row.hrId)) || '';
            }
        }
        const approversByEmployee = new Map(people.map((emp) => {
            const reporteeId = String(emp.primaryReportee || '').trim();
            return [String(emp._id), {
                reporteeId,
                reporteeName: nameById.get(reporteeId) || '',
                hrId,
                hrName,
            }];
        }));

        const pendingByEmployee = detail
            ? collectPendingCalendarRequests({
                attendanceRows: preferred,
                changeRows,
                employeeNames: new Map(people.map((emp) => [String(emp._id), employeeName(emp)])),
                approversByEmployee,
                from: window.from,
                to: window.to,
            })
            : new Map();

        const coveredByEmployee = new Map();
        for (const row of covered) {
            const id = String(row?.employeeMongoId || '');
            if (!mongoIdSet.has(id)) continue;
            if (!coveredByEmployee.has(id)) coveredByEmployee.set(id, []);
            coveredByEmployee.get(id).push(row);
        }

        const employees = people
            .map((emp) => {
                const id = String(emp._id);
                const visibleFrom = laterDate(dateKeyOf(emp.dateOfJoining), visibility.get(id));
                const rows = displayRowsForEmployee(
                    coveredByEmployee.get(id) || [],
                    emp,
                    window.from,
                    window.to,
                );
                return {
                    id,
                    employeeId: emp.employeeId || '',
                    employeeName: employeeName(emp) || 'Employee',
                    staffType,
                    visibleFrom,
                    ...(detail ? {
                        monthlySalary: salaryByCode.get(String(emp.employeeId || '').trim()) || 0,
                        records: rows.map((row) => slimGroupAttendanceRecord(row, today)),
                        pendingRequests: pendingByEmployee.get(id) || [],
                    } : {}),
                    days: calendarDaysForEmployee(rows, {
                        todayKey: today,
                        visibleFrom,
                    }),
                };
            })
            .sort((a, b) => a.employeeName.localeCompare(b.employeeName));

        const holidays = (holidayRows || [])
            .filter((row) => row?.date && holidayAppliesToStaff(row, staffType))
            .map((row) => ({ date: String(row.date), name: row.name || 'Holiday' }));

        return res.status(200).json({
            message: 'Group calendars fetched successfully',
            month: window.month,
            from: window.from,
            to: window.to,
            today,
            staffType,
            offWeekdays: getOffWeekdayKeys(getWeekForStaffType(workingTime, staffType)),
            ...(detail ? {
                scheduleWeek: getWeekForStaffType(workingTime, staffType),
                workingTime: {
                    site: workingTime?.site || {},
                    office: workingTime?.office || {},
                    extra: workingTime?.extra || {},
                },
            } : {}),
            holidays,
            employees,
        });
    } catch (error) {
        console.error('[getLeaveGroupCalendars]', error);
        return res.status(500).json({ message: error.message || 'Failed to load group calendars.' });
    }
}
