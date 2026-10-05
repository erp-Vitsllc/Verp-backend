import mongoose from 'mongoose';
import Attendance, { ATTENDANCE_STATUS_KEYS } from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Holiday from '../models/Holiday.js';
import SalaryEnrollment from '../models/SalaryEnrollment.js';
import SalaryHistoricalProfile from '../models/SalaryHistoricalProfile.js';
import { getScheduledEmailTimeZone, getZonedParts } from '../utils/scheduleDailyAtMidnight.js';
import {
    getOffWeekdayKeys,
    getScheduledPunchMinutes,
    clockTimeToMinutes,
    isWeekOffForStaff,
    holidayAppliesToStaff,
    loadWorkingTimeDoc,
    normalizeStaffType,
    getWeekForStaffType,
    resolveStatusFromPunches,
    isFlexibleTiming,
    weekdayKeyFromDateKey,
} from '../utils/workingTimeHelpers.js';
import { addDaysKey, evaluateFlexibleDay, flexibleOtFieldsFromDuration, requiredHoursForDate, workedMinutesAcross } from '../utils/flexibleAttendance.js';
import { flexibleOtManualUpdate, refreshFlexibleOtRecords } from '../utils/syncFlexibleOt.js';
import {
    nonWorkingAttendanceMark,
    repairBlankNonWorkingRows,
    restoreClearedAttendance,
} from '../utils/attendanceNonWorkingDay.js';
import { nonHrMarkableDateKeys } from '../utils/nonHrMarkWindow.js';
import { describePartialLeave, partialLeaveOutcome, partialLeavePortion } from '../utils/partialLeaveWindow.js';
import { staffTypeMongoClause } from '../utils/workLocationHelpers.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';
import { syncDashboardAction } from '../utils/syncDashboard.js';
import {
    sendAttendanceLeaveRequestEmail,
    sendAttendanceLeaveDecisionEmail,
} from '../utils/sendAttendanceLeaveEmails.js';
import {
    isCompanyShellEmployee,
    REAL_EMPLOYEE_MONGO_FILTER,
} from '../utils/attendanceEmployeeFilters.js';
import {
    bestDayRecord,
    employeeAttendanceMatch,
    preferPunchedRows,
    punchTimeSet,
} from '../utils/attendanceDayLookup.js';
import { listPendingHubInboxItems } from '../utils/employeeHubRequestInbox.js';
import { resolveFlowchartHrEmployee } from '../utils/resolveFlowchartHrEmployee.js';
import { isUserActiveInFlowchart } from '../utils/getDepartmentHOD.js';
import { resolveDashboardAssigneeContext } from '../utils/resolveDashboardAssigneeContext.js';
import { isReqUserSystemSuperUser } from '../utils/systemSuperUser.js';
import {
    isLeaveDashboardAttendanceRow,
    LEAVE_DASHBOARD_REQUEST_TYPE,
    leaveDashboardRequestObjectId,
    notifyPrimaryReporteeOfLeaveRequest,
} from '../utils/notifyLeaveDashboardRequest.js';
import {
    parsePunchLocation,
    resolvePunchSource,
} from '../utils/attendancePunchMeta.js';
import { employeeHasMobileReviewBypass } from '../utils/userMobileDevice.js';
import {
    loadPunchContactFlags,
    rejectIfMissingPunchContact,
} from '../utils/attendanceContactGate.js';
import {
    daysUntilProcessingStart,
    firstOfProcessingMonth,
    isSalaryMonthOpen,
    loadEnrolledLeaveVisibilityByMongoId,
    processingMonthFromStart,
    processingStartFromEnrollment,
    resolveSalaryProcessingStartDate,
    salaryOpensFromMessage,
} from '../utils/leaveSalaryVisibility.js';
import {
    checkEmployeeLeaveAllowance,
    leavePolicyEntitlements,
    loadEmployeeLeaveBalances,
    resolveEmployeePayrollPolicy,
    resolveSickOverflowStatuses,
} from '../utils/employeeLeavePolicy.js';
import {
    applyOverlayCounts,
    applyOverlayCountsToBalances,
    lastOverlayAnnualLeaveDate,
    loadHistoricalLeaveProfile,
    overlayHistoricalLeave,
} from '../utils/historicalLeaveAttendanceOverlay.js';
import {
    applyLeaveCoverIndex,
    enrollmentCoverIndexForEmployee,
    loadLeaveCoverIndex,
} from '../utils/attendanceLeaveDayCover.js';
import { loadCurrentLeaveCycleEligibility, loadEmployeeSalaryWorkingDays } from '../utils/loadLeaveTicketEntitlement.js';

const LEAVE_REQUEST_STATUS_KEYS = new Set([
    'unauthorized_leave',
    'authorized_leave',
    'sick_leave',
    'compoff_leave',
    'on_leave',
]);

/** Employee red-day request: authorized, sick, other leave, or late arrival. */
const EMPLOYEE_LEAVE_REQUEST_KEYS = new Set(['sick_leave', 'on_leave', 'authorized_leave', 'late_arrived']);

/** Reportee sets the final day status on approve. */
const REPORTEE_APPROVE_LEAVE_KEYS = new Set([
    'unauthorized_leave',
    'authorized_leave',
    'sick_leave',
    'compoff_leave',
]);

const YELLOW_REQUEST_STATUS_KEYS = new Set(['late_arrived', 'early_go', 'mispunch']);

const RED_LEAVE_STATUS_KEYS = new Set(['unauthorized_leave', 'on_leave']);

const LEAVE_STATUS_LABELS = {
    unauthorized_leave: 'Unauthorized Leave',
    authorized_leave: 'Authorized Leave',
    sick_leave: 'Sick Leave',
    compoff_leave: 'Comp Off Leave',
    on_leave: 'On Leave',
    on_office: 'Present',
    work_from_home: 'Work from home',
    late_arrived: 'Late Arrival',
    early_go: 'Early Go',
    mispunch: 'Mispunched',
};

const LEAVE_PAY_TYPES = new Set(['paid', 'unpaid']);

function normalizeLeavePayType(value) {
    const pay = String(value || '').trim().toLowerCase();
    return LEAVE_PAY_TYPES.has(pay) ? pay : '';
}

function authorizedLeaveLabel() {
    return 'Authorized Leave';
}

function leavePayTypeForStatus(statusKey) {
    return String(statusKey || '').trim() === 'authorized_leave' ? 'unpaid' : '';
}

function presentAuthorizedLeaveRecord(record) {
    if (!record || String(record.statusKey || '').trim() !== 'authorized_leave') return record;
    const raw = String(record.statusLabel || '');
    const halfAt = raw.indexOf('·');
    return {
        ...record,
        leavePayType: 'unpaid',
        statusLabel: halfAt >= 0 ? `Authorized Leave ${raw.slice(halfAt).trim()}` : 'Authorized Leave',
    };
}

function leaveStatusLabel(statusKey, fallback = '', payType = '') {
    const key = String(statusKey || '').trim();
    if (key === 'authorized_leave') return authorizedLeaveLabel(payType);
    return LEAVE_STATUS_LABELS[key] || fallback || key || '—';
}

function isMispunchReasonText(reason) {
    return String(reason || '')
        .toLowerCase()
        .includes('mispunch');
}

/** Yellow calendar days eligible for clarification → Present. */
function isYellowClarificationEligible(record) {
    if (!record) return false;
    const key = String(record.statusKey || '').trim();
    if (YELLOW_REQUEST_STATUS_KEYS.has(key)) return true;
    if (key === 'unauthorized_leave' && isMispunchReasonText(record.reason)) return true;
    if (record.timeIn && !record.timeOut && (key === 'on_office' || key === 'late_arrived' || key === 'work_from_home')) {
        return true;
    }
    return false;
}

function isValidDateKey(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function formatDateKeyFromParts({ year, month, day }) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getDubaiNowParts() {
    return getZonedParts(new Date(), getScheduledEmailTimeZone());
}

function getDubaiDateKey(date = new Date()) {
    const p = getZonedParts(date, getScheduledEmailTimeZone());
    return formatDateKeyFromParts(p);
}

function inclusiveDateCount(fromDate, toDate) {
    if (!isValidDateKey(fromDate) || !isValidDateKey(toDate) || toDate < fromDate) return 0;
    const [fromYear, fromMonth, fromDay] = fromDate.split('-').map(Number);
    const [toYear, toMonth, toDay] = toDate.split('-').map(Number);
    return (
        Math.round(
            (Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86400000,
        ) + 1
    );
}

function nextDateKey(dateKey) {
    return shiftDateKey(dateKey, 1);
}

function shiftDateKey(dateKey, deltaDays) {
    const [year, month, day] = String(dateKey).split('-').map(Number);
    const dt = new Date(Date.UTC(year, month - 1, day + deltaDays, 12, 0, 0));
    return formatDateKeyFromParts({
        year: dt.getUTCFullYear(),
        month: dt.getUTCMonth() + 1,
        day: dt.getUTCDate(),
    });
}

async function viewerIsFlowchartHr(req) {
    try {
        const actor = await resolveLinkedEmployee(req);
        return await isUserActiveInFlowchart(
            {
                employeeObjectId: actor?._id || req.user?.employeeObjectId || null,
                employeeId: actor?.employeeId || req.user?.employeeId || '',
            },
            'hr',
        );
    } catch (error) {
        console.error('[viewerIsFlowchartHr]', error);
        return false;
    }
}

const NON_HR_MARK_WINDOW_MESSAGE =
    'Only the flowchart HR assignee can mark attendance outside today and the two previous days. Holidays are skipped.';

/**
 * Flowchart HR may mark any status on any past or future day.
 * Other users may mark any status today and on the two previous days.
 * Holiday dates are skipped and do not count, so the window reaches further back.
 * @returns {Promise<boolean>} true when the response was already sent
 */
async function rejectIfMarkWindowClosed(req, res, { date, entries }) {
    const today = getDubaiDateKey();
    if (await viewerIsFlowchartHr(req)) return false;

    const requested = Array.isArray(entries) ? entries : [];
    const triesClear = requested.some((entry) => {
        const statusKey = String(entry?.statusKey || '').trim();
        return statusKey === 'clear_attendance' || statusKey === 'clear';
    });
    if (triesClear) {
        res.status(403).json({
            message: 'Only the flowchart HR assignee can clear attendance.',
        });
        return true;
    }

    if (!isValidDateKey(date) || date > today) {
        res.status(403).json({ message: NON_HR_MARK_WINDOW_MESSAGE });
        return true;
    }

    const ids = [
        ...new Set(
            requested.map((entry) => String(entry?.employeeMongoId || '').trim()).filter(Boolean),
        ),
    ];
    const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
    const employees = validIds.length
        ? await EmployeeBasic.find({ _id: { $in: validIds } }).select('_id staffType').lean()
        : [];
    const staffById = new Map(
        (employees || []).map((row) => [String(row._id), normalizeStaffType(row.staffType)]),
    );
    const staffTypes = ids.length
        ? [...new Set(ids.map((id) => staffById.get(id) || 'office'))]
        : ['office'];

    const holidayRows = await Holiday.find({
        date: { $gte: shiftDateKey(today, -60), $lte: today },
    })
        .select('date appliesTo')
        .lean();

    const allowedByStaff = new Map();
    for (const staffType of staffTypes) {
        const holidayDates = (holidayRows || [])
            .filter((row) => holidayAppliesToStaff(row, staffType))
            .map((row) => String(row.date || '').trim())
            .filter(Boolean);
        allowedByStaff.set(staffType, nonHrMarkableDateKeys(today, holidayDates));
    }

    const dateAllowed = ids.length
        ? ids.every((id) => allowedByStaff.get(staffById.get(id) || 'office')?.has(date))
        : [...allowedByStaff.values()].every((set) => set.has(date));
    if (!dateAllowed) {
        res.status(403).json({ message: NON_HR_MARK_WINDOW_MESSAGE });
        return true;
    }

    return false;
}

function isNonWorkingDate(dateKey, holidaySet, offWeekdays) {
    if (holidaySet?.has(dateKey)) return true;
    const weekday = weekdayKeyFromDateKey(dateKey);
    return Boolean(weekday && offWeekdays?.has(weekday));
}

/** Skip tomorrow and all holidays/weekends; first allowed date is the 2nd working day from today. */
function firstEligibleAdvanceRequestDate(todayKey, holidaySet, offWeekdays) {
    let cursor = todayKey;
    let workingSeen = 0;
    for (let i = 0; i < 90; i += 1) {
        cursor = nextDateKey(cursor);
        if (isNonWorkingDate(cursor, holidaySet, offWeekdays)) continue;
        workingSeen += 1;
        if (workingSeen >= 2) return cursor;
    }
    return null;
}

async function loadHolidaySet(fromKey, toKey, staffType = null) {
    const rows = await Holiday.find({
        date: { $gte: fromKey, $lte: toKey },
    })
        .select('date appliesTo')
        .lean();
    return new Set(
        (rows || [])
            .filter((row) => !staffType || holidayAppliesToStaff(row, staffType))
            .map((row) => String(row.date || '').trim())
            .filter(Boolean),
    );
}

/** Exact local clock time HH:mm:ss in company TZ */
function getDubaiClockTime(date = new Date()) {
    const p = getZonedParts(date, getScheduledEmailTimeZone());
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`;
}

const SALARY_ENROLL_REQUIRED =
    'Enroll to salary first. Attendance, check-in/out, and leave unlock after Enroll Status is Enrolled.';

function salaryLockPayload(gate) {
    return {
        message: gate.lockMessage,
        lockMessage: gate.lockMessage,
        salaryEnrolled: gate.enrolled,
        attendanceLocked: true,
        lockKind: gate.enrolled ? 'processing' : 'enroll',
        processingStartMonth: gate.processingStartMonth || '',
        processingStartDate: gate.processingStartDate || '',
        daysRemaining: gate.daysRemaining || 0,
    };
}

async function loadSalaryAttendanceGate(employee, { monthKey, dateKey } = {}) {
    if (await employeeHasMobileReviewBypass(employee)) {
        return {
            enrolled: true,
            liveOpen: true,
            requestedOpen: true,
            attendanceLocked: false,
            lockMessage: '',
            processingStartMonth: '',
            processingStartDate: '',
            daysRemaining: 0,
        };
    }
    const enrollRequired = {
        enrolled: false,
        liveOpen: false,
        requestedOpen: false,
        attendanceLocked: true,
        lockMessage: SALARY_ENROLL_REQUIRED,
        processingStartMonth: '',
        processingStartDate: '',
        daysRemaining: 0,
    };
    const employeeId = String(employee?.employeeId || '').trim();
    if (!employeeId) return enrollRequired;

    const [enrollment, profile] = await Promise.all([
        SalaryEnrollment.findOne({ employeeId }).select('fromMonth salaryDate processDate').lean(),
        SalaryHistoricalProfile.findOne({ employeeId }).select('verpStartDate').lean(),
    ]);
    if (!enrollment) return enrollRequired;

    const rawStart =
        resolveSalaryProcessingStartDate({
            verpStartDate: profile?.verpStartDate,
            enrollment,
        }) || processingStartFromEnrollment(enrollment);
    const processingStartMonth =
        processingMonthFromStart(rawStart) || processingMonthFromStart(enrollment.fromMonth);
    const processingStartDate = firstOfProcessingMonth(processingStartMonth);
    const todayKey = getDubaiDateKey();
    const todayMonth = todayKey.slice(0, 7);
    const requestedMonth =
        processingMonthFromStart(monthKey) || processingMonthFromStart(dateKey) || todayMonth;
    const liveOpen = isSalaryMonthOpen(todayMonth, processingStartMonth);
    const requestedOpen = isSalaryMonthOpen(requestedMonth, processingStartMonth);
    const daysRemaining = liveOpen ? 0 : daysUntilProcessingStart(todayKey, processingStartDate);
    return {
        enrolled: true,
        liveOpen,
        requestedOpen,
        attendanceLocked: !liveOpen,
        lockMessage: !liveOpen ? salaryOpensFromMessage(processingStartDate, todayKey) : '',
        processingStartMonth,
        processingStartDate,
        daysRemaining,
    };
}

async function rejectIfNotSalaryEnrolled(res, employee, opts = {}) {
    const gate = await loadSalaryAttendanceGate(employee, opts);
    if (gate.enrolled && gate.liveOpen && gate.requestedOpen) return false;
    res.status(403).json(salaryLockPayload({ ...gate, attendanceLocked: true }));
    return true;
}

async function resolveLinkedEmployee(req) {
    let employee = null;

    const selectFields = '_id employeeId firstName lastName companyEmail workEmail email staffType';

    if (req.user?.employeeObjectId) {
        try {
            employee = await EmployeeBasic.findById(req.user.employeeObjectId)
                .select(selectFields)
                .lean();
        } catch {
            employee = null;
        }
    }

    if (!employee && req.user?.employeeId) {
        employee = await EmployeeBasic.findOne({ employeeId: req.user.employeeId })
            .select(selectFields)
            .lean();
    }

    const emailCandidates = [
        req.user?.companyEmail,
        req.user?.email,
    ]
        .map((e) => String(e || '').trim().toLowerCase())
        .filter(Boolean);

    if (!employee && emailCandidates.length) {
        employee = await EmployeeBasic.findOne({
            $or: [
                { companyEmail: { $in: emailCandidates } },
                { workEmail: { $in: emailCandidates } },
                { email: { $in: emailCandidates } },
            ],
        })
            .select(selectFields)
            .lean();

        // Case-insensitive fallback
        if (!employee) {
            const escaped = emailCandidates.map((e) =>
                e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            );
            employee = await EmployeeBasic.findOne({
                $or: escaped.flatMap((e) => [
                    { companyEmail: { $regex: `^${e}$`, $options: 'i' } },
                    { workEmail: { $regex: `^${e}$`, $options: 'i' } },
                    { email: { $regex: `^${e}$`, $options: 'i' } },
                ]),
            })
                .select(selectFields)
                .lean();
        }
    }

    return employee;
}

/** True if targetEmpId is the manager or anywhere under them via primaryReportee. */
async function isEmployeeInTeamTree(managerMongoId, targetMongoId) {
    const managerId = String(managerMongoId);
    const targetId = String(targetMongoId);
    if (managerId === targetId) return true;

    const rows = await EmployeeBasic.aggregate([
        { $match: { _id: new mongoose.Types.ObjectId(String(managerId)) } },
        {
            $graphLookup: {
                from: 'employeebasics',
                startWith: '$_id',
                connectFromField: '_id',
                connectToField: 'primaryReportee',
                as: 'team',
                depthField: 'depth',
            },
        },
        { $project: { teamIds: '$team._id' } },
    ]);

    const teamIds = (rows[0]?.teamIds || []).map((id) => String(id));
    return teamIds.includes(targetId);
}

/** HR Leave / Attendance viewers (and super users) may open any employee's calendar. */
async function canViewHrEmployeeAttendance(req) {
    if (await isReqUserSystemSuperUser(req.user)) return true;
    const userId = req.user?.id;
    if (!userId) return false;
    const { hasPermission } = await import('../services/permissionService.js');
    return (
        (await hasPermission(userId, 'hrm_leave', 'view')) ||
        (await hasPermission(userId, 'hrm_attendance', 'view'))
    );
}

function buildTeamTree(manager, flatList) {
    if (!manager) return [];
    const list = Array.isArray(flatList) ? flatList : [];
    const seenIds = new Set();

    const getChildren = (parentId, visited = new Set()) => {
        const parentKey = String(parentId);
        if (visited.has(parentKey)) return [];
        const nextVisited = new Set(visited);
        nextVisited.add(parentKey);

        return list
            .filter((e) => {
                const id = String(e._id);
                if (seenIds.has(id) || nextVisited.has(id)) return false;
                return String(e.primaryReportee) === parentKey;
            })
            .map((child) => {
                const id = String(child._id);
                seenIds.add(id);
                return {
                    ...child,
                    children: getChildren(child._id, nextVisited),
                };
            });
    };

    return [
        {
            _id: manager._id,
            firstName: manager.firstName,
            lastName: manager.lastName,
            employeeId: manager.employeeId,
            designation: manager.designation,
            department: manager.department,
            profilePicture: manager.profilePicture,
            primaryReportee: null,
            children: getChildren(manager._id),
        },
    ];
}

/** Empty day bucket used by calendar summary aggregation. */
function emptyDayStats(totalStaff = 0) {
    return {
        activeEmployees: totalStaff,
        present: 0,
        onLeave: 0,
        lateArrived: 0,
        sickLeave: 0,
        workFromHome: 0,
        // No marks yet — calendar shows total staff only until attendance is recorded.
        notMarked: 0,
        holiday: 0,
        weeklyOff: 0,
        isWeeklyOff: false,
        officePresent: 0,
        officeTotal: totalStaff,
        sitePresent: 0,
        siteTotal: 0,
        totalPresent: 0,
        absentAuthorized: 0,
        absentUnauthorized: 0,
    };
}

/**
 * Aggregate attendance marks for one calendar day.
 * unauthorized_leave counts with not_marked (same bucket).
 */
function buildDayStatsFromRecords(records, totalStaff = 0, { isWeeklyOffDay = false } = {}) {
    const rows = Array.isArray(records) ? records : [];
    const counts = {
        on_office: 0,
        on_leave: 0,
        sick_leave: 0,
        compoff_leave: 0,
        authorized_leave: 0,
        work_from_home: 0,
        late_arrived: 0,
        not_marked: 0,
        unauthorized_leave: 0,
        holiday: 0,
        weekly_off: 0,
    };

    for (const row of rows) {
        const key = String(row?.statusKey || '').trim();
        if (Object.prototype.hasOwnProperty.call(counts, key)) {
            counts[key] += 1;
        }
    }

    const markedCount = rows.length;
    const offOrHolidayCount = counts.holiday + counts.weekly_off;
    const implicitNotMarked = Math.max(0, totalStaff - markedCount);
    // Weekly off / holiday staff are not "not marked".
    const notMarked = isWeeklyOffDay
        ? counts.not_marked + counts.unauthorized_leave
        : counts.not_marked + counts.unauthorized_leave + Math.max(0, implicitNotMarked - offOrHolidayCount);
    const authorizedLeaveTotal = counts.on_leave + counts.authorized_leave;
    const weeklyOff = isWeeklyOffDay ? Math.max(offOrHolidayCount, totalStaff) : counts.weekly_off;
    const holiday = counts.holiday;

    return {
        activeEmployees: totalStaff,
        present: counts.on_office,
        onLeave: authorizedLeaveTotal,
        lateArrived: counts.late_arrived,
        sickLeave: counts.sick_leave,
        workFromHome: counts.work_from_home,
        notMarked: isWeeklyOffDay ? 0 : notMarked,
        holiday,
        weeklyOff,
        isWeeklyOff: Boolean(isWeeklyOffDay),
        officePresent: counts.on_office,
        officeTotal: totalStaff,
        sitePresent: 0,
        siteTotal: 0,
        totalPresent: counts.on_office,
        absentAuthorized: authorizedLeaveTotal,
        // Same value as notMarked — unauthorized and not marked are one category.
        absentUnauthorized: isWeeklyOffDay ? 0 : notMarked,
    };
}

function resolveStaffTypeFilter(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (!value || value === 'all') return null;
    if (value === 'staff') return 'site';
    return normalizeStaffType(value);
}

/** Holiday / weekly off do not need HR approval queue. */
function approvalStatusForMark(statusKey) {
    const key = String(statusKey || '').trim();
    if (!key || key === 'holiday' || key === 'weekly_off' || key === 'clear_attendance' || key === 'clear') {
        return '';
    }
    return 'pending';
}

const APPROVED_LEAVE_DAY_KEYS = new Set([
    'on_leave',
    'authorized_leave',
    'sick_leave',
    'compoff_leave',
]);

/** Approved annual, authorized, sick, or comp-off leave owns that day. */
function isApprovedLeaveDay(record) {
    if (!record) return false;
    if (String(record.leaveRequestStatus || '').trim() !== 'approved') return false;
    return APPROVED_LEAVE_DAY_KEYS.has(String(record.statusKey || '').trim());
}

/**
 * GET /api/Attendance/mark-roster
 * Lean active-employee list for Mark Attendance (no heavy Employee list aggregation).
 * Query: staffType=office|site (optional), date=yyyy-MM-dd
 * Only employees enrolled on or before that month are returned.
 */
export async function getAttendanceMarkRoster(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const requestedDate = String(req.query.date || '').trim();
        const dateKey = isValidDateKey(requestedDate) ? requestedDate : getDubaiDateKey();
        const monthKey = dateKey.slice(0, 7);
        const staffType = resolveStaffTypeFilter(req.query.staffType);
        const filter = {
            profileStatus: 'active',
            status: { $ne: 'Left User' },
            employeeId: { $ne: 'VEGA-HR-0000' },
            ...REAL_EMPLOYEE_MONGO_FILTER,
        };

        if (staffType) {
            Object.assign(filter, staffTypeMongoClause(staffType));
        }

        const rows = await EmployeeBasic.find(filter)
            .select('_id employeeId firstName lastName staffType primaryReportee profileStatus status')
            .sort({ firstName: 1, lastName: 1 })
            .lean()
            .maxTimeMS(8000);

        const activeRows = (rows || []).filter((e) => !isCompanyShellEmployee(e));
        const enrolledFrom = await loadEnrolledLeaveVisibilityByMongoId(activeRows);
        const employees = activeRows
            .filter((e) => {
                const start = enrolledFrom.get(String(e._id));
                if (!start) return false;
                return isSalaryMonthOpen(monthKey, start);
            })
            .map((e) => ({
                _id: String(e._id),
                id: String(e._id),
                employeeId: e.employeeId || '',
                firstName: e.firstName || '',
                lastName: e.lastName || '',
                name: [e.firstName, e.lastName].filter(Boolean).join(' ').trim(),
                staffType: normalizeStaffType(e.staffType),
                primaryReportee: e.primaryReportee ? String(e.primaryReportee) : '',
                profileStatus: e.profileStatus || 'active',
                status: e.status || '',
            }));

        return res.status(200).json({
            message: 'Attendance mark roster fetched successfully',
            count: employees.length,
            date: dateKey,
            staffType: staffType || 'all',
            employees,
        });
    } catch (error) {
        console.error('[getAttendanceMarkRoster]', error);
        return res.status(500).json({
            message: error.message || 'Failed to load attendance roster.',
        });
    }
}

/** GET /api/Attendance?date=yyyy-MM-dd */
export async function getAttendanceByDate(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const date = String(req.query.date || '').trim();
        if (!isValidDateKey(date)) {
            return res.status(400).json({ message: 'Valid date (yyyy-MM-dd) is required.' });
        }

        const [storedRecords, coverIndex] = await Promise.all([
            Attendance.find({
                date,
                employeeName: { $not: /\(company\)\s*$/i },
            })
                .sort({ employeeName: 1 })
                .lean(),
            loadLeaveCoverIndex({ from: date, to: date }),
        ]);
        try {
            await repairBlankNonWorkingRows(storedRecords);
            await refreshFlexibleOtRecords(storedRecords);
        } catch (otErr) {
            console.error('[getAttendanceByDate] flexible OT refresh failed:', otErr);
        }
        const records = applyLeaveCoverIndex(storedRecords, coverIndex).filter(
            (row) => String(row?.date || '') === date,
        );
        return res.status(200).json({
            message: 'Attendance fetched successfully',
            date,
            records: (records || [])
                .filter((r) => !isCompanyShellEmployee(r.employeeName))
                .map(presentAuthorizedLeaveRecord),
        });
    } catch (error) {
        console.error('[getAttendanceByDate]', error);
        return res.status(500).json({ message: error.message || 'Failed to fetch attendance.' });
    }
}

/**
 * GET /api/Attendance/calendar?month=yyyy-MM
 * Optional: from=yyyy-MM-dd&to=yyyy-MM-dd (overrides month bounds when both valid).
 * Optional: staffType=office|site — day counts are that group only.
 * totalStaffAll is every group combined. totalStaff is the selected group.
 */
export async function getAttendanceCalendarSummary(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const month = String(req.query.month || '').trim();
        const fromQuery = String(req.query.from || '').trim();
        const toQuery = String(req.query.to || '').trim();
        const staffType = resolveStaffTypeFilter(req.query.staffType);

        let from;
        let to;
        let monthKey;

        if (isValidDateKey(fromQuery) && isValidDateKey(toQuery) && fromQuery <= toQuery) {
            from = fromQuery;
            to = toQuery;
            monthKey = from.slice(0, 7);
        } else {
            let year;
            let monthNum;
            if (/^\d{4}-\d{2}$/.test(month)) {
                year = Number(month.slice(0, 4));
                monthNum = Number(month.slice(5, 7));
            } else {
                const p = getDubaiNowParts();
                year = p.year;
                monthNum = p.month;
            }

            if (!Number.isFinite(year) || !Number.isFinite(monthNum) || monthNum < 1 || monthNum > 12) {
                return res.status(400).json({ message: 'Valid month (yyyy-MM) is required.' });
            }

            from = `${year}-${String(monthNum).padStart(2, '0')}-01`;
            const lastDay = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
            to = `${year}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
            monthKey = `${year}-${String(monthNum).padStart(2, '0')}`;
        }

        const [employeeRows, storedRecords, workingTime] = await Promise.all([
            EmployeeBasic.find({
                profileStatus: 'active',
                ...REAL_EMPLOYEE_MONGO_FILTER,
            })
                .select('_id employeeId staffType firstName lastName')
                .lean(),
            Attendance.find({ date: { $gte: from, $lte: to } }).lean(),
            loadWorkingTimeDoc(),
        ]);
        const coverIndex = await loadLeaveCoverIndex({
            from,
            to,
            employees: (employeeRows || []).filter((emp) => !isCompanyShellEmployee(emp)),
        });
        const records = applyLeaveCoverIndex(storedRecords, coverIndex);

        const idsByGroup = new Map();
        for (const emp of employeeRows || []) {
            if (isCompanyShellEmployee(emp)) continue;
            const key = normalizeStaffType(emp.staffType);
            if (!idsByGroup.has(key)) idsByGroup.set(key, []);
            idsByGroup.get(key).push(String(emp._id));
        }

        const groupCounts = {};
        let totalStaffAll = 0;
        for (const [key, ids] of idsByGroup) {
            groupCounts[key] = ids.length;
            totalStaffAll += ids.length;
        }
        if (staffType && groupCounts[staffType] == null) groupCounts[staffType] = 0;

        const selectedIds = staffType
            ? idsByGroup.get(staffType) || []
            : [...idsByGroup.values()].flat();
        const totalStaff = selectedIds.length;
        const staffIdSet = staffType ? new Set(selectedIds) : null;
        const scheduleWeek = getWeekForStaffType(workingTime, staffType);

        const byDate = new Map();
        for (const row of records) {
            if (staffIdSet && !staffIdSet.has(String(row?.employeeMongoId || ''))) continue;
            const key = String(row?.date || '').trim();
            if (!isValidDateKey(key)) continue;
            if (!byDate.has(key)) byDate.set(key, []);
            byDate.get(key).push(row);
        }

        const days = {};
        const start = new Date(`${from}T12:00:00.000Z`);
        const end = new Date(`${to}T12:00:00.000Z`);
        for (let cursor = start; cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
            const dateKey = cursor.toISOString().slice(0, 10);
            const dayRecords = byDate.get(dateKey) || [];
            const isWeeklyOffDay = staffType
                ? isWeekOffForStaff(scheduleWeek, dateKey)
                : false;
            const stats =
                dayRecords.length > 0 || isWeeklyOffDay
                    ? buildDayStatsFromRecords(dayRecords, totalStaff, { isWeeklyOffDay })
                    : emptyDayStats(totalStaff);

            if (isWeeklyOffDay) {
                stats.isWeeklyOff = true;
                stats.weeklyOff = Math.max(Number(stats.weeklyOff) || 0, totalStaff);
                stats.notMarked = 0;
                stats.absentUnauthorized = 0;
            }

            // When filtered to one staff group, mirror totals into that group's present/total fields.
            if (staffType === 'office') {
                stats.officePresent = stats.totalPresent;
                stats.officeTotal = totalStaff;
                stats.sitePresent = 0;
                stats.siteTotal = 0;
            } else if (staffType === 'site') {
                stats.sitePresent = stats.totalPresent;
                stats.siteTotal = totalStaff;
                stats.officePresent = 0;
                stats.officeTotal = 0;
            }

            days[dateKey] = stats;
        }

        return res.status(200).json({
            message: 'Attendance calendar fetched successfully',
            month: monthKey,
            from,
            to,
            staffType: staffType || 'all',
            totalStaff,
            totalStaffAll,
            groupCounts,
            offWeekdays: staffType ? getOffWeekdayKeys(scheduleWeek) : [],
            days,
        });
    } catch (error) {
        console.error('[getAttendanceCalendarSummary]', error);
        return res.status(500).json({ message: error.message || 'Failed to fetch attendance calendar.' });
    }
}

/** POST /api/Attendance/mark — upsert one or many marks for a day */
export async function markAttendance(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const date = String(req.body?.date || '').trim();
        const marks = Array.isArray(req.body?.marks) ? req.body.marks : [];

        if (!isValidDateKey(date)) {
            return res.status(400).json({ message: 'Valid date (yyyy-MM-dd) is required.' });
        }
        if (marks.length === 0) {
            return res.status(400).json({ message: 'At least one mark is required.' });
        }

        const windowClosed = await rejectIfMarkWindowClosed(req, res, {
            date,
            entries: marks.map((raw) => ({
                employeeMongoId: String(raw?.employeeMongoId || raw?.id || '').trim(),
                statusKey: String(raw?.statusKey || raw?.markKey || '').trim(),
            })),
        });
        if (windowClosed) return;

        const markedBy = req.user?.id || null;
        const saved = [];

        for (const raw of marks) {
            const employeeMongoId = String(raw?.employeeMongoId || raw?.id || '').trim();
            const statusKey = String(raw?.statusKey || raw?.markKey || '').trim();
            const statusLabel = String(raw?.statusLabel || raw?.markLabel || '').trim();

            if (!employeeMongoId) {
                return res.status(400).json({ message: 'employeeMongoId is required for each mark.' });
            }

            // Clear attendance. A holiday or weekly off returns to that status.
            if (statusKey === 'clear_attendance' || statusKey === 'clear') {
                const restored = await restoreClearedAttendance({
                    employeeMongoId,
                    date,
                    markedBy,
                });
                saved.push(restored);
                continue;
            }

            if (!ATTENDANCE_STATUS_KEYS.includes(statusKey)) {
                return res.status(400).json({ message: `Invalid statusKey: ${statusKey}` });
            }
            if (!statusLabel) {
                return res.status(400).json({ message: 'statusLabel is required for each mark.' });
            }

            const timeIn = raw?.timeIn != null && raw.timeIn !== '—' ? String(raw.timeIn).trim() : '';
            const timeOut = raw?.timeOut != null && raw.timeOut !== '—' ? String(raw.timeOut).trim() : '';
            let reason = String(raw?.reason || '').trim();
            let leavePayType = '';

            // Apply Flowchart HR Working Time punch rules (grace / early go) when times are set.
            let finalStatusKey = statusKey;
            let finalStatusLabel =
                statusKey === 'authorized_leave' ? authorizedLeaveLabel(leavePayType) : statusLabel;
            let markEmployee = null;
            try {
                markEmployee = await EmployeeBasic.findById(employeeMongoId)
                    .select('staffType employeeId firstName lastName')
                    .lean();
                const staffType = normalizeStaffType(markEmployee?.staffType);
                const workingTime = await loadWorkingTimeDoc();
                const week = getWeekForStaffType(workingTime, staffType);
                const schedule = getScheduledPunchMinutes(week, date);
                const resolved = resolveStatusFromPunches({
                    timeIn,
                    timeOut,
                    startMinutes: schedule.startMinutes,
                    endMinutes: schedule.endMinutes,
                    isOffDay: schedule.isOffDay,
                    baseStatusKey: statusKey,
                    baseStatusLabel:
                        statusKey === 'authorized_leave'
                            ? authorizedLeaveLabel(leavePayType)
                            : statusLabel,
                    baseReason: reason,
                });
                finalStatusKey = resolved.statusKey;
                finalStatusLabel = resolved.statusLabel;
                if (resolved.reason !== undefined) reason = resolved.reason;
            } catch (scheduleErr) {
                console.error('[markAttendance] schedule punch rules failed:', scheduleErr);
            }

            if (finalStatusKey === 'sick_leave') {
                if (!markEmployee) {
                    markEmployee = await EmployeeBasic.findById(employeeMongoId)
                        .select('staffType employeeId')
                        .lean();
                }
                const overflowMap = await resolveSickOverflowStatuses(
                    markEmployee || { _id: employeeMongoId },
                    [date],
                );
                if (overflowMap.get(date) === 'authorized_leave') {
                    finalStatusKey = 'authorized_leave';
                    leavePayType = '';
                    finalStatusLabel = authorizedLeaveLabel(leavePayType);
                    reason = reason
                        ? `${reason} · Sick allowance used`
                        : 'Converted from sick leave after the allowance from last annual leave was used';
                }
            }

            if (finalStatusKey === 'authorized_leave') {
                finalStatusLabel = authorizedLeaveLabel(leavePayType);
            }

            const otUpdate = await flexibleOtManualUpdate({
                employee: markEmployee || { _id: employeeMongoId, staffType: 'office' },
                date,
                timeIn,
                timeOut,
                statusKey: finalStatusKey,
            });

            const doc = await Attendance.findOneAndUpdate(
                { date, employeeMongoId },
                {
                    $set: {
                        date,
                        employeeMongoId,
                        employeeId: String(raw?.employeeId || raw?.empNo || '').trim(),
                        employeeName: String(raw?.employeeName || raw?.name || '').trim(),
                        statusKey: finalStatusKey,
                        statusLabel: finalStatusLabel,
                        leavePayType: leavePayTypeForStatus(finalStatusKey, leavePayType),
                        timeIn,
                        timeOut,
                        reason,
                        attachmentName: String(raw?.attachmentName || '').trim(),
                        approvalStatus: approvalStatusForMark(finalStatusKey),
                        punchSource: 'manual',
                        checkOutSource: timeOut ? 'manual' : '',
                        markedBy,
                        ...otUpdate,
                    },
                    $unset: {
                        checkInLocation: 1,
                        checkOutLocation: 1,
                        ...(finalStatusKey === 'compoff_leave' ? {} : { compOff: 1 }),
                    },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true },
            );

            saved.push(doc);
        }

        return res.status(200).json({
            message: 'Attendance saved successfully',
            date,
            records: saved,
        });
    } catch (error) {
        console.error('[markAttendance]', error);
        return res.status(500).json({ message: error.message || 'Failed to save attendance.' });
    }
}

/** GET /api/Attendance/me?month=yyyy-MM&forEmployeeId=optionalMongoId */

/** Checked-in days must be Present. Older punches were stored as not_marked. */
function presentFromOpenPunch(record, todayKey) {
    if (!record || !punchTimeSet(record.timeIn)) return record;
    const key = String(record.statusKey || '').trim();
    if (key !== 'not_marked' && key !== 'absent' && key !== '') return record;
    const closed = punchTimeSet(record.timeOut);
    if (!closed && record.date !== todayKey) return record;
    return {
        ...record,
        statusKey: 'on_office',
        statusLabel: 'Present',
    };
}

async function openFlexibleSession(employee, todayKey, todayRecord) {
    const workingTime = await loadWorkingTimeDoc();
    const week = getWeekForStaffType(workingTime, normalizeStaffType(employee?.staffType));
    if (!isFlexibleTiming(week)) return { todayRecord, openFlexiblePunch: false };
    const open = await Attendance.findOne({
        employeeMongoId: String(employee._id),
        date: { $gte: addDaysKey(todayKey, -7), $lte: todayKey },
        timeIn: { $gt: '' },
        $or: [{ timeOut: '' }, { timeOut: null }],
    })
        .sort({ date: -1 })
        .lean();
    if (!open || !String(open.timeIn || '').trim() || String(open.timeOut || '').trim()) {
        return { todayRecord, openFlexiblePunch: false };
    }
    return { todayRecord: open, openFlexiblePunch: true };
}

export async function getMyAttendanceMonth(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const self = await resolveLinkedEmployee(req);
        const forEmployeeId = String(req.query.forEmployeeId || '').trim();
        const hrOverride = forEmployeeId ? await canViewHrEmployeeAttendance(req) : false;

        if (!self && !hrOverride) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        let employee = self;
        if (forEmployeeId && (!self || forEmployeeId !== String(self._id))) {
            if (self && !hrOverride) {
                const allowed = await isEmployeeInTeamTree(self._id, forEmployeeId);
                if (!allowed) {
                    return res.status(403).json({ message: 'You can only view attendance for your team.' });
                }
            }
            const target = await EmployeeBasic.findById(forEmployeeId)
                .select('_id employeeId firstName lastName staffType companyEmail')
                .lean();
            if (!target) {
                return res.status(404).json({ message: 'Employee not found.' });
            }
            employee = target;
        } else if (self) {
            employee = await EmployeeBasic.findById(self._id)
                .select('_id employeeId firstName lastName staffType companyEmail')
                .lean();
            if (!employee) employee = self;
        }

        if (!employee) {
            return res.status(404).json({ message: 'Employee not found.' });
        }

        const month = String(req.query.month || '').trim();
        let year;
        let monthNum;
        if (/^\d{4}-\d{2}$/.test(month)) {
            year = Number(month.slice(0, 4));
            monthNum = Number(month.slice(5, 7));
        } else {
            const p = getDubaiNowParts();
            year = p.year;
            monthNum = p.month;
        }

        const from = `${year}-${String(monthNum).padStart(2, '0')}-01`;
        const lastDay = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
        const to = `${year}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        const todayKey = getDubaiDateKey();
        const employeeMongoId = String(employee._id);
        const isSelf = Boolean(self) && employeeMongoId === String(self._id);
        const staffType = normalizeStaffType(employee.staffType);

        const requestedMonth = `${year}-${String(monthNum).padStart(2, '0')}`;
        const [gate, contactGate] = await Promise.all([
            loadSalaryAttendanceGate(employee, { monthKey: requestedMonth }),
            loadPunchContactFlags(employee),
        ]);
        const employeePayload = {
            id: employeeMongoId,
            employeeId: employee.employeeId,
            name: [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim(),
            staffType,
            hasCompanyEmail: contactGate.hasCompanyEmail,
            hasWhatsappNumber: contactGate.hasWhatsappNumber,
            portalApp: contactGate.portalApp,
            web: contactGate.web,
        };
        const attendanceMatch = employeeAttendanceMatch(employee);
        const loadTodayPunch = async () => {
            const rows = await Attendance.find({ date: todayKey, ...attendanceMatch }).lean();
            return presentFromOpenPunch(bestDayRecord(rows, todayKey), todayKey);
        };

        if (gate.attendanceLocked || !gate.requestedOpen) {
            const loadedToday = await loadTodayPunch();
            const session = await openFlexibleSession(employee, todayKey, loadedToday);
            const locked = Boolean(gate.attendanceLocked);
            return res.status(200).json({
                ...(locked ? salaryLockPayload(gate) : {
                    message: 'Attendance fetched successfully',
                    salaryEnrolled: true,
                    attendanceLocked: false,
                    processingStartMonth: gate.processingStartMonth || '',
                    processingStartDate: gate.processingStartDate || '',
                }),
                month: requestedMonth,
                from,
                to,
                today: todayKey,
                isSelf,
                employee: employeePayload,
                contactGate,
                offWeekdays: [],
                workingTime: { site: {}, office: {}, extra: {} },
                records: session.todayRecord ? [session.todayRecord] : [],
                todayRecord: session.todayRecord,
                openFlexiblePunch: session.openFlexiblePunch,
            });
        }

        const [rawRecords, workingTime, coverIndex] = await Promise.all([
            Attendance.find({
                ...attendanceMatch,
                date: { $gte: from, $lte: to },
            }).lean(),
            loadWorkingTimeDoc(),
            loadLeaveCoverIndex({ from, to, employees: [employee] }),
        ]);
        const records = preferPunchedRows(rawRecords);
        const mergedRecords = applyLeaveCoverIndex(records, coverIndex).map((row) =>
            presentFromOpenPunch(row, todayKey),
        );
        const promoteIds = mergedRecords
            .filter(
                (row) =>
                    row?._id &&
                    punchTimeSet(row.timeIn) &&
                    row.statusKey === 'on_office' &&
                    row.statusLabel === 'Present',
            )
            .map((row) => row._id);
        const alreadyPresentIds = new Set(
            records
                .filter((row) => row.statusKey === 'on_office' && row.statusLabel === 'Present')
                .map((row) => String(row._id)),
        );
        const idsToSave = promoteIds.filter(
            (id) =>
                mongoose.Types.ObjectId.isValid(id) &&
                String(id).length === 24 &&
                !alreadyPresentIds.has(String(id)),
        );
        if (idsToSave.length) {
            try {
                await Attendance.updateMany(
                    { _id: { $in: idsToSave } },
                    { $set: { statusKey: 'on_office', statusLabel: 'Present' } },
                );
            } catch (promoteErr) {
                console.error('[getMyAttendanceMonth] present promote failed:', promoteErr);
            }
        }
        const scheduleWeek = getWeekForStaffType(workingTime, staffType);
        const offWeekdays = getOffWeekdayKeys(scheduleWeek);
        const loadedToday = presentFromOpenPunch(bestDayRecord(mergedRecords, todayKey), todayKey);
        const session = await openFlexibleSession(employee, todayKey, loadedToday);

        return res.status(200).json({
            message: 'Attendance fetched successfully',
            salaryEnrolled: true,
            attendanceLocked: Boolean(gate.attendanceLocked),
            processingStartMonth: gate.processingStartMonth || '',
            processingStartDate: gate.processingStartDate || '',
            month: requestedMonth,
            from,
            to,
            today: todayKey,
            isSelf,
            employee: employeePayload,
            contactGate,
            offWeekdays,
            workingTime: {
                site: workingTime.site,
                office: workingTime.office,
                extra: workingTime.extra || {},
            },
            records: mergedRecords,
            todayRecord: session.todayRecord,
            openFlexiblePunch: session.openFlexiblePunch,
        });
    } catch (error) {
        console.error('[getMyAttendanceMonth]', error);
        return res.status(500).json({ message: error.message || 'Failed to fetch attendance.' });
    }
}

const YEAR_SUMMARY_KEYS = [
    'on_leave',
    'sick_leave',
    'compoff_leave',
    'authorized_leave',
    'unauthorized_leave',
    'work_from_home',
    'on_office',
    'late_arrived',
    'early_go',
    'mispunch',
    'holiday',
    'weekly_off',
];

function emptyYearCounts() {
    return Object.fromEntries(YEAR_SUMMARY_KEYS.map((key) => [key, 0]));
}

const YEAR_SUMMARY_DETAIL_KEYS = [
    'on_leave',
    'sick_leave',
    'compoff_leave',
    'authorized_leave',
    'unauthorized_leave',
    'work_from_home',
    'late_arrived',
    'early_go',
    'mispunch',
];

function serializeYearSummaryEntry(row) {
    const statusKey = String(row?.statusKey || '').trim();
    const requestStatus = String(row?.leaveRequestStatus || '').trim();
    const groupId = String(row?.leaveRequestGroupId || '').trim();
    const source =
        requestStatus || groupId || String(row?.leaveRequestKind || '').trim()
            ? 'Leave request'
            : 'Attendance';
    return {
        date: String(row?.date || '').trim(),
        statusKey,
        statusLabel: leaveStatusLabel(
            statusKey,
            row?.statusLabel || '',
            statusKey === 'authorized_leave' ? 'unpaid' : row?.leavePayType,
        ),
        leavePayType:
            statusKey === 'authorized_leave' ? 'unpaid' : normalizeLeavePayType(row?.leavePayType),
        leaveRequestStatus: requestStatus,
        leaveRequestKind: String(row?.leaveRequestKind || '').trim(),
        leaveRequestGroupId: groupId,
        fromDate: String(row?.leaveRequestFromDate || row?.date || '').trim(),
        toDate: String(row?.leaveRequestToDate || row?.date || '').trim(),
        reason: String(row?.leaveRequestReason || row?.reason || '').trim(),
        source,
    };
}

function lastDateKeyOfMonth(year, monthNum) {
    const lastDay = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
    return `${year}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

function countScheduleDays(from, to, holidaySet, offWeekdays) {
    let workingDays = 0;
    let holidayCount = 0;
    let weeklyOffCount = 0;
    for (let cursor = from; cursor <= to; cursor = nextDateKey(cursor)) {
        if (holidaySet.has(cursor)) {
            holidayCount += 1;
            continue;
        }
        const weekday = weekdayKeyFromDateKey(cursor);
        if (weekday && offWeekdays.has(weekday)) {
            weeklyOffCount += 1;
            continue;
        }
        workingDays += 1;
    }
    return { workingDays, holidayCount, weeklyOffCount };
}

function serializeLeavePolicy(entitlements) {
    if (!entitlements) return null;
    return {
        annualAllowedDays: entitlements.annualAllowedDays,
        sickEnabled: entitlements.sickEnabled,
        sickAllowedDays: entitlements.sickAllowedDays,
        allowedSickLeaveDaysPerYear: entitlements.allowedSickLeaveDaysPerYear,
        sandwichLeave: entitlements.sandwichLeave,
        authorizedDeductionDays: entitlements.multipliers?.authorized,
        unauthorizedDeductionDays: entitlements.multipliers?.unauthorized,
    };
}

function requestStatsFromEnroll(enrollUsed = {}, enrollAttendance = {}) {
    const keys = [
        'on_leave',
        'sick_leave',
        'authorized_leave',
        'unauthorized_leave',
        'compoff_leave',
        'late_arrived',
        'early_go',
        'late_early',
        'mispunch',
    ];
    const stats = {};
    for (const key of keys) {
        const approved = Math.max(0, Number(enrollUsed?.[key]) || 0);
        stats[key] = {
            total: approved,
            request: 0,
            approved,
            rejected: 0,
            present: 0,
        };
    }
    const late = Math.max(0, Number(enrollAttendance?.late) || 0);
    const early = Math.max(0, Number(enrollAttendance?.early) || 0);
    const mispunch = Math.max(0, Number(enrollAttendance?.mispunch) || 0);
    stats.late_arrived.total = late;
    stats.late_arrived.approved = late;
    stats.early_go.total = early;
    stats.early_go.approved = early;
    stats.late_early.total = late + early;
    stats.late_early.approved = late + early;
    stats.mispunch.total = mispunch;
    stats.mispunch.approved = mispunch;
    return stats;
}

function applyEnrollUsedToLeaveBalances(leaveBalances, enrollUsed = {}, entitlements = {}) {
    const next = { ...(leaveBalances || {}) };
    for (const statusKey of [
        'on_leave',
        'sick_leave',
        'authorized_leave',
        'unauthorized_leave',
        'compoff_leave',
    ]) {
        const row = next[statusKey];
        if (!row) continue;
        const taken = Number(enrollUsed[statusKey]) || 0;
        const allowed =
            statusKey === 'on_leave' && entitlements.leaveEligible === false
                ? 0
                : row.allowed != null
                  ? row.allowed
                  : statusKey === 'sick_leave'
                    ? entitlements.sickAllowedDays
                    : statusKey === 'on_leave'
                      ? entitlements.annualAllowedDays
                      : null;
        const multiplier = Number(row.multiplier) || 1;
        next[statusKey] = {
            ...row,
            taken,
            allowed,
            remaining: allowed == null ? null : Math.max(0, Number(allowed) - taken),
            deductionDays: Number((taken * multiplier).toFixed(2)),
        };
    }
    return next;
}

async function leavePolicyForEmployee(employee) {
    try {
        const policy = await resolveEmployeePayrollPolicy(employee);
        return serializeLeavePolicy(leavePolicyEntitlements(policy));
    } catch {
        return null;
    }
}

/**
 * GET /api/Attendance/me/year-summary
 * Logged-in employee's attendance counts for a year, or a month when month=yyyy-MM.
 */
export async function getMyAttendanceYearSummary(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const self = await resolveLinkedEmployee(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        const dubai = getDubaiNowParts();
        const monthRaw = String(req.query.month || '').trim();
        const requestedYear = Number(req.query.year);
        let year;
        let monthNum = 0;
        let from;
        let to;

        if (/^\d{4}-\d{2}$/.test(monthRaw)) {
            year = Number(monthRaw.slice(0, 4));
            monthNum = Number(monthRaw.slice(5, 7));
            from = `${year}-${String(monthNum).padStart(2, '0')}-01`;
            to = lastDateKeyOfMonth(year, monthNum);
        } else {
            year =
                Number.isInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 2100
                    ? requestedYear
                    : dubai.year;
            from = `${year}-01-01`;
            to = `${year}-12-31`;
        }

        const todayMonth = `${dubai.year}-${String(dubai.month).padStart(2, '0')}`;
        const yearEndMonth = `${year}-12`;
        const summaryMonth = monthNum
            ? `${year}-${String(monthNum).padStart(2, '0')}`
            : yearEndMonth < todayMonth
                ? yearEndMonth
                : todayMonth;
        const gate = await loadSalaryAttendanceGate(self, { monthKey: summaryMonth });
        const [enrollWorking, leavePolicy] = await Promise.all([
            loadEmployeeSalaryWorkingDays(self),
            leavePolicyForEmployee(self),
        ]);
        if (gate.attendanceLocked) {
            const counts = emptyYearCounts();
            counts.authorized_leave_paid = 0;
            counts.authorized_leave_unpaid = 0;
            counts.not_marked = 0;
            counts.absent = 0;
            return res.status(200).json({
                ...salaryLockPayload(gate),
                year,
                month: monthNum ? `${year}-${String(monthNum).padStart(2, '0')}` : '',
                from,
                to,
                counts,
                leaveTotal: 0,
                presentDays: 0,
                absentDays: 0,
                absentAuth: 0,
                absentSick: 0,
                absentUnauthorized: 0,
                workingDays: enrollWorking.workingDays,
                holidayCount: 0,
                weeklyOffCount: 0,
                lastAnnualLeaveDate: '',
                entries: [],
                leaveBalances: {},
                leavePolicy,
            });
        }
        if (!gate.requestedOpen) {
            const counts = emptyYearCounts();
            counts.authorized_leave_paid = 0;
            counts.authorized_leave_unpaid = 0;
            counts.not_marked = 0;
            counts.absent = 0;
            return res.status(200).json({
                message: 'Year summary fetched successfully',
                salaryEnrolled: true,
                attendanceLocked: false,
                processingStartMonth: gate.processingStartMonth || '',
                processingStartDate: gate.processingStartDate || '',
                year,
                month: monthNum ? `${year}-${String(monthNum).padStart(2, '0')}` : '',
                from,
                to,
                counts,
                leaveTotal: 0,
                presentDays: 0,
                absentDays: 0,
                absentAuth: 0,
                absentSick: 0,
                absentUnauthorized: 0,
                workingDays: enrollWorking.workingDays,
                holidayCount: 0,
                weeklyOffCount: 0,
                lastAnnualLeaveDate: '',
                entries: [],
                leaveBalances: {},
                leavePolicy,
            });
        }

        const counts = emptyYearCounts();
        counts.authorized_leave_paid = 0;
        counts.authorized_leave_unpaid = 0;
        counts.not_marked = 0;
        counts.absent = 0;
        const attendanceFrom =
            gate.processingStartDate && from < gate.processingStartDate
                ? gate.processingStartDate
                : from;

        const [grouped, holidayRows, employee, workingTime, lastAnnualLeave, detailRows, historicalProfile] =
            await Promise.all([
            Attendance.aggregate([
                {
                    $match: {
                        employeeMongoId: String(self._id),
                        date: { $gte: attendanceFrom, $lte: to },
                    },
                },
                {
                    $group: {
                        _id: { statusKey: '$statusKey', leavePayType: '$leavePayType' },
                        count: { $sum: 1 },
                    },
                },
            ]),
            Holiday.find({ date: { $gte: attendanceFrom, $lte: to } }).select('date appliesTo').lean(),
            EmployeeBasic.findById(self._id).select('staffType').lean(),
            loadWorkingTimeDoc(),
            Attendance.findOne({
                employeeMongoId: String(self._id),
                statusKey: 'on_leave',
                date: { $gte: attendanceFrom, $lte: to },
            })
                .sort({ date: -1 })
                .select('date')
                .lean(),
            Attendance.find({
                employeeMongoId: String(self._id),
                date: { $gte: attendanceFrom, $lte: to },
                statusKey: { $in: YEAR_SUMMARY_DETAIL_KEYS },
            })
                .select(
                    'date statusKey statusLabel leavePayType leaveRequestStatus requestedStatusKey leaveRequestKind leaveRequestGroupId leaveRequestFromDate leaveRequestToDate reason leaveRequestReason',
                )
                .sort({ date: 1 })
                .lean(),
            loadHistoricalLeaveProfile(self.employeeId),
        ]);

        for (const row of grouped) {
            const key = String(row?._id?.statusKey || '').trim();
            const n = Number(row.count) || 0;
            if (Object.prototype.hasOwnProperty.call(counts, key)) {
                counts[key] += n;
            }
            if (key === 'authorized_leave') {
                counts.authorized_leave_unpaid += n;
            }
        }

        const overlay = overlayHistoricalLeave(historicalProfile, {
            from: `${year}-01-01`,
            to: `${year}-12-31`,
            includeCountOnly: true,
        });
        Object.assign(counts, applyOverlayCounts(counts, overlay.extraCounts));
        const yearCover = enrollmentCoverIndexForEmployee(
            historicalProfile,
            self,
            attendanceFrom,
            to,
        );
        const paintedDetails = applyLeaveCoverIndex(detailRows, yearCover, { fillMissing: false });
        let movedOffUnauthorized = 0;
        for (const row of detailRows || []) {
            const date = String(row?.date || '').trim();
            if (String(row?.statusKey || '') !== 'unauthorized_leave' || !date) continue;
            if (!yearCover.has(`${String(self._id)}|${date}`)) continue;
            const punched = Boolean(String(row?.timeIn || '').trim() || String(row?.timeOut || '').trim());
            if (!punched) movedOffUnauthorized += 1;
        }
        if (movedOffUnauthorized) {
            counts.unauthorized_leave = Math.max(0, (counts.unauthorized_leave || 0) - movedOffUnauthorized);
        }

        const staffType = normalizeStaffType(employee?.staffType || self.staffType);
        const scheduleWeek = getWeekForStaffType(workingTime, staffType);
        const offWeekdays = new Set(getOffWeekdayKeys(scheduleWeek));
        const holidaySet = new Set(
            (holidayRows || [])
                .filter((row) => holidayAppliesToStaff(row, staffType))
                .map((row) => String(row.date || '').trim())
                .filter(Boolean),
        );
        const schedule = countScheduleDays(attendanceFrom, to, holidaySet, offWeekdays);

        const presentDays =
            counts.on_office +
            counts.work_from_home +
            counts.late_arrived +
            counts.early_go +
            counts.mispunch;
        const absentAuth = counts.authorized_leave;
        const absentSick = counts.sick_leave;
        const absentCompoff = counts.compoff_leave;
        const absentUnauthorized = counts.unauthorized_leave;
        const absentDays = absentAuth + absentSick + absentCompoff + absentUnauthorized;

        const leaveTotal =
            counts.on_leave +
            counts.sick_leave +
            counts.compoff_leave +
            counts.authorized_leave +
            counts.unauthorized_leave;

        const { types: rawLeaveBalances, entitlements, policy } = await loadEmployeeLeaveBalances(
            { _id: self._id, employeeId: self.employeeId, staffType },
            { year },
        );
        const leaveCycle = await loadCurrentLeaveCycleEligibility({
            employee: { _id: self._id, employeeId: self.employeeId, staffType },
            profile: historicalProfile,
            policy,
            attendanceRecords: paintedDetails,
        });
        const enrollUsed = leaveCycle.used || {};
        const enrollAttendance = leaveCycle.attendance || {};
        const leaveBalances = applyEnrollUsedToLeaveBalances(
            applyOverlayCountsToBalances(rawLeaveBalances, overlay.extraCounts),
            enrollUsed,
            { ...entitlements, leaveEligible: Boolean(leaveCycle.leaveEligible) },
        );

        return res.status(200).json({
            message: 'Year summary fetched successfully',
            salaryEnrolled: true,
            attendanceLocked: Boolean(gate.attendanceLocked),
            processingStartMonth: gate.processingStartMonth || '',
            processingStartDate: gate.processingStartDate || '',
            year,
            month: monthNum ? `${year}-${String(monthNum).padStart(2, '0')}` : '',
            from,
            to,
            counts,
            leaveTotal,
            presentDays,
            absentDays,
            absentAuth,
            absentSick,
            absentUnauthorized,
            workingDays: enrollWorking.workingDays,
            holidayCount: schedule.holidayCount,
            weeklyOffCount: schedule.weeklyOffCount,
            lastAnnualLeaveDate: lastOverlayAnnualLeaveDate(
                overlay.entries,
                lastAnnualLeave?.date || '',
            ),
            entries: [
                ...(paintedDetails || []).map(serializeYearSummaryEntry),
                ...overlay.entries,
            ],
            leaveBalances,
            leavePolicy: serializeLeavePolicy(entitlements) || leavePolicy,
            enrollAttendance,
            requestStats: requestStatsFromEnroll(enrollUsed, enrollAttendance),
            annualLeave: {
                eligible: Boolean(leaveCycle.leaveEligible),
                leaveEligible: Boolean(leaveCycle.leaveEligible),
                completedCycles: Number(leaveCycle.completedCycles) || 0,
                requiredPresentDays: Number(leaveCycle.requiredPresentDays) || 0,
                eligibleDays: Number(leaveCycle.eligibleDays) || 0,
                remainingDays: Number(leaveCycle.remainingDays) || 0,
            },
        });
    } catch (error) {
        console.error('[getMyAttendanceYearSummary]', error);
        return res.status(500).json({ message: error.message || 'Failed to fetch year summary.' });
    }
}

/**
 * GET /api/Attendance/team-tree
 * Root = logged-in employee; children = primaryReportee chain (full tree).
 */
export async function getAttendanceTeamTree(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const manager = await resolveLinkedEmployee(req);
        if (!manager) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        const managerFull = await EmployeeBasic.findById(manager._id)
            .select('_id firstName lastName employeeId designation department profilePicture')
            .lean();

        const rows = await EmployeeBasic.aggregate([
            { $match: { _id: manager._id } },
            {
                $graphLookup: {
                    from: 'employeebasics',
                    startWith: '$_id',
                    connectFromField: '_id',
                    connectToField: 'primaryReportee',
                    as: 'team',
                    depthField: 'depth',
                },
            },
            { $unwind: '$team' },
            {
                $project: {
                    _id: '$team._id',
                    firstName: '$team.firstName',
                    lastName: '$team.lastName',
                    employeeId: '$team.employeeId',
                    designation: '$team.designation',
                    department: '$team.department',
                    profilePicture: '$team.profilePicture',
                    primaryReportee: '$team.primaryReportee',
                    depth: '$team.depth',
                },
            },
            { $sort: { depth: 1, firstName: 1 } },
        ]);

        const tree = buildTeamTree(managerFull, rows);

        return res.status(200).json({
            message: 'Team tree fetched successfully',
            manager: managerFull,
            hierarchy: rows,
            tree,
        });
    } catch (error) {
        console.error('[getAttendanceTeamTree]', error);
        return res.status(500).json({ message: error.message || 'Failed to fetch team tree.' });
    }
}

/** Resolve self or a team member (forEmployeeId) the manager is allowed to mark. */
async function resolveMarkTargetEmployee(req) {
    const self = await resolveLinkedEmployee(req);
    if (!self) return { error: { status: 404, message: 'No linked employee profile found for this user.' } };

    const forEmployeeId = String(
        req.body?.forEmployeeId || req.query?.forEmployeeId || '',
    ).trim();

    if (!forEmployeeId || forEmployeeId === String(self._id)) {
        return { self, employee: self, isSelf: true };
    }

    const allowed = await isEmployeeInTeamTree(self._id, forEmployeeId);
    if (!allowed) {
        return { error: { status: 403, message: 'You can only mark attendance for your team.' } };
    }

    const target = await EmployeeBasic.findById(forEmployeeId)
        .select('_id employeeId firstName lastName staffType companyEmail')
        .lean();
    if (!target) {
        return { error: { status: 404, message: 'Employee not found.' } };
    }

    return { self, employee: target, isSelf: false };
}

/** POST /api/Attendance/me/check-in — store exact Time In for today (self or team) */
export async function checkInMyAttendance(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const resolved = await resolveMarkTargetEmployee(req);
        if (resolved.error) {
            return res.status(resolved.error.status).json({ message: resolved.error.message });
        }

        const { employee } = resolved;
        const date = getDubaiDateKey();
        const timeIn = getDubaiClockTime();
        const employeeMongoId = String(employee._id);
        const employeeName = [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim();

        const dayRows = await Attendance.find({
            date,
            ...employeeAttendanceMatch(employee),
        }).lean();
        const existingPunch = bestDayRecord(dayRows, date);
        if (punchTimeSet(existingPunch?.timeIn)) {
            return res.status(400).json({
                message: 'Already checked in for today.',
                date,
                timeIn: existingPunch.timeIn,
                record: existingPunch,
            });
        }
        if (await rejectIfNotSalaryEnrolled(res, employee)) return;
        const existing =
            dayRows.find((row) => String(row.employeeMongoId) === employeeMongoId) || existingPunch;

        // Punch-in vs Flowchart HR Working Time (15-minute grace).
        // Flexible groups ignore the clock and keep the session open until checkout.
        let statusKey = 'on_office';
        let statusLabel = 'Present';
        let reason = '';
        try {
            const staffType = normalizeStaffType(employee.staffType);
            const workingTime = await loadWorkingTimeDoc();
            const week = getWeekForStaffType(workingTime, staffType);
            if (isFlexibleTiming(week)) {
                const openFrom = addDaysKey(date, -7);
                const open = await Attendance.findOne({
                    employeeMongoId,
                    date: { $gte: openFrom, $lte: date },
                    timeIn: { $gt: '' },
                    $or: [{ timeOut: '' }, { timeOut: null }],
                })
                    .sort({ date: -1 })
                    .lean();
                if (open && String(open.timeIn || '').trim() && !String(open.timeOut || '').trim()) {
                    return res.status(400).json({
                        message: 'Check out the open check-in before checking in again.',
                        date: open.date,
                        timeIn: open.timeIn,
                    });
                }
            } else {
                const { startMinutes, isOffDay } = getScheduledPunchMinutes(week, date);
                const actualMinutes = clockTimeToMinutes(timeIn);
                if (!isOffDay && startMinutes != null && actualMinutes != null) {
                    const graceLimit = startMinutes + 15;
                    if (actualMinutes > graceLimit) {
                        const lateMinutes = actualMinutes - graceLimit;
                        statusKey = 'late_arrived';
                        statusLabel = 'Late Arrival';
                        reason = `${lateMinutes} minute${lateMinutes === 1 ? '' : 's'} late`;
                    }
                }
            }
        } catch (scheduleErr) {
            console.error('[checkInMyAttendance] schedule lookup failed:', scheduleErr);
        }

        const punchSource = resolvePunchSource(req, 'web');
        if (await rejectIfMissingPunchContact(res, employee, punchSource, 'check in')) return;
        let checkInLocation = parsePunchLocation(req.body, punchSource);
        if (!checkInLocation && await employeeHasMobileReviewBypass(employee)) {
            checkInLocation = {
                latitude: 25.2048,
                longitude: 55.2708,
                accuracy: null,
                label: 'App Store Review',
                source: punchSource === 'app' ? 'app' : 'web',
            };
        }
        if (!checkInLocation) {
            return res.status(400).json({
                message: 'Location is off. Turn on location, then check in.',
            });
        }
        const keepPartialLeave = isApprovedPartialLeave(existing);
        if (keepPartialLeave) {
            statusKey = existing.statusKey;
            statusLabel = existing.statusLabel || statusLabel;
            reason = existing.reason || '';
        }
        const checkInSet = {
            date,
            employeeMongoId,
            employeeId: String(employee.employeeId || ''),
            employeeName,
            statusKey,
            statusLabel,
            timeIn,
            timeOut: '',
            reason,
            attachmentName: existing?.attachmentName || '',
            approvalStatus: keepPartialLeave
                ? existing.approvalStatus || 'approved'
                : approvalStatusForMark(statusKey),
            punchSource,
            checkOutSource: '',
            markedBy: req.user?.id || null,
            checkInLocation,
        };

        // Self check-in is allowed even if HR previously marked leave for the day —
        // checking in means the employee is present and starts the timer.
        const doc = await Attendance.findOneAndUpdate(
            existing?._id ? { _id: existing._id } : { date, employeeMongoId },
            {
                $set: checkInSet,
                $unset: { checkOutLocation: 1 },
            },
            { upsert: !existing?._id, new: true, setDefaultsOnInsert: true },
        );

        try {
            await syncPunchMapTargets(doc);
        } catch (mapErr) {
            console.error('[checkInMyAttendance] punch map sync failed:', mapErr);
        }

        return res.status(200).json({
            message: 'Checked in successfully',
            date,
            timeIn,
            record: doc,
        });
    } catch (error) {
        console.error('[checkInMyAttendance]', error);
        return res.status(500).json({ message: error.message || 'Failed to check in.' });
    }
}

const PRESENCE_STATUS_KEYS = new Set(['on_office', 'late_arrived', 'early_go']);

function plainPunchLocation(loc) {
    if (!loc) return null;
    const latitude = loc.latitude ?? null;
    const longitude = loc.longitude ?? null;
    const label = String(loc.label || '').trim();
    if (latitude == null && longitude == null && !label) return null;
    const source = String(loc.source || '').trim();
    return {
        latitude,
        longitude,
        accuracy: loc.accuracy ?? null,
        label,
        source: source === 'app' || source === 'web' || source === 'manual' ? source : '',
    };
}

function employeeFullName(emp) {
    return [emp?.firstName, emp?.lastName].filter(Boolean).join(' ').trim();
}

/** Copy a later check-in or check-out onto employees mapped from this person for the same date. */
async function syncPunchMapTargets(sourceRecord) {
    const sourceId = String(sourceRecord?.employeeMongoId || '').trim();
    const date = String(sourceRecord?.date || '').trim();
    if (!sourceId || !isValidDateKey(date)) return;

    const targets = await Attendance.find({
        date,
        punchMappedFromEmployeeMongoId: sourceId,
    });
    if (!targets.length) return;

    const hasIn = punchTimeSet(sourceRecord.timeIn);
    const hasOut = punchTimeSet(sourceRecord.timeOut);
    const checkInLocation = plainPunchLocation(sourceRecord.checkInLocation);
    const checkOutLocation = plainPunchLocation(sourceRecord.checkOutLocation);

    for (const target of targets) {
        let changed = false;
        if (hasIn && !punchTimeSet(target.timeIn)) {
            target.timeIn = String(sourceRecord.timeIn || '').trim();
            target.punchSource = sourceRecord.punchSource || target.punchSource || '';
            if (checkInLocation) target.checkInLocation = checkInLocation;
            changed = true;
        }
        if (hasOut) {
            target.timeOut = String(sourceRecord.timeOut || '').trim();
            target.checkOutSource = sourceRecord.checkOutSource || '';
            if (checkOutLocation) target.checkOutLocation = checkOutLocation;
            changed = true;
        }
        if (!changed) continue;

        if (PRESENCE_STATUS_KEYS.has(String(sourceRecord.statusKey || ''))) {
            target.statusKey = sourceRecord.statusKey;
            target.statusLabel = sourceRecord.statusLabel || 'Present';
            target.reason = sourceRecord.reason || '';
            target.approvalStatus = approvalStatusForMark(target.statusKey);
        } else if (punchTimeSet(target.timeIn)) {
            target.statusKey = 'on_office';
            target.statusLabel = 'Present';
            target.approvalStatus = approvalStatusForMark('on_office');
        }
        await target.save();
    }
}

/**
 * POST /api/Attendance/map-punch
 * Copy one employee's check-in, check-out, and location for this date onto another employee.
 * A later check-out on the source employee is copied to the mapped employee for this date only.
 */
export async function mapAttendanceFromEmployee(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const date = String(req.body?.date || '').trim();
        const targetId = String(req.body?.targetEmployeeMongoId || '').trim();
        const sourceId = String(req.body?.sourceEmployeeMongoId || '').trim();

        if (!isValidDateKey(date)) {
            return res.status(400).json({ message: 'Valid date (yyyy-MM-dd) is required.' });
        }
        if (!targetId || !sourceId) {
            return res.status(400).json({ message: 'Select an employee to map.' });
        }
        if (targetId === sourceId) {
            return res.status(400).json({ message: 'Choose a different employee.' });
        }

        const windowClosed = await rejectIfMarkWindowClosed(req, res, {
            date,
            entries: [{ employeeMongoId: targetId, statusKey: 'on_office' }],
        });
        if (windowClosed) return;

        const [targetEmp, sourceEmp] = await Promise.all([
            EmployeeBasic.findById(targetId).select('_id employeeId firstName lastName').lean(),
            EmployeeBasic.findById(sourceId).select('_id employeeId firstName lastName').lean(),
        ]);
        if (!targetEmp || !sourceEmp) {
            return res.status(404).json({ message: 'Employee not found.' });
        }

        const sourceRow = await Attendance.findOne({ date, employeeMongoId: sourceId }).lean();
        const hasIn = punchTimeSet(sourceRow?.timeIn);
        const hasOut = punchTimeSet(sourceRow?.timeOut);
        const sourceStatus = String(sourceRow?.statusKey || '').trim();
        const statusKey =
            hasIn && PRESENCE_STATUS_KEYS.has(sourceStatus) ? sourceStatus : 'on_office';
        const statusLabel =
            hasIn && PRESENCE_STATUS_KEYS.has(sourceStatus)
                ? sourceRow.statusLabel || 'Present'
                : 'Present';
        const checkInLocation = plainPunchLocation(sourceRow?.checkInLocation);
        const checkOutLocation = plainPunchLocation(sourceRow?.checkOutLocation);

        const set = {
            date,
            employeeMongoId: targetId,
            employeeId: String(targetEmp.employeeId || '').trim(),
            employeeName: employeeFullName(targetEmp),
            statusKey: hasIn ? statusKey : 'not_marked',
            statusLabel: hasIn ? statusLabel : 'Not marked',
            reason: hasIn ? String(sourceRow?.reason || '').trim() : '',
            timeIn: hasIn ? String(sourceRow.timeIn).trim() : '',
            timeOut: hasOut ? String(sourceRow.timeOut).trim() : '',
            punchSource: hasIn ? sourceRow.punchSource || 'manual' : '',
            checkOutSource: hasOut ? sourceRow.checkOutSource || '' : '',
            approvalStatus: hasIn ? approvalStatusForMark(statusKey) : '',
            punchMappedFromEmployeeMongoId: sourceId,
            markedBy: req.user?.id || null,
        };
        if (checkInLocation) set.checkInLocation = checkInLocation;
        if (checkOutLocation) set.checkOutLocation = checkOutLocation;

        const unset = {};
        if (!checkInLocation) unset.checkInLocation = 1;
        if (!checkOutLocation) unset.checkOutLocation = 1;

        const doc = await Attendance.findOneAndUpdate(
            { date, employeeMongoId: targetId },
            {
                $set: set,
                ...(Object.keys(unset).length ? { $unset: unset } : {}),
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );

        return res.status(200).json({
            message: hasOut
                ? 'Check-in, check-out, and location copied for this day.'
                : 'Check-in and location copied for this day. A later check-out on that employee is copied here too.',
            date,
            record: doc,
        });
    } catch (error) {
        console.error('[mapAttendanceFromEmployee]', error);
        return res.status(500).json({ message: error.message || 'Failed to map attendance.' });
    }
}

/** POST /api/Attendance/me/check-out — store exact Time Out for today (self or team) */
export async function checkOutMyAttendance(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const resolved = await resolveMarkTargetEmployee(req);
        if (resolved.error) {
            return res.status(resolved.error.status).json({ message: resolved.error.message });
        }

        const { employee } = resolved;
        const date = getDubaiDateKey();
        const timeOut = getDubaiClockTime();
        const staffType = normalizeStaffType(employee.staffType);
        const workingTime = await loadWorkingTimeDoc();
        const week = getWeekForStaffType(workingTime, staffType);
        const flexible = isFlexibleTiming(week);

        let existing;
        if (flexible) {
            const openFrom = addDaysKey(date, -7);
            existing = await Attendance.findOne({
                employeeMongoId: String(employee._id),
                date: { $gte: openFrom, $lte: date },
                timeIn: { $gt: '' },
                $or: [{ timeOut: '' }, { timeOut: null }],
            }).sort({ date: -1 });
            if (!existing?.timeIn) {
                if (await rejectIfNotSalaryEnrolled(res, employee)) return;
                return res.status(400).json({ message: 'Check in first before checking out.' });
            }
            if (punchTimeSet(existing.timeOut)) {
                return res.status(400).json({
                    message: 'Already checked out.',
                    record: existing,
                });
            }
        } else {
            const dayRows = await Attendance.find({
                date,
                ...employeeAttendanceMatch(employee),
            });
            existing =
                dayRows.find((row) => punchTimeSet(row.timeIn) && !punchTimeSet(row.timeOut)) ||
                dayRows.find((row) => punchTimeSet(row.timeIn)) ||
                null;
            if (!existing?.timeIn) {
                if (await rejectIfNotSalaryEnrolled(res, employee)) return;
                return res.status(400).json({ message: 'Check in first before checking out.' });
            }
            if (punchTimeSet(existing.timeOut)) {
                return res.status(400).json({
                    message: 'Already checked out for today.',
                    record: existing,
                });
            }
        }

        existing.timeOut = timeOut;
        existing.markedBy = req.user?.id || existing.markedBy || null;
        const punchSource = resolvePunchSource(req, 'web');
        if (await rejectIfMissingPunchContact(res, employee, punchSource, 'check out')) return;
        existing.checkOutSource = punchSource;
        if (!existing.punchSource) existing.punchSource = punchSource;
        let checkOutLocation = parsePunchLocation(req.body, punchSource);
        if (!checkOutLocation && await employeeHasMobileReviewBypass(employee)) {
            checkOutLocation = {
                latitude: 25.2048,
                longitude: 55.2708,
                accuracy: null,
                label: 'App Store Review',
                source: punchSource === 'app' ? 'app' : 'web',
            };
        }
        if (!checkOutLocation) {
            return res.status(400).json({
                message: 'Location is off. Turn on location, then check out.',
            });
        }
        existing.checkOutLocation = checkOutLocation;

        if (flexible) {
            existing.timeOut = timeOut;
            existing.timeOutDate = date !== existing.date ? date : '';
            const workedMinutes = workedMinutesAcross({
                date: existing.date,
                timeIn: existing.timeIn,
                timeOut,
                timeOutDate: existing.timeOutDate,
            });
            const keepPartial = isApprovedPartialLeave(existing);
            const keptLabel = existing.statusLabel;
            const keptReason = existing.reason;
            const result = evaluateFlexibleDay({
                workedMinutes,
                requiredHours: requiredHoursForDate(week, existing.date),
            });
            const nonWorking = Boolean(await nonWorkingAttendanceMark(employee, existing.date));
            const otFields = flexibleOtFieldsFromDuration({
                isFlexible: true,
                nonWorking,
                date: existing.date,
                timeIn: existing.timeIn,
                timeOut,
                timeOutDate: existing.timeOutDate,
                requiredHours: result.requiredHours,
                statusKey: result.statusKey,
            });
            existing.statusKey = result.statusKey;
            existing.statusLabel = result.statusLabel;
            existing.reason = result.reason;
            existing.flexibleWorkedHours = otFields.flexibleWorkedHours;
            existing.flexibleRequiredHours = otFields.flexibleRequiredHours;
            existing.flexibleOtHours = otFields.flexibleOtHours;
            existing.flexibleOtStatus = '';
            existing.flexibleOtApprovedHours = 0;
            existing.flexibleOtReason = '';
            if (keepPartial) {
                existing.statusKey = 'authorized_leave';
                existing.statusLabel = keptLabel;
                existing.reason = keptReason;
                const outcome = partialLeaveOutcome(existing.toObject(), week);
                if (outcome?.leaveDeductionTimes) existing.leaveDeductionTimes = outcome.leaveDeductionTimes;
            }
            existing.approvalStatus = keepPartial
                ? 'approved'
                : approvalStatusForMark(existing.statusKey);
            await existing.save();
            try {
                await syncPunchMapTargets(existing);
            } catch (mapErr) {
                console.error('[checkOutMyAttendance] punch map sync failed:', mapErr);
            }
            return res.status(200).json({
                message: 'Checked out successfully',
                date: existing.date,
                timeOut,
                record: existing,
            });
        }

        const wasLate = existing.statusKey === 'late_arrived';
        const lateReason = wasLate ? String(existing.reason || '').trim() : '';

        // Punch-out vs Flowchart HR Working Time — early go = yellow.
        let earlyGo = false;
        try {
            const staffType = normalizeStaffType(employee.staffType);
            const workingTime = await loadWorkingTimeDoc();
            const week = getWeekForStaffType(workingTime, staffType);
            const { endMinutes, isOffDay } = getScheduledPunchMinutes(week, date);
            const actualOut = clockTimeToMinutes(timeOut);
            if (!isOffDay && endMinutes != null && actualOut != null && actualOut < endMinutes) {
                earlyGo = true;
            }
        } catch (scheduleErr) {
            console.error('[checkOutMyAttendance] schedule lookup failed:', scheduleErr);
        }

        if (isApprovedPartialLeave(existing)) {
            const outcome = partialLeaveOutcome(existing.toObject(), week);
            if (outcome?.leaveDeductionTimes) existing.leaveDeductionTimes = outcome.leaveDeductionTimes;
        } else if (earlyGo) {
            existing.statusKey = 'early_go';
            existing.statusLabel = 'Early Go';
            existing.reason = lateReason
                ? `${lateReason}; Early go`
                : 'Punched out before scheduled punch-out';
        } else if (wasLate) {
            existing.statusKey = 'late_arrived';
            existing.statusLabel = 'Late Arrival';
            existing.reason = lateReason;
        } else {
            existing.statusKey = 'on_office';
            existing.statusLabel = 'Present';
            if (String(existing.reason || '').toLowerCase().includes('mispunch')) {
                existing.reason = '';
            }
        }
        existing.approvalStatus = isApprovedPartialLeave(existing)
            ? existing.approvalStatus || 'approved'
            : approvalStatusForMark(existing.statusKey);

        await existing.save();
        try {
            await syncPunchMapTargets(existing);
        } catch (mapErr) {
            console.error('[checkOutMyAttendance] punch map sync failed:', mapErr);
        }

        return res.status(200).json({
            message: 'Checked out successfully',
            date,
            timeOut,
            record: existing,
        });
    } catch (error) {
        console.error('[checkOutMyAttendance]', error);
        return res.status(500).json({ message: error.message || 'Failed to check out.' });
    }
}

/**
 * POST /api/Attendance/team/mark
 * Mark one or many team members for a date (manager tree only).
 * Body: { date?, employeeMongoIds: [], statusKey, statusLabel, timeIn?, timeOut?, reason? }
 */
export async function markTeamAttendance(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const self = await resolveLinkedEmployee(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        const date = String(req.body?.date || getDubaiDateKey()).trim();
        if (!isValidDateKey(date)) {
            return res.status(400).json({ message: 'Valid date (yyyy-MM-dd) is required.' });
        }

        const statusKey = String(req.body?.statusKey || req.body?.markKey || '').trim();
        const statusLabel = String(req.body?.statusLabel || req.body?.markLabel || '').trim();
        const isClear = statusKey === 'clear_attendance' || statusKey === 'clear';
        if (!isClear && (!ATTENDANCE_STATUS_KEYS.includes(statusKey) || !statusLabel)) {
            return res.status(400).json({ message: 'Valid statusKey and statusLabel are required.' });
        }

        let ids = Array.isArray(req.body?.employeeMongoIds)
            ? req.body.employeeMongoIds.map((id) => String(id || '').trim()).filter(Boolean)
            : [];

        // Mark entire team tree (excluding optional flag)
        if (req.body?.markAllTeam === true) {
            const treeRes = await EmployeeBasic.aggregate([
                { $match: { _id: self._id } },
                {
                    $graphLookup: {
                        from: 'employeebasics',
                        startWith: '$_id',
                        connectFromField: '_id',
                        connectToField: 'primaryReportee',
                        as: 'team',
                    },
                },
                { $project: { teamIds: '$team._id' } },
            ]);
            ids = (treeRes[0]?.teamIds || []).map((id) => String(id));
            // Include self when markAllTeam
            ids = Array.from(new Set([String(self._id), ...ids]));
        }

        if (ids.length === 0) {
            return res.status(400).json({ message: 'At least one employee is required.' });
        }

        const windowClosed = await rejectIfMarkWindowClosed(req, res, {
            date,
            entries: ids.map((employeeMongoId) => ({ employeeMongoId, statusKey })),
        });
        if (windowClosed) return;

        const timeIn =
            req.body?.timeIn != null && req.body.timeIn !== '—' ? String(req.body.timeIn).trim() : '';
        const timeOut =
            req.body?.timeOut != null && req.body.timeOut !== '—'
                ? String(req.body.timeOut).trim()
                : '';
        const reason = String(req.body?.reason || '').trim();
        const attachmentName = String(req.body?.attachmentName || '').trim();
        const leavePayType = '';
        const markedBy = req.user?.id || null;
        const saved = [];

        for (const employeeMongoId of ids) {
            const allowed = await isEmployeeInTeamTree(self._id, employeeMongoId);
            if (!allowed) {
                return res.status(403).json({
                    message: `Not allowed to mark employee ${employeeMongoId}.`,
                });
            }

            if (isClear) {
                const restored = await restoreClearedAttendance({
                    employeeMongoId,
                    date,
                    markedBy,
                });
                saved.push(restored);
                continue;
            }

            const emp = await EmployeeBasic.findById(employeeMongoId)
                .select('_id employeeId firstName lastName staffType')
                .lean();
            if (!emp) continue;

            let finalStatusKey = statusKey;
            let finalStatusLabel =
                statusKey === 'authorized_leave' ? authorizedLeaveLabel(leavePayType) : statusLabel;
            let finalReason = reason;
            try {
                const staffType = normalizeStaffType(emp.staffType);
                const workingTime = await loadWorkingTimeDoc();
                const week = getWeekForStaffType(workingTime, staffType);
                const schedule = getScheduledPunchMinutes(week, date);
                const resolved = resolveStatusFromPunches({
                    timeIn,
                    timeOut,
                    startMinutes: schedule.startMinutes,
                    endMinutes: schedule.endMinutes,
                    isOffDay: schedule.isOffDay,
                    baseStatusKey: statusKey,
                    baseStatusLabel:
                        statusKey === 'authorized_leave'
                            ? authorizedLeaveLabel(leavePayType)
                            : statusLabel,
                    baseReason: reason,
                });
                finalStatusKey = resolved.statusKey;
                finalStatusLabel = resolved.statusLabel;
                if (resolved.reason !== undefined) finalReason = resolved.reason;
            } catch (scheduleErr) {
                console.error('[markTeamAttendance] schedule punch rules failed:', scheduleErr);
            }

            if (finalStatusKey === 'authorized_leave') {
                finalStatusLabel = authorizedLeaveLabel(leavePayType);
            }

            const otUpdate = await flexibleOtManualUpdate({
                employee: emp,
                date,
                timeIn,
                timeOut,
                statusKey: finalStatusKey,
            });

            const doc = await Attendance.findOneAndUpdate(
                { date, employeeMongoId },
                {
                    $set: {
                        date,
                        employeeMongoId,
                        employeeId: String(emp.employeeId || ''),
                        employeeName: [emp.firstName, emp.lastName].filter(Boolean).join(' ').trim(),
                        statusKey: finalStatusKey,
                        statusLabel: finalStatusLabel,
                        leavePayType: leavePayTypeForStatus(finalStatusKey, leavePayType),
                        timeIn,
                        timeOut,
                        reason: finalReason,
                        attachmentName,
                        approvalStatus: approvalStatusForMark(finalStatusKey),
                        punchSource: 'manual',
                        checkOutSource: timeOut ? 'manual' : '',
                        markedBy,
                        ...otUpdate,
                    },
                    $unset: {
                        checkInLocation: 1,
                        checkOutLocation: 1,
                        ...(finalStatusKey === 'compoff_leave' ? {} : { compOff: 1 }),
                    },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true },
            );
            saved.push(doc);
        }

        return res.status(200).json({
            message: isClear
                ? 'Team attendance cleared successfully'
                : 'Team attendance marked successfully',
            date,
            count: saved.length,
            records: saved,
        });
    } catch (error) {
        console.error('[markTeamAttendance]', error);
        return res.status(500).json({ message: error.message || 'Failed to mark team attendance.' });
    }
}

/**
 * GET /api/Attendance/dashboard/pending-inbox
 * Attendance leave requests waiting on this employee (or ?targetUserId= for Team Performance).
 */
export async function getAttendancePendingInbox(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        // Safety: remove any attendance rows for company shell accounts.
        // Do not hold the Attendance bell on this cleanup.
        void Attendance.deleteMany({ employeeName: /\(company\)\s*$/i }).catch(() => {});

        const ctx = await resolveDashboardAssigneeContext(req);
        if (!ctx.ok) {
            return res.status(ctx.status || 401).json({
                message: ctx.message || 'Unauthorized',
                count: 0,
                items: [],
            });
        }

        const self = ctx.employee;
        if (!self) {
            return res.status(200).json({
                message: 'Attendance pending inbox fetched successfully',
                count: 0,
                items: [],
            });
        }

        const reportees = await EmployeeBasic.find({ primaryReportee: self._id })
            .select('_id')
            .lean();
        const reporteeIds = (reportees || []).map((r) => String(r._id));
        const hubItems = await listPendingHubInboxItems({
            assigneeIds: [self._id],
            kinds: ['salary'],
        });
        const hr = await getDepartmentHOD('hr').catch(() => null);
        const viewerIsHr = hr && String(hr._id) === String(self._id);
        const otRows = viewerIsHr
            ? await Attendance.find({ flexibleOtStatus: 'pending' })
                .sort({ updatedAt: -1 })
                .limit(100)
                .lean()
            : [];
        const otEmployeeIds = [...new Set((otRows || []).map((row) => String(row.employeeMongoId || '')).filter(Boolean))];
        const otEmployees = otEmployeeIds.length
            ? await EmployeeBasic.find({ _id: { $in: otEmployeeIds } }).select('staffType').lean()
            : [];
        const otStaffById = new Map((otEmployees || []).map((row) => [String(row._id), normalizeStaffType(row.staffType)]));
        const otItems = (otRows || []).map((r) => ({
            id: String(r._id),
            dashboardActionId: String(r._id),
            requestType: 'Flexible OT Request',
            requestObjectId: String(r._id),
            date: r.date,
            employeeMongoId: r.employeeMongoId,
            employeeId: r.employeeId || '',
            subjectName: r.employeeName || 'Employee',
            staffType: otStaffById.get(String(r.employeeMongoId)) || 'office',
            leaveRequestKind: 'flexible_ot',
            timeIn: r.timeIn || '',
            timeOut: r.timeOut || '',
            reason: r.flexibleOtReason || '',
            flexibleOtApprovedHours: r.flexibleOtApprovedHours || 0,
            flexibleOtHours: r.flexibleOtHours || 0,
            flexibleWorkedHours: r.flexibleWorkedHours || 0,
            status: 'Pending',
            extra1: r.date,
            extra2: `OT request ${r.date}: ${r.flexibleOtApprovedHours || 0} hr`,
            message: `OT request for ${r.employeeName || 'employee'} on ${r.date}`,
        }));

        if (!reporteeIds.length) {
            return res.status(200).json({
                message: 'Attendance pending inbox fetched successfully',
                count: hubItems.length + otItems.length,
                items: [...hubItems, ...otItems],
            });
        }

        const rows = await Attendance.find({
            leaveRequestStatus: 'pending',
            employeeMongoId: { $in: reporteeIds },
            employeeName: { $not: /\(company\)\s*$/i },
        })
            .sort({ leaveRequestedAt: -1, date: -1 })
            .limit(500)
            .lean();

        const items = (rows || [])
            .filter((r) => !isCompanyShellEmployee(r.employeeName) && !isCompanyShellEmployee(r))
            .filter((r) => !isLeaveDashboardAttendanceRow(r))
            .map((r) => {
                const kind = String(r.leaveRequestKind || '');
                const isYellow = kind === 'yellow';
                const isFuture = kind.startsWith('future_');
                const currentLabel =
                    r.previousStatusLabel || r.statusLabel || leaveStatusLabel(r.statusKey);
                const requestedLabel =
                    r.requestedStatusLabel ||
                    (isYellow ? 'Present' : leaveStatusLabel(r.requestedStatusKey));
                const rangeLabel =
                    r.leaveRequestFromDate &&
                    r.leaveRequestToDate &&
                    r.leaveRequestFromDate !== r.leaveRequestToDate
                        ? `${r.leaveRequestFromDate} → ${r.leaveRequestToDate}`
                        : r.date;
                const dayPartLabel =
                    r.leaveRequestDayPart === 'half' || r.leaveRequestDayPart === 'quarter'
                        ? ` · ${partialDayLabel(r.leaveRequestDayPart, r.leaveRequestSession, {
                            flexible: !r.leaveRequestTimeIn,
                            workStart: r.leaveRequestTimeIn,
                            workEnd: r.leaveRequestTimeOut,
                        })}`
                        : '';
                const summary = isYellow
                    ? `Clarification: mark ${r.date} as Present (currently ${currentLabel})`
                    : isFuture
                        ? `${requestedLabel} request for ${rangeLabel}${dayPartLabel}`
                        : `Leave change: mark ${r.date} as ${requestedLabel} (currently ${currentLabel})`;

                return {
                    id: String(r._id),
                    dashboardActionId: String(r._id),
                    requestType: 'Attendance Leave Request',
                    requestObjectId: String(r._id),
                    date: r.date,
                    employeeMongoId: r.employeeMongoId,
                    employeeId: r.employeeId || '',
                    subjectName: r.employeeName || 'Employee',
                    statusKey: r.statusKey,
                    statusLabel: r.statusLabel,
                    requestedStatusKey: r.requestedStatusKey || '',
                    requestedStatusLabel: requestedLabel,
                    previousStatusKey: r.previousStatusKey || '',
                    previousStatusLabel: currentLabel,
                    leaveRequestKind: r.leaveRequestKind || 'leave',
                    leaveRequestFromDate: r.leaveRequestFromDate || '',
                    leaveRequestToDate: r.leaveRequestToDate || '',
                    leaveRequestDayPart: r.leaveRequestDayPart || '',
                    leaveRequestTimeIn: r.leaveRequestTimeIn || '',
                    leaveRequestTimeOut: r.leaveRequestTimeOut || '',
                    timeIn: r.timeIn || '',
                    timeOut: r.timeOut || '',
                    reason: r.leaveRequestReason || r.reason || '',
                    attachmentName: r.attachmentName || '',
                    leaveRequestStatus: r.leaveRequestStatus || 'pending',
                    approvalStatus: r.leaveRequestStatus || 'pending',
                    status: 'Pending',
                    extra1: r.date,
                    extra2: summary,
                    message: summary,
                };
            });

        return res.status(200).json({
            message: 'Attendance pending inbox fetched successfully',
            count: items.length + hubItems.length + otItems.length,
            items: [...hubItems, ...otItems, ...items],
        });
    } catch (error) {
        console.error('[getAttendancePendingInbox]', error);
        return res.status(500).json({ message: error.message || 'Failed to fetch pending attendance.' });
    }
}

/**
 * POST /api/Attendance/dashboard/approve-pending
 * Body: { ids: string[] } — approve pending leave requests for reportees.
 */
export async function approveAttendancePending(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const self = await resolveLinkedEmployee(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        const ids = Array.isArray(req.body?.ids)
            ? req.body.ids.map((id) => String(id || '').trim()).filter(Boolean)
            : [];
        if (ids.length === 0) {
            return res.status(400).json({ message: 'At least one pending attendance id is required.' });
        }

        let modifiedCount = 0;
        for (const id of ids) {
            const result = await decideLeaveRequestInternal({
                attendanceId: id,
                decision: 'approved',
                actor: self,
            });
            if (result?.ok) modifiedCount += 1;
        }

        return res.status(200).json({
            message: 'Attendance leave requests approved successfully',
            modifiedCount,
        });
    } catch (error) {
        console.error('[approveAttendancePending]', error);
        return res.status(500).json({ message: error.message || 'Failed to approve attendance.' });
    }
}

/**
 * POST /api/Attendance/me/leave-request
 * Employee requests Sick or Other leave on a red day.
 * Body: { date, requestedStatusKey, reason, attachmentName }
 */
export async function requestAttendanceLeave(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const self = await resolveLinkedEmployee(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }
        if (await rejectIfNotSalaryEnrolled(res, self, { dateKey: String(req.body?.date || '').trim() })) return;

        const date = String(req.body?.date || '').trim();
        const requestedStatusKey = String(req.body?.requestedStatusKey || '').trim();
        const reason = String(req.body?.reason || '').trim();
        const attachmentName = String(req.body?.attachmentName || '').trim();
        const isLateArrival = requestedStatusKey === 'late_arrived';
        const needsAttachment = requestedStatusKey === 'sick_leave' || requestedStatusKey === 'on_leave';
        const requestTimeIn = isLateArrival ? normalizeClockHHmm(req.body?.timeIn) : '';
        const requestTimeOut = isLateArrival ? normalizeClockHHmm(req.body?.timeOut) : '';

        if (!isValidDateKey(date)) {
            return res.status(400).json({ message: 'A valid date (yyyy-MM-dd) is required.' });
        }
        if (!EMPLOYEE_LEAVE_REQUEST_KEYS.has(requestedStatusKey)) {
            return res.status(400).json({
                message: 'Choose authorized leave, sick leave, or late arrival.',
            });
        }
        if (!reason) {
            return res.status(400).json({ message: 'Reason is required.' });
        }
        if (needsAttachment && !attachmentName) {
            return res.status(400).json({ message: 'A document is required.' });
        }
        if (isLateArrival && (!requestTimeIn || !requestTimeOut)) {
            return res.status(400).json({ message: 'Check-in time and check-out time are required.' });
        }
        if (isLateArrival && requestTimeOut <= requestTimeIn) {
            return res.status(400).json({ message: 'Check-out time must be after check-in time.' });
        }

        const todayKey = getDubaiDateKey();
        if (date > todayKey) {
            return res.status(400).json({ message: 'Cannot request leave for a future date.' });
        }

        const employee = await EmployeeBasic.findById(self._id)
            .select(
                '_id employeeId firstName lastName companyEmail workEmail email primaryReportee staffType',
            )
            .populate(
                'primaryReportee',
                'firstName lastName employeeId companyEmail workEmail email',
            )
            .lean();

        if (!employee?.primaryReportee?._id) {
            return res.status(400).json({
                message: 'Primary reportee is required before requesting a leave status change.',
            });
        }

        let record = await Attendance.findOne({
            employeeMongoId: String(employee._id),
            date,
        });

        if (!record) {
            return res.status(400).json({
                message: 'No attendance mark found for this date. Only red leave days can be requested.',
            });
        }

        if (!RED_LEAVE_STATUS_KEYS.has(record.statusKey)) {
            return res.status(400).json({
                message: 'Leave change can only be requested on Unauthorized / Leave (red) days.',
            });
        }

        if (record.leaveRequestStatus === 'pending') {
            return res.status(400).json({
                message: 'A leave request is already pending for this date.',
                record,
            });
        }

        if (!isLateArrival) {
            const allowanceError = await checkEmployeeLeaveAllowance(employee, {
                statusKey: requestedStatusKey,
                extraDates: [date],
            });
            if (allowanceError) {
                return res.status(400).json({ message: allowanceError });
            }
        }

        let resolvedStatusKey = requestedStatusKey;
        if (requestedStatusKey === 'sick_leave') {
            const overflowMap = await resolveSickOverflowStatuses(employee, [date]);
            resolvedStatusKey = overflowMap.get(date) || 'sick_leave';
        }

        const empName =
            [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim() ||
            record.employeeName ||
            'Employee';
        const requestedStatusLabel = leaveStatusLabel(resolvedStatusKey);
        const previousStatusKey = record.statusKey;
        const previousStatusLabel =
            record.statusLabel || leaveStatusLabel(record.statusKey);

        record.previousStatusKey = previousStatusKey;
        record.previousStatusLabel = previousStatusLabel;
        record.requestedStatusKey = resolvedStatusKey;
        record.requestedStatusLabel = requestedStatusLabel;
        record.leaveRequestReason =
            resolvedStatusKey === 'authorized_leave' && requestedStatusKey === 'sick_leave'
                ? reason
                    ? `${reason} · Sick allowance used`
                    : 'Converted from sick leave after the allowance from last annual leave was used'
                : reason;
        record.leaveRequestKind = isLateArrival ? 'past_late' : 'leave';
        record.leaveRequestDayPart = '';
        record.leaveRequestTimeIn = requestTimeIn;
        record.leaveRequestTimeOut = requestTimeOut;
        record.attachmentName = attachmentName || (needsAttachment ? '' : record.attachmentName || '');
        record.leaveRequestStatus = 'pending';
        record.leaveRequestedAt = new Date();
        record.leaveDecidedAt = null;
        record.leaveDecidedBy = null;
        record.employeeId = employee.employeeId || record.employeeId || '';
        record.employeeName = empName;
        await record.save();

        await notifyPrimaryReporteeOfLeaveRequest({
            employee,
            manager: employee.primaryReportee,
            from: date,
            to: date,
            attendanceId: record._id,
            requestedLabel: requestedStatusLabel,
            requestedStatusKey: resolvedStatusKey,
            leaveRequestKind: 'leave',
            reason,
            attachmentName,
        });

        return res.status(200).json({
            message: 'Leave request sent to your primary reportee.',
            record,
        });
    } catch (error) {
        console.error('[requestAttendanceLeave]', error);
        return res.status(500).json({ message: error.message || 'Failed to submit leave request.' });
    }
}

/**
 * POST /api/Attendance/me/yellow-request
 * Employee clarifies a yellow day (late / early / mispunch) → asks Present.
 * Body: { date, reason, attachmentName? }
 */
export async function requestAttendanceYellow(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const self = await resolveLinkedEmployee(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }
        if (await rejectIfNotSalaryEnrolled(res, self, { dateKey: String(req.body?.date || '').trim() })) return;

        const date = String(req.body?.date || '').trim();
        const reason = String(req.body?.reason || '').trim();
        const attachmentName = String(req.body?.attachmentName || '').trim();

        if (!isValidDateKey(date)) {
            return res.status(400).json({ message: 'A valid date (yyyy-MM-dd) is required.' });
        }
        if (!reason) {
            return res.status(400).json({ message: 'Reason is required for yellow day clarification.' });
        }

        const todayKey = getDubaiDateKey();
        if (date > todayKey) {
            return res.status(400).json({ message: 'Cannot request clarification for a future date.' });
        }

        const employee = await EmployeeBasic.findById(self._id)
            .select(
                '_id employeeId firstName lastName companyEmail workEmail email primaryReportee',
            )
            .populate(
                'primaryReportee',
                'firstName lastName employeeId companyEmail workEmail email',
            )
            .lean();

        if (!employee?.primaryReportee?._id) {
            return res.status(400).json({
                message: 'Primary reportee is required before requesting clarification.',
            });
        }

        const record = await Attendance.findOne({
            employeeMongoId: String(employee._id),
            date,
        });

        if (!record) {
            return res.status(400).json({
                message: 'No attendance mark found for this date.',
            });
        }

        if (!isYellowClarificationEligible(record)) {
            return res.status(400).json({
                message: 'Clarification can only be requested on yellow (late / early / mispunch) days.',
            });
        }

        if (record.leaveRequestStatus === 'pending') {
            return res.status(400).json({
                message: 'A request is already pending for this date.',
                record,
            });
        }

        const empName =
            [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim() ||
            record.employeeName ||
            'Employee';
        const previousStatusKey = record.statusKey;
        const previousStatusLabel =
            record.statusLabel || leaveStatusLabel(record.statusKey);

        record.previousStatusKey = previousStatusKey;
        record.previousStatusLabel = previousStatusLabel;
        record.requestedStatusKey = 'on_office';
        record.requestedStatusLabel = 'Present';
        record.leaveRequestReason = reason;
        record.leaveRequestKind = 'yellow';
        record.attachmentName = attachmentName || record.attachmentName || '';
        record.leaveRequestStatus = 'pending';
        record.leaveRequestedAt = new Date();
        record.leaveDecidedAt = null;
        record.leaveDecidedBy = null;
        record.employeeId = employee.employeeId || record.employeeId || '';
        record.employeeName = empName;
        await record.save();

        await syncDashboardAction({
            requestId: record._id,
            requestType: 'Attendance Leave Request',
            assignedTo: employee.primaryReportee._id,
            status: 'Pending',
            subjectEmployee: employee,
            requestedByName: empName,
            extra1: date,
            extra2: `Clarification: mark as Present (was ${previousStatusLabel})`,
            extra3: JSON.stringify({
                attendanceId: String(record._id),
                employeeMongoId: String(employee._id),
                date,
                requestedStatusKey: 'on_office',
                leaveRequestKind: 'yellow',
            }),
        });

        await sendAttendanceLeaveRequestEmail({
            manager: employee.primaryReportee,
            employee,
            date,
            requestedLabel: 'Present',
            currentLabel: previousStatusLabel,
            reason,
            kind: 'yellow',
            attachmentName,
        });

        return res.status(200).json({
            message: 'Clarification request sent to your primary reportee.',
            record,
        });
    } catch (error) {
        console.error('[requestAttendanceYellow]', error);
        return res.status(500).json({
            message: error.message || 'Failed to submit yellow day clarification.',
        });
    }
}

const FUTURE_REQUEST_KINDS = {
    leave: {
        leaveRequestKind: 'future_leave',
        requestedStatusKey: 'authorized_leave',
        requestedStatusLabel: 'Authorized Leave',
        extra2Prefix: 'Future leave',
    },
    annual_leave: {
        leaveRequestKind: 'future_annual',
        requestedStatusKey: 'on_leave',
        requestedStatusLabel: 'Annual Leave',
        extra2Prefix: 'Future annual leave',
    },
    late_arrived: {
        leaveRequestKind: 'future_late',
        requestedStatusKey: 'late_arrived',
        requestedStatusLabel: 'Late arrival',
        extra2Prefix: 'Future late arrival',
    },
    early_go: {
        leaveRequestKind: 'future_early',
        requestedStatusKey: 'early_go',
        requestedStatusLabel: 'Early go',
        extra2Prefix: 'Future early go',
    },
};

const MAX_FUTURE_REQUEST_DAYS = 62;

/** Accepts HH:mm or HH:mm:ss and returns HH:mm, or '' when unusable. */
function normalizeClockHHmm(value) {
    const match = /^(\d{1,2}):(\d{2})/.exec(String(value || '').trim());
    if (!match) return '';
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return '';
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function isApprovedPartialLeave(record) {
    const part = String(record?.leaveRequestDayPart || '');
    return (
        String(record?.leaveRequestStatus || '') === 'approved' &&
        String(record?.statusKey || '') === 'authorized_leave' &&
        (part === 'half' || part === 'quarter')
    );
}

function partialDayLabel(dayPart, session, described) {
    const name = dayPart === 'quarter' ? 'Quarter day' : dayPart === 'half' ? 'Half day' : 'Full day';
    if (dayPart !== 'half' && dayPart !== 'quarter') return name;
    const side = session === 'pm' ? 'PM' : 'AM';
    if (described && !described.flexible && described.workStart && described.workEnd) {
        return `${name} ${side} (work ${described.workStart}–${described.workEnd})`;
    }
    return `${name} ${side}`;
}

function futureRequestRangeLabel(fromDate, toDate) {
    return fromDate === toDate ? fromDate : `${fromDate} → ${toDate}`;
}

/**
 * POST /api/Attendance/me/future-request
 * Planned leave / late / early across future working days (not tomorrow; skip holidays).
 * Body: { fromDate, toDate, kind, dayPart: full|half|quarter, session: am|pm, reason, attachmentName }
 */
export async function requestAttendanceFuture(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const self = await resolveLinkedEmployee(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }
        if (
            await rejectIfNotSalaryEnrolled(res, self, {
                dateKey: String(req.body?.fromDate || req.body?.date || '').trim(),
            })
        ) {
            return;
        }

        const fromDate = String(req.body?.fromDate || req.body?.date || '').trim();
        const toDate = String(req.body?.toDate || fromDate).trim();
        const kind = String(req.body?.kind || 'leave').trim() || 'leave';
        const reason = String(req.body?.reason || '').trim();
        const attachmentName = String(req.body?.attachmentName || '').trim();
        const isMultiDay = fromDate !== toDate;
        const isAnnualLeave = kind === 'annual_leave';
        const requestedPart = String(req.body?.dayPart || 'full').trim();
        const dayPart =
            !isMultiDay && !isAnnualLeave && (requestedPart === 'half' || requestedPart === 'quarter')
                ? requestedPart
                : 'full';
        const session =
            dayPart === 'full'
                ? ''
                : String(req.body?.session || '').trim().toLowerCase() === 'pm'
                  ? 'pm'
                  : String(req.body?.session || '').trim().toLowerCase() === 'am'
                    ? 'am'
                    : '';
        const spec =
            FUTURE_REQUEST_KINDS[
                kind === 'annual_leave' ? 'annual_leave' : kind === 'leave' ? 'leave' : kind
            ];

        if (!isValidDateKey(fromDate) || !isValidDateKey(toDate)) {
            return res.status(400).json({ message: 'Valid from and to dates (yyyy-MM-dd) are required.' });
        }
        if (toDate < fromDate) {
            return res.status(400).json({ message: 'To date cannot be before the from date.' });
        }
        if (kind === 'leave' && inclusiveDateCount(fromDate, toDate) > 3) {
            return res.status(400).json({
                message:
                    'Maximum 3 days of authorized leave are allowed. For more information, please contact your HOD.',
            });
        }
        if (!spec) {
            return res.status(400).json({ message: 'Choose Leave, Late arrival, or Early go.' });
        }
        if (dayPart !== 'full' && !session) {
            return res.status(400).json({ message: 'Choose AM or PM for a half day or quarter day.' });
        }
        if (kind === 'leave' && !reason) {
            return res.status(400).json({ message: 'Reason is required for authorized leave.' });
        }

        const todayKey = getDubaiDateKey();
        const tomorrowKey = nextDateKey(todayKey);
        if (kind === 'leave' && (fromDate <= tomorrowKey || toDate <= tomorrowKey)) {
            return res.status(400).json({
                message: 'Authorized leave cannot be requested for today or tomorrow.',
            });
        }
        if (fromDate <= todayKey) {
            return res.status(400).json({ message: 'This request is only for future working days.' });
        }

        const employee = await EmployeeBasic.findById(self._id)
            .select(
                '_id employeeId firstName lastName companyEmail workEmail email primaryReportee staffType',
            )
            .populate(
                'primaryReportee',
                'firstName lastName employeeId companyEmail workEmail email',
            )
            .lean();

        const sendLeaveToHr = kind === 'annual_leave' || kind === 'leave';
        let leaveApprover = employee?.primaryReportee || null;
        if (sendLeaveToHr) {
            const hr = await resolveFlowchartHrEmployee();
            if (hr.error || !hr.employee?._id) {
                return res.status(400).json({
                    message: hr.message || 'HR is not configured in the Flowchart.',
                });
            }
            leaveApprover = hr.employee;
        } else if (!leaveApprover?._id) {
            return res.status(400).json({
                message: 'Primary reportee is required before sending this request.',
            });
        }

        if (isAnnualLeave) {
            const { loadAnnualLeaveEligibilityForEmployee } = await import('./leave/leaveDashboardData.js');
            const eligibilityEmployee = await EmployeeBasic.findById(employee._id)
                .select('_id employeeId firstName lastName staffType contractJoiningDate dateOfJoining')
                .lean();
            const eligibility = await loadAnnualLeaveEligibilityForEmployee(eligibilityEmployee, {
                from: fromDate,
                to: toDate,
            });
            if (eligibility?.notEligible) {
                const lines = [];
                if (eligibility.cycleNotEligible) {
                    const required = eligibility.requiredDays || 300;
                    const done = eligibility.eligibleDays || 0;
                    lines.push(
                        `You cannot apply for annual leave. You are not eligible. ${done} of ${required} days are completed from the previous annual leave or joining date to this leave start.`,
                    );
                }
                if (eligibility.groupCap?.over && eligibility.groupCap.message) {
                    lines.push(eligibility.groupCap.message);
                }
                const blockMessage = lines.join(' ') || 'You cannot apply for annual leave for these dates.';
                return res.status(400).json({
                    message: blockMessage.includes('contact your HOD')
                        ? blockMessage
                        : `${blockMessage} For more information, please contact your HOD.`,
                    notEligible: true,
                    ...eligibility,
                });
            }
        }

        const staffType = normalizeStaffType(employee.staffType);
        const workingTime = await loadWorkingTimeDoc();
        const scheduleWeek = getWeekForStaffType(workingTime, staffType);
        const offWeekdays = new Set(getOffWeekdayKeys(scheduleWeek));
        const holidaySet = await loadHolidaySet(todayKey, toDate, staffType);
        const firstEligible = firstEligibleAdvanceRequestDate(todayKey, holidaySet, offWeekdays);

        if (!firstEligible || fromDate < firstEligible) {
            return res.status(400).json({
                message: `Cannot request for tomorrow. The earliest date is ${firstEligible || 'the second working day'} (one working day ahead, holidays skipped).`,
            });
        }

        const attendanceGate = await loadSalaryAttendanceGate(employee, { dateKey: fromDate });
        if (attendanceGate.processingStartDate && fromDate < attendanceGate.processingStartDate) {
            return res.status(400).json({
                message: `Leave requests open from ${attendanceGate.processingStartDate}.`,
            });
        }

        const requestDates = [];
        for (let cursor = fromDate; cursor <= toDate; cursor = nextDateKey(cursor)) {
            if (requestDates.length >= MAX_FUTURE_REQUEST_DAYS) {
                return res.status(400).json({
                    message: `A single request can cover at most ${MAX_FUTURE_REQUEST_DAYS} days.`,
                });
            }
            if (!isNonWorkingDate(cursor, holidaySet, offWeekdays)) requestDates.push(cursor);
        }

        if (!requestDates.length) {
            return res.status(400).json({
                message: 'This range has no working days — holidays and weekly offs are skipped.',
            });
        }

        const partialLeave =
            dayPart === 'full'
                ? null
                : describePartialLeave({
                    week: scheduleWeek,
                    dateKey: requestDates[0],
                    dayPart,
                    session,
                });
        if (dayPart !== 'full' && !partialLeave) {
            return res.status(400).json({
                message: 'This working day has no hours for a half day or quarter day.',
            });
        }

        const existing = await Attendance.find({
            employeeMongoId: String(employee._id),
            date: { $in: requestDates },
        });
        const existingByDate = new Map(existing.map((row) => [row.date, row]));

        for (const dateKey of requestDates) {
            const row = existingByDate.get(dateKey);
            if (!row) continue;
            if (row.leaveRequestStatus === 'pending') {
                return res.status(400).json({
                    message: `A request is already pending for ${dateKey}.`,
                });
            }
            if (
                (row.leaveRequestStatus === 'approved' || row.approvalStatus === 'approved') &&
                ['authorized_leave', 'late_arrived', 'early_go', 'on_leave'].includes(String(row.statusKey || ''))
            ) {
                return res.status(400).json({
                    message: `${dateKey} already has an approved request.`,
                });
            }
        }

        const empName =
            [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim() || 'Employee';
        const groupId = new mongoose.Types.ObjectId().toString();
        const requestedAt = new Date();
        const rangeLabel = futureRequestRangeLabel(fromDate, toDate);
        const dayPartLabel = partialDayLabel(dayPart, session, partialLeave);
        const requestedStatusLabel =
            dayPart !== 'full' && kind === 'leave'
                ? dayPartLabel
                : spec.requestedStatusLabel;
        const extra2Prefix =
            dayPart !== 'full' && kind === 'leave'
                ? `Future ${dayPartLabel}`
                : spec.extra2Prefix;
        const durationLabel = `${requestDates.length} day${requestDates.length === 1 ? '' : 's'}`;
        const savedRecords = [];

        for (const dateKey of requestDates) {
            const record =
                existingByDate.get(dateKey) ||
                new Attendance({
                    date: dateKey,
                    employeeMongoId: String(employee._id),
                    employeeId: employee.employeeId || '',
                    employeeName: empName,
                    statusKey: 'not_marked',
                    statusLabel: 'Upcoming',
                });

            record.previousStatusKey = record.statusKey || 'not_marked';
            record.previousStatusLabel = record.statusLabel || 'Upcoming';
            record.requestedStatusKey = spec.requestedStatusKey;
            record.requestedStatusLabel = requestedStatusLabel;
            record.leaveRequestReason = reason;
            record.leaveRequestKind = spec.leaveRequestKind;
            record.attachmentName = attachmentName;
            record.leaveRequestStatus = 'pending';
            record.leaveRequestDayPart = dayPart;
            record.leaveRequestSession = session;
            record.leaveDayFraction = partialLeavePortion(dayPart);
            record.leaveDeductionTimes = 1;
            record.leaveRequestTimeIn = partialLeave
                ? partialLeave.workStart || ''
                : normalizeClockHHmm(req.body?.timeIn);
            record.leaveRequestTimeOut = partialLeave
                ? partialLeave.workEnd || ''
                : normalizeClockHHmm(req.body?.timeOut);
            record.leaveRequestFromDate = fromDate;
            record.leaveRequestToDate = toDate;
            record.leaveRequestGroupId = groupId;
            record.leaveRequestedAt = requestedAt;
            record.leaveDecidedAt = null;
            record.leaveDecidedBy = null;
            record.employeeId = employee.employeeId || record.employeeId || '';
            record.employeeName = empName;
            await record.save();
            savedRecords.push(record);

            if (!isLeaveDashboardAttendanceRow({ leaveRequestKind: spec.leaveRequestKind, requestedStatusKey: spec.requestedStatusKey })) {
                await syncDashboardAction({
                    requestId: record._id,
                    requestType: 'Attendance Leave Request',
                    assignedTo: leaveApprover._id,
                    status: 'Pending',
                    subjectEmployee: employee,
                    requestedByName: empName,
                    extra1: dateKey,
                    extra2: `${extra2Prefix}: ${rangeLabel} · ${dayPartLabel} · ${durationLabel}`,
                    extra3: JSON.stringify({
                        attendanceId: String(record._id),
                        employeeMongoId: String(employee._id),
                        date: dateKey,
                        requestedStatusKey: spec.requestedStatusKey,
                        leaveRequestKind: spec.leaveRequestKind,
                        leaveRequestGroupId: groupId,
                        dayPart,
                        session,
                    }),
                });
            }
        }

        if (isLeaveDashboardAttendanceRow({
            leaveRequestKind: spec.leaveRequestKind,
            requestedStatusKey: spec.requestedStatusKey,
        })) {
            const approvalAttendanceId = savedRecords.reduce((min, row) => {
                const id = String(row?._id || '');
                return !min || (id && id < min) ? id : min;
            }, '');
            await notifyPrimaryReporteeOfLeaveRequest({
                employee,
                manager: leaveApprover,
                from: fromDate,
                to: toDate,
                attendanceId: approvalAttendanceId || savedRecords[0]?._id,
                groupId,
                requestedLabel: requestedStatusLabel,
                requestedStatusKey: spec.requestedStatusKey,
                leaveRequestKind: spec.leaveRequestKind,
                reason,
                attachmentName,
            });
        } else {
            await sendAttendanceLeaveRequestEmail({
                manager: leaveApprover,
                employee,
                date: requestDates[0],
                dateLabel: rangeLabel,
                requestedLabel: `${requestedStatusLabel} · ${dayPartLabel}`,
                currentLabel: 'Upcoming',
                reason,
                kind: spec.leaveRequestKind,
                attachmentName,
            });
        }

        return res.status(200).json({
            message: sendLeaveToHr
                ? 'Request sent to HR for approval.'
                : 'Request sent to your primary reportee.',
            dates: requestDates,
            record: savedRecords[0],
            records: savedRecords,
        });
    } catch (error) {
        console.error('[requestAttendanceFuture]', error);
        return res.status(500).json({ message: error.message || 'Failed to submit future request.' });
    }
}

/**
 * POST /api/Attendance/me/leave-request/decide
 * Primary reportee approves or rejects.
 * Body: { attendanceId | date + employeeMongoId, decision, approvedStatusKey? }
 */
export async function decideAttendanceLeaveRequest(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const self = await resolveLinkedEmployee(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        const decision = String(req.body?.decision || '').trim().toLowerCase();
        if (decision !== 'approved' && decision !== 'rejected') {
            return res.status(400).json({ message: 'decision must be approved or rejected.' });
        }

        const attendanceId = String(req.body?.attendanceId || '').trim();
        const date = String(req.body?.date || '').trim();
        const employeeMongoId = String(req.body?.employeeMongoId || '').trim();
        const approvedStatusKey = String(req.body?.approvedStatusKey || '').trim();
        const leavePayType = normalizeLeavePayType(req.body?.leavePayType);

        const result = await decideLeaveRequestInternal({
            attendanceId,
            date,
            employeeMongoId,
            decision,
            approvedStatusKey,
            leavePayType,
            actor: self,
        });

        if (!result.ok) {
            return res.status(result.status || 400).json({ message: result.message });
        }

        return res.status(200).json({
            message:
                decision === 'approved'
                    ? 'Leave request approved.'
                    : 'Leave request rejected. Previous status kept.',
            record: result.record,
        });
    } catch (error) {
        console.error('[decideAttendanceLeaveRequest]', error);
        return res.status(500).json({ message: error.message || 'Failed to decide leave request.' });
    }
}

export async function decideLeaveRequestInternal({
    attendanceId,
    date,
    employeeMongoId,
    decision,
    approvedStatusKey = '',
    leavePayType = '',
    actor,
    hrBypass = false,
}) {
    let record = null;
    if (attendanceId && mongoose.Types.ObjectId.isValid(attendanceId)) {
        record = await Attendance.findById(attendanceId);
    } else if (isValidDateKey(date) && employeeMongoId) {
        record = await Attendance.findOne({ date, employeeMongoId: String(employeeMongoId) });
    }

    if (!record) {
        return { ok: false, status: 404, message: 'Attendance record not found.' };
    }
    if (record.leaveRequestStatus !== 'pending') {
        return { ok: false, status: 400, message: 'No pending leave request for this day.' };
    }

    const allowed = hrBypass || (await isEmployeeInTeamTree(actor._id, record.employeeMongoId));
    if (!allowed) {
        return {
            ok: false,
            status: 403,
            message: 'You can only decide leave requests for your team.',
        };
    }

    const subject = await EmployeeBasic.findById(record.employeeMongoId)
        .select('_id employeeId firstName lastName companyEmail workEmail email primaryReportee staffType')
        .lean();

    // Multi-day requests share a group id, so one decision covers every day of the range.
    const groupId = String(record.leaveRequestGroupId || '').trim();
    let groupRecords = [record];
    if (groupId) {
        const siblings = await Attendance.find({
            leaveRequestGroupId: groupId,
            employeeMongoId: record.employeeMongoId,
            leaveRequestStatus: 'pending',
        }).sort({ date: 1 });
        const others = siblings.filter((row) => String(row._id) !== String(record._id));
        groupRecords = [record, ...others].sort((a, b) => (a.date < b.date ? -1 : 1));
    }

    const requestedKey = String(approvedStatusKey || record.requestedStatusKey || '').trim();
    const extraDates = groupRecords.map((row) => String(row.date || '').trim());
    let overflowMap = new Map();
    if (decision === 'approved' && subject) {
        if (
            requestedKey === 'sick_leave' ||
            groupRecords.some((row) => String(row.requestedStatusKey || '') === 'sick_leave')
        ) {
            overflowMap = await resolveSickOverflowStatuses(subject, extraDates, {
                excludeGroupId: groupId,
            });
        } else if (requestedKey !== 'compoff_leave') {
            const allowanceError = await checkEmployeeLeaveAllowance(subject, {
                statusKey: requestedKey,
                extraDates,
                excludeGroupId: groupId,
            });
            if (allowanceError) {
                return { ok: false, status: 400, message: allowanceError };
            }
        }
    }

    const requestedLabel =
        record.requestedStatusLabel || leaveStatusLabel(String(record.requestedStatusKey || '').trim());
    const dateLabel =
        groupRecords.length > 1
            ? `${groupRecords[0].date} → ${groupRecords[groupRecords.length - 1].date}`
            : record.date;

    let finalLabel = '';
    for (const groupRecord of groupRecords) {
        const dayKey =
            overflowMap.get(String(groupRecord.date || '').trim()) ||
            approvedStatusKey ||
            String(groupRecord.requestedStatusKey || requestedKey || '').trim();
        const applied = await applyLeaveDecisionToRecord({
            record: groupRecord,
            decision,
            approvedStatusKey: dayKey,
            leavePayType: '',
            actor,
            subject,
        });
        if (!applied.ok) return applied;
        if (!finalLabel) {
            finalLabel = applied.record
                ? applied.record.statusLabel ||
                  leaveStatusLabel(applied.record.statusKey, '', applied.record.leavePayType)
                : 'Upcoming';
        }
    }

    if (subject) {
        await sendAttendanceLeaveDecisionEmail({
            employee: subject,
            date: groupRecords[0].date,
            dateLabel,
            decision,
            requestedLabel,
            finalLabel,
        });
    }

    const primary = await Attendance.findById(record._id);
    return { ok: true, record: primary };
}

/** Applies one approve/reject to a single day and keeps its dashboard action in sync. */
async function syncLeaveDecisionDashboardActions({
    record,
    actor,
    subject,
    decision,
    requestedLabel,
}) {
    const status = decision === 'approved' ? 'Approved' : 'Rejected';
    const subjectEmployee = subject || {
        _id: record.employeeMongoId,
        employeeId: record.employeeId,
        firstName: record.employeeName,
    };
    const payload = {
        assignedTo: actor._id,
        status,
        subjectEmployee,
        actionedBy: actor._id,
        extra1: record.date,
        extra2: requestedLabel,
    };

    await syncDashboardAction({
        ...payload,
        requestId: record._id,
        requestType: 'Attendance Leave Request',
    });

    if (isLeaveDashboardAttendanceRow(record) || String(record.leaveRequestKind || '') === 'past_late') {
        await syncDashboardAction({
            ...payload,
            requestId: leaveDashboardRequestObjectId(record.leaveRequestGroupId, record._id),
            requestType: LEAVE_DASHBOARD_REQUEST_TYPE,
        });
    }
}

/** Applies one approve/reject to a single day and keeps its dashboard action in sync. */
async function applyLeaveDecisionToRecord({
    record,
    decision,
    approvedStatusKey = '',
    leavePayType = '',
    actor,
    subject,
}) {
    const requestedKey = String(record.requestedStatusKey || '').trim();
    const requestedLabel =
        record.requestedStatusLabel || leaveStatusLabel(requestedKey);
    const kind = String(record.leaveRequestKind || '');
    const partialLabel = partialDayLabel(
        record.leaveRequestDayPart,
        record.leaveRequestSession,
        {
            flexible: !record.leaveRequestTimeIn,
            workStart: record.leaveRequestTimeIn,
            workEnd: record.leaveRequestTimeOut,
        },
    );
    const partialSuffix =
        record.leaveRequestDayPart === 'half' || record.leaveRequestDayPart === 'quarter'
            ? ` · ${partialLabel}`
            : '';

        if (decision === 'approved') {
        const applyAuthorized = () => {
            const part = String(record.leaveRequestDayPart || 'full');
            record.statusKey = 'authorized_leave';
            record.statusLabel =
                part === 'half'
                    ? `Authorized Half Day${record.leaveRequestSession ? ` (${String(record.leaveRequestSession).toUpperCase()})` : ''}`
                    : part === 'quarter'
                      ? `Authorized Quarter Day${record.leaveRequestSession ? ` (${String(record.leaveRequestSession).toUpperCase()})` : ''}`
                      : 'Authorized Leave';
            record.leavePayType = 'unpaid';
            record.leaveDayFraction = partialLeavePortion(part);
            record.approvalStatus = 'approved';
            if (record.leaveRequestReason) record.reason = record.leaveRequestReason;
            return null;
        };

        if (kind === 'yellow' || requestedKey === 'on_office') {
            record.statusKey = 'on_office';
            record.statusLabel = 'Present';
            record.leavePayType = '';
            record.approvalStatus = 'approved';
            if (!String(record.timeOut || '').trim()) {
                record.timeOut = String(record.timeIn || '').trim() || '18:00:00';
            }
            if (record.leaveRequestReason) {
                record.reason = record.leaveRequestReason;
            }
        } else if (kind === 'future_leave') {
            const payError = applyAuthorized();
            if (payError) return payError;
        } else if (kind === 'future_annual') {
            record.statusKey = 'on_leave';
            record.statusLabel = 'Annual Leave';
            record.leavePayType = '';
            record.approvalStatus = 'approved';
            if (record.leaveRequestReason) record.reason = record.leaveRequestReason;
        } else if (kind === 'future_late' || kind === 'past_late') {
            record.statusKey = 'late_arrived';
            record.statusLabel = kind === 'past_late' ? 'Late Arrival' : `Late arrival approved${partialSuffix}`;
            record.leavePayType = '';
            record.approvalStatus = 'approved';
            if (kind === 'past_late') {
                const clock = (value) => {
                    const hhmm = normalizeClockHHmm(value);
                    return hhmm ? `${hhmm}:00` : '';
                };
                const arrived = clock(record.leaveRequestTimeIn);
                const left = clock(record.leaveRequestTimeOut);
                if (arrived) record.timeIn = arrived;
                if (left) record.timeOut = left;
            }
            if (record.leaveRequestReason) record.reason = record.leaveRequestReason;
        } else if (kind === 'future_early') {
            record.statusKey = 'early_go';
            record.statusLabel = 'Early go approved';
            record.leavePayType = '';
            record.approvalStatus = 'approved';
            if (record.leaveRequestReason) record.reason = record.leaveRequestReason;
        } else {
            const chosenKey = String(approvedStatusKey || '').trim() || requestedKey;
            if (!REPORTEE_APPROVE_LEAVE_KEYS.has(chosenKey)) {
                return {
                    ok: false,
                    status: 400,
                    message: 'Choose Authorized, Sick, or Unauthorized leave before approving.',
                };
            }
            if (chosenKey === 'authorized_leave') {
                const payError = applyAuthorized();
                if (payError) return payError;
            } else {
                record.statusKey = chosenKey;
                record.statusLabel = leaveStatusLabel(chosenKey);
                record.leavePayType = '';
                record.approvalStatus = 'approved';
                if (record.leaveRequestReason && !record.reason) {
                    record.reason = record.leaveRequestReason;
                }
            }
        }
    }

    if (
        decision === 'rejected' &&
        kind.startsWith('future_') &&
        (!record.timeIn || record.previousStatusKey === 'not_marked')
    ) {
        const recordId = record._id;
        const dateKey = record.date;
        const snapshot =
            typeof record.toObject === 'function' ? record.toObject() : { ...record };
        await Attendance.deleteOne({ _id: recordId });
        await syncLeaveDecisionDashboardActions({
            record: { ...snapshot, _id: recordId, date: dateKey },
            actor,
            subject,
            decision: 'rejected',
            requestedLabel,
        });
        return { ok: true, record: null };
    }

    record.leaveRequestStatus = decision;
    record.leaveDecidedAt = new Date();
    record.leaveDecidedBy = actor._id;
    await record.save();

    await syncLeaveDecisionDashboardActions({
        record,
        actor,
        subject,
        decision,
        requestedLabel,
    });

    return { ok: true, record };
}
