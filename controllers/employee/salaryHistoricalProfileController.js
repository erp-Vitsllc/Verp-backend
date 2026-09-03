import Attendance from '../../models/Attendance.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import Holiday from '../../models/Holiday.js';
import PayrollSettings from '../../models/PayrollSettings.js';
import SalaryEnrollment from '../../models/SalaryEnrollment.js';
import SalaryHistoricalProfile from '../../models/SalaryHistoricalProfile.js';
import EmployeeSalary from '../../models/EmployeeSalary.js';
import WorkingTime from '../../models/WorkingTime.js';
import User from '../../models/User.js';
import { isCompanyShellEmployee } from '../../utils/attendanceEmployeeFilters.js';
import {
    getOffWeekdayKeys,
    getWeekForStaffType,
    holidayAppliesToStaff,
    WEEKDAY_KEYS,
} from '../../utils/workingTimeHelpers.js';
import { listActiveWorkLocations, normalizeStaffTypeKey } from '../../utils/workLocationHelpers.js';
import { getCalendarPartsInTz, getScheduledEmailTimeZone } from '../../utils/scheduleDailyAtMidnight.js';
import { hasPermission, isUserAdministrator } from '../../services/permissionService.js';
import { ensureAttachmentPersistedToS3, signOrKeepAttachmentUrl } from '../../utils/s3Upload.js';
import {
    addDays,
    allCyclesVerified,
    buildReadinessItems,
    calculateHistoricalEligibility,
    canEditProfile,
    findDuplicateConsumingCycles,
    findOverlappingLeave,
    historicalPeriod,
    inclusiveCalendarDays,
    isDateKey,
    leaveMultiplier,
    leaveRecordPeriodRange,
    MESSAGES,
    annualLeavePeriodRange,
    partitionEnrollmentRows,
    paymentCyclePeriodRange,
    policyLeaveMultipliers,
    policyLeaveWorkingDays,
    resolveEntitlementDays,
    LIVE_LEAVE_STATUS_MAP,
    summarizeAttendanceEligibility,
    validateLeaveDates,
    consolidateCountOnlyLeaveRecords,
    validateVerpStart,
    workflowIsLocked,
} from '../../utils/salaryHistoricalCalculations.js';
import { serializePayrollSettings, requireMainSalaryPolicy } from './payrollSettingsController.js';
import { applySickAllowanceToLeaveRecords, leavePolicyEntitlements, resolveEmployeePayrollPolicy } from '../../utils/employeeLeavePolicy.js';
import { resolveFlowchartHrEmployee } from '../../utils/resolveFlowchartHrEmployee.js';
import { viewerIsSalaryFlowchartHr as viewerIsSalaryHr } from '../../utils/viewerIsSalaryFlowchartHr.js';
import { isUserActiveInFlowchart } from '../../utils/getDepartmentHOD.js';
import {
    closeSalaryEnrollmentInbox,
    emailCreatorSalaryApproved,
    emailEmployeeSalaryRejected,
    emailHrSalaryEnrollmentRevoked,
    notifyManagementSalaryEnrollmentReset,
    notifySalaryEnrollmentSubmitted,
} from '../../utils/salaryEnrollmentApprovalNotify.js';
import {
    buildDmfViewerContext,
    serializeDmf,
} from '../../utils/salaryDmfApproval.js';
import { awaitAdminDeletionArchive } from '../../utils/adminDeletionArchiveRun.js';
import { verifyFlowchartHrUserPassword } from '../../utils/verifyCurrentUserPassword.js';
import { SALARY_ENROLLMENT_RESET_RETENTION_DAYS } from '../../constants/adminDeletionArchiveConstants.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const LEAVE_TYPES = new Set(['sick', 'authorized', 'unauthorized', 'annual']);

function pad2(n) {
    return String(n).padStart(2, '0');
}

function toDateKey(value) {
    if (!value) return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
    }
    const s = String(value).trim();
    if (ISO.test(s)) return s;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Recover VERP start from salary enrollment when the historical profile field is blank. */
function verpDateFromEnrollment(enrollment) {
    if (!enrollment) return '';
    const salaryDate = String(enrollment.salaryDate || '').trim();
    if (ISO.test(salaryDate)) return salaryDate;
    const fromMonth = String(enrollment.fromMonth || '').trim();
    if (!/^\d{4}-\d{2}$/.test(fromMonth)) return '';
    const dayNum = Number(salaryDate);
    const day = Number.isInteger(dayNum) && dayNum >= 1 && dayNum <= 28 ? dayNum : 1;
    return `${fromMonth}-${pad2(day)}`;
}

function hasBodyField(body, key) {
    return Boolean(body) && Object.prototype.hasOwnProperty.call(body, key);
}

function fromKey(key) {
    if (!ISO.test(key)) return null;
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
}

function weekdayKey(date) {
    return WEEKDAY_KEYS[date.getDay()];
}

function personName(row) {
    if (!row) return '';
    return `${row.firstName || ''} ${row.lastName || ''}`.trim();
}

function initials(name) {
    return String(name || '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0])
        .join('')
        .toUpperCase();
}

function actor(req) {
    return {
        id: req.user?.id || req.user?._id || null,
        name: req.user?.username || req.user?.name || req.user?.email || '',
        employeeId: req.user?.employeeId || '',
    };
}

async function resolveVerifierDepartment(profile) {
    const employeeCode = String(profile?.verifiedByEmployeeId || '').trim();
    const userId = profile?.verifiedBy;
    let code = employeeCode;
    if (!code && userId) {
        const user = await User.findById(userId).select('employeeId').lean();
        code = String(user?.employeeId || '').trim();
    }
    if (!code) return '';
    const emp = await EmployeeBasic.findOne({ employeeId: code }).select('department').lean();
    return String(emp?.department || '').trim();
}

function serializeAttachment(value) {
    if (!value || typeof value !== 'object') return null;
    const name = String(value.name || '').trim();
    const publicId = String(value.publicId || '').trim();
    const url = String(value.url || '').trim();
    if (!name && !publicId && !url && !value.data && !value.base64) return null;
    return {
        name,
        mimeType: String(value.mimeType || value.mime || '').trim(),
        publicId,
        url,
        data: value.data || value.base64 || undefined,
    };
}

async function persistAttachment(attachment, folder) {
    const row = serializeAttachment(attachment);
    if (!row) return null;
    if (!row.data && !row.publicId && !row.url) {
        return { name: row.name, mimeType: row.mimeType, publicId: '', url: '' };
    }
    const saved = await ensureAttachmentPersistedToS3(row, {
        folder,
        fileName: row.name || 'historical-salary-attachment.pdf',
    });
    return saved
        ? { name: saved.name, mimeType: saved.mimeType, publicId: saved.publicId, url: saved.url || '' }
        : { name: row.name, mimeType: row.mimeType, publicId: row.publicId, url: row.url };
}

function serializeEmployee(emp, workLocationLabel = '') {
    const name = personName(emp);
    const reportee = emp?.primaryReportee;
    const designation = emp?.designation || emp?.role || '';
    return {
        employeeId: String(emp.employeeId || '').trim(),
        mongoId: String(emp._id || ''),
        name,
        initials: initials(name) || 'EE',
        status: String(emp.status || ''),
        profileStatus: String(emp.profileStatus || ''),
        designation,
        department: emp.department || '',
        reportsTo: personName(reportee) || '',
        staffType: normalizeStaffTypeKey(emp.staffType),
        workLocationLabel: workLocationLabel || '',
        joiningDate: toDateKey(emp.contractJoiningDate || emp.dateOfJoining),
        profilePicture: emp.profilePicture || '',
        locationLabel: [designation, workLocationLabel].filter(Boolean).join(' · '),
    };
}

async function signedProfilePicture(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return '';
    if (raw.startsWith('data:')) return raw;
    return (await signOrKeepAttachmentUrl(raw)) || raw;
}

async function userCanEdit(req) {
    const userId = req.user?.id || req.user?._id;
    if (!userId) return false;
    if (await isUserAdministrator(userId)) return true;
    return (
        (await hasPermission(userId, 'hrm_salary', 'edit')) ||
        (await hasPermission(userId, 'hrm_employees_view_salary', 'edit'))
    );
}

async function userCanViewSalarySetup(req) {
    const userId = req.user?.id || req.user?._id;
    if (!userId) return false;
    if (await isUserAdministrator(userId)) return true;
    if (await userCanEdit(req)) return true;
    return (
        (await hasPermission(userId, 'hrm_salary', 'isView')) ||
        (await hasPermission(userId, 'hrm_employees_view_salary', 'isView'))
    );
}

function cycleDaysFromPolicy(policy) {
    return policyLeaveWorkingDays(policy);
}

function withLiveLeaveEntitlements(policy, livePolicy) {
    if (!livePolicy) return policy;
    return {
        ...policy,
        leaveSalaryWorkingDays: livePolicy.leaveSalaryWorkingDays ?? policy?.leaveSalaryWorkingDays,
        workingDaysRequiredForAirTicket:
            livePolicy.workingDaysRequiredForAirTicket ?? policy?.workingDaysRequiredForAirTicket,
        workingDaysRequiredToEligible:
            livePolicy.workingDaysRequiredToEligible ?? policy?.workingDaysRequiredToEligible,
    };
}

function pickEmployeeLeaveSalary(salaryDoc) {
    const fromSalary = Number(salaryDoc?.basic ?? salaryDoc?.basicSalary) || 0;
    if (fromSalary > 0) return fromSalary;
    const history = Array.isArray(salaryDoc?.salaryHistory) ? salaryDoc.salaryHistory : [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
        const basic = Number(history[i]?.basic) || 0;
        if (basic > 0) return basic;
    }
    return 0;
}

async function policyCopyForEmployee(employee, salaryDay) {
    const staffType = normalizeStaffTypeKey(employee?.staffType);
    const group = staffType
        ? await PayrollSettings.findOne({ key: `group:${staffType}` }).lean()
        : null;
    const base = group || (await PayrollSettings.findOne({ key: 'default' }).lean());
    const policy = serializePayrollSettings(base);
    if (salaryDay) policy.salaryProcessingDate = salaryDay;
    return policy;
}

async function calcWorkingDays({ from, to, staffType }) {
    const startDate = fromKey(from);
    const endDate = fromKey(to);
    const calendarDays = isDateKey(from) && isDateKey(to) && to >= from ? inclusiveCalendarDays(from, to) : 0;
    if (!startDate || !endDate || endDate < startDate) {
        return { workingDays: 0, weeklyOffs: 0, holidays: 0, calendarDays: 0 };
    }

    const [workingTime, holidays] = await Promise.all([
        WorkingTime.findOne({}).lean(),
        Holiday.find({ date: { $gte: from, $lte: to } }).lean(),
    ]);
    const week = getWeekForStaffType(workingTime, staffType);
    const offKeys = new Set(getOffWeekdayKeys(week));
    const holidayDates = new Set(
        (holidays || [])
            .filter((row) => holidayAppliesToStaff(row, staffType))
            .map((row) => String(row.date)),
    );

    let workingDays = 0;
    let weeklyOffs = 0;
    let holidayHits = 0;
    const cursor = new Date(startDate.getTime());
    const last = new Date(endDate.getTime());
    while (cursor <= last) {
        const key = `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}-${pad2(cursor.getDate())}`;
        const day = weekdayKey(cursor);
        if (holidayDates.has(key)) holidayHits += 1;
        else if (offKeys.has(day)) weeklyOffs += 1;
        else workingDays += 1;
        cursor.setDate(cursor.getDate() + 1);
    }

    return { workingDays, weeklyOffs, holidays: holidayHits, calendarDays };
}

function dubaiDateKey(date = new Date()) {
    const parts = getCalendarPartsInTz(date, getScheduledEmailTimeZone());
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

async function loadLiveAttendanceEligibility({ employee, from, to, staffType }) {
    if (!isDateKey(from) || !employee) {
        return { workingDays: 0, leaveRecords: [], from: '', to: '' };
    }
    const clauses = [];
    if (employee._id) clauses.push({ employeeMongoId: String(employee._id) });
    if (employee.employeeId) clauses.push({ employeeId: employee.employeeId });
    const periodEnd = isDateKey(to) && to >= from ? to : '';
    const stats = periodEnd
        ? await calcWorkingDays({ from, to: periodEnd, staffType })
        : { workingDays: 0, weeklyOffs: 0, holidays: 0, calendarDays: 0 };
    if (!clauses.length) {
        return { workingDays: stats.workingDays, leaveRecords: [], from, to: periodEnd };
    }

    const leaveStatusKeys = Object.keys(LIVE_LEAVE_STATUS_MAP);
    const rows = await Attendance.find({
        date: { $gte: from },
        $and: [
            { $or: clauses },
            {
                $or: [
                    { statusKey: { $in: leaveStatusKeys } },
                    { leaveRequestStatus: { $in: ['approved', 'pending'] } },
                ],
            },
        ],
    })
        .select('date statusKey leaveRequestStatus requestedStatusKey')
        .lean();
    const live = summarizeAttendanceEligibility(rows);
    return {
        workingDays: stats.workingDays,
        leaveRecords: live.leaveRecords,
        from,
        to: periodEnd,
    };
}

function toLeaveRows(value, policyMultipliers) {
    const rows = Array.isArray(value) ? value : [];
    return rows.slice(0, 120).map((row) => {
        const type = String(row?.leaveType || 'sick').trim().toLowerCase();
        const eligible = Math.max(0, Number(row?.eligibleWorkingDays ?? row?.actualDays) || 0);
        const multiplier = leaveMultiplier(type, row?.multiplier ?? row?.rule, policyMultipliers);
        const calendarDays =
            Number(row?.calendarDays) ||
            inclusiveCalendarDays(toDateKey(row?.fromDate), toDateKey(row?.toDate)) ||
            Number(row?.actualDays) ||
            0;
        const deductionDays = Number(row?.deductionDays ?? row?.deduction) || eligible * multiplier;
        const source = normalizeLeaveSource(row?.source);
        const status = String(row?.status || 'approved').trim().toLowerCase() || 'approved';
        return {
            id: String(row?._id || row?.id || ''),
            leaveType: LEAVE_TYPES.has(type) ? type : 'sick',
            fromDate: toDateKey(row?.fromDate || row?.startDate),
            toDate: toDateKey(row?.toDate || row?.endDate),
            calendarDays,
            actualDays: calendarDays,
            eligibleWorkingDays: eligible,
            multiplier,
            rule: multiplier,
            deductionDays,
            deduction: deductionDays,
            source,
            status,
            remarks: String(row?.remarks || '').trim(),
            includeLeave: Boolean(row?.includeLeave),
            includeTicket: Boolean(row?.includeTicket),
            leaveSalaryAmount: Math.max(0, Number(row?.leaveSalaryAmount ?? row?.leaveSalary) || 0),
            ticketAmount: Math.max(0, Number(row?.ticketAmount) || 0),
            reduceHistoricalWorkingDays: Boolean(row?.reduceHistoricalWorkingDays),
            attachment: serializeAttachment(row?.attachment),
            createdBy: row?.createdBy || null,
            createdByName: String(row?.createdByName || ''),
            verifiedBy: row?.verifiedBy || null,
            verifiedByName: String(row?.verifiedByName || ''),
            verifiedAt: row?.verifiedAt || null,
        };
    });
}

function toAnnualRows(value) {
    const rows = Array.isArray(value) ? value : [];
    return rows.slice(0, 80).map((row) => {
        const startDate = toDateKey(row?.startDate || row?.fromDate);
        const endDate = toDateKey(row?.endDate || row?.toDate);
        const eligible = Math.max(0, Number(row?.eligibleWorkingDays ?? row?.actualDays) || 0);
        const calendarDays = Number(row?.calendarDays) || inclusiveCalendarDays(startDate, endDate);
        return {
            id: String(row?._id || row?.id || ''),
            leaveType: 'annual',
            startDate,
            endDate,
            fromDate: startDate,
            toDate: endDate,
            returnToWorkDate: toDateKey(row?.returnToWorkDate),
            calendarDays,
            eligibleWorkingDays: eligible,
            actualDays: eligible,
            multiplier: 1,
            deductionDays: eligible,
            source: normalizeLeaveSource(row?.source),
            status: String(row?.status || 'approved').trim().toLowerCase() || 'approved',
            remarks: String(row?.remarks || '').trim(),
            includeLeave: Boolean(row?.includeLeave),
            includeTicket: Boolean(row?.includeTicket),
            leaveSalaryAmount: Math.max(0, Number(row?.leaveSalaryAmount ?? row?.leaveSalary) || 0),
            ticketAmount: Math.max(0, Number(row?.ticketAmount) || 0),
            reduceHistoricalWorkingDays: Boolean(row?.reduceHistoricalWorkingDays),
            attachment: serializeAttachment(row?.attachment),
            createdBy: row?.createdBy || null,
            createdByName: String(row?.createdByName || ''),
            verifiedBy: row?.verifiedBy || null,
            verifiedByName: String(row?.verifiedByName || ''),
            verifiedAt: row?.verifiedAt || null,
        };
    });
}

function toCycleRows(value, cycleDays) {
    const entitlement = resolveEntitlementDays(cycleDays);
    const rows = Array.isArray(value) ? value : [];
    return rows.slice(0, 40).map((row, index) => {
        const paymentStatus = String(row?.paymentStatus || row?.status || 'draft').trim().toLowerCase() || 'draft';
        const verificationStatus =
            String(row?.verificationStatus || '').trim().toLowerCase() ||
            (paymentStatus === 'paid' && !row?.verificationStatus ? 'verified' : 'pending');
        const leaveSalaryAmount = Math.max(0, Number(row?.leaveSalaryAmount ?? row?.leaveSalary) || 0);
        const ticketAmount = Math.max(0, Number(row?.ticketAmount) || 0);
        return {
            id: String(row?._id || row?.id || ''),
            cycleNumber: Number(row?.cycleNumber) > 0 ? Number(row.cycleNumber) : index + 1,
            eligibilityStartDate: toDateKey(row?.eligibilityStartDate),
            eligibilityEndDate: toDateKey(row?.eligibilityEndDate),
            entitlementDays: Number(row?.entitlementDays ?? row?.qualifyingDays) || entitlement,
            qualifyingDays: Number(row?.qualifyingDays ?? row?.entitlementDays) || entitlement,
            leaveSalaryPaymentDate: toDateKey(row?.leaveSalaryPaymentDate || row?.paymentDate),
            leaveSalaryAmount,
            leaveSalary: leaveSalaryAmount,
            ticketPaymentDate: toDateKey(row?.ticketPaymentDate || row?.paymentDate),
            ticketAmount,
            paymentDate: toDateKey(row?.leaveSalaryPaymentDate || row?.paymentDate),
            currency: String(row?.currency || 'AED').trim() || 'AED',
            paymentReference: String(row?.paymentReference || '').trim(),
            paymentStatus,
            verificationStatus,
            status: paymentStatus,
            remarks: String(row?.remarks || '').trim(),
            annualLeaveKey: String(row?.annualLeaveKey || '').trim(),
            includeLeave:
                typeof row?.includeLeave === 'boolean' ? row.includeLeave : leaveSalaryAmount > 0 || ticketAmount <= 0,
            includeTicket:
                typeof row?.includeTicket === 'boolean' ? row.includeTicket : ticketAmount > 0 || leaveSalaryAmount <= 0,
            reduceHistoricalWorkingDays: row?.reduceHistoricalWorkingDays !== false,
            attachment: serializeAttachment(row?.attachment),
            createdBy: row?.createdBy || null,
            createdByName: String(row?.createdByName || ''),
            verifiedBy: row?.verifiedBy || null,
            verifiedByName: String(row?.verifiedByName || ''),
            verifiedAt: row?.verifiedAt || null,
        };
    });
}

function normalizeLeaveSource(value) {
    const raw = String(value || 'manual').trim().toLowerCase();
    if (raw === 'erp' || raw === 'system') return 'system';
    return 'manual';
}

function isSystemLeave(row) {
    return normalizeLeaveSource(row?.source) === 'system';
}

function toHiddenSystemLeave(value) {
    const seen = new Set();
    const out = [];
    for (const row of Array.isArray(value) ? value : []) {
        const leaveType = String(row?.leaveType || '').trim().toLowerCase();
        if (!leaveType) continue;
        const rawFrom = String(row?.fromDate || row?.startDate || '').trim();
        if (rawFrom === '*') {
            const key = `${leaveType}|*|*`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ leaveType, fromDate: '*', toDate: '*' });
            continue;
        }
        const fromDate = toDateKey(rawFrom);
        const toDate = toDateKey(row?.toDate || row?.endDate) || fromDate;
        if (!fromDate) continue;
        const key = `${leaveType}|${fromDate}|${toDate}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ leaveType, fromDate, toDate });
    }
    return out;
}

function isHiddenSystemLeaveRow(row, hidden) {
    const type = String(row?.leaveType || '').trim().toLowerCase();
    const from = toDateKey(row?.fromDate || row?.startDate);
    const to = toDateKey(row?.toDate || row?.endDate) || from;
    if (!type) return false;
    return (hidden || []).some((item) => {
        if (String(item?.leaveType || '').toLowerCase() !== type) return false;
        if (String(item?.fromDate || '') === '*') return true;
        const hideFrom = toDateKey(item?.fromDate);
        const hideTo = toDateKey(item?.toDate) || hideFrom;
        if (!from || !hideFrom) return false;
        return from <= hideTo && to >= hideFrom;
    });
}

function filterHiddenSystemLeave(rows, hidden) {
    const list = toHiddenSystemLeave(hidden);
    if (!list.length) return Array.isArray(rows) ? rows : [];
    return (Array.isArray(rows) ? rows : []).filter((row) => !isHiddenSystemLeaveRow(row, list));
}

function historicalLeaveOnly(rows) {
    return (Array.isArray(rows) ? rows : []).filter((row) => !isSystemLeave(row));
}

function pushAudit(existing, entry) {
    const log = Array.isArray(existing?.auditLog) ? existing.auditLog : [];
    return [{ ...entry, at: new Date() }, ...log].slice(0, 200);
}

async function enrichLeaveWorkingDays(rows, staffType, periodStart, periodEnd, policyMultipliers) {
    const list = toLeaveRows(rows, policyMultipliers);
    const out = [];
    for (const row of list) {
        const dateError = validateLeaveDates(row, periodStart, periodEnd);
        if (dateError && row.status !== 'cancelled' && row.status !== 'rejected') {
            const err = new Error(dateError);
            err.statusCode = 400;
            throw err;
        }
        const hasDates = isDateKey(row.fromDate) && isDateKey(row.toDate);
        const provided = Math.max(0, Number(row.eligibleWorkingDays ?? row.actualDays) || 0);
        let eligible = provided;
        if (hasDates && provided <= 0) {
            const stats = await calcWorkingDays({ from: row.fromDate, to: row.toDate, staffType });
            eligible = stats.workingDays;
        }
        const multiplier = leaveMultiplier(row.leaveType, row.multiplier, policyMultipliers);
        const calendarDays = hasDates ? inclusiveCalendarDays(row.fromDate, row.toDate) : provided;
        out.push({
            ...row,
            calendarDays: calendarDays || provided,
            actualDays: eligible,
            eligibleWorkingDays: eligible,
            multiplier,
            rule: multiplier,
            deductionDays: eligible * multiplier,
            deduction: eligible * multiplier,
        });
    }
    return out;
}

async function enrichAnnualWorkingDays(rows, staffType, periodStart, periodEnd) {
    const list = toAnnualRows(rows);
    const out = [];
    for (const row of list) {
        const dateError = validateLeaveDates(
            {
                leaveType: 'annual',
                fromDate: row.startDate,
                toDate: row.endDate,
                eligibleWorkingDays: row.eligibleWorkingDays,
            },
            periodStart,
            periodEnd,
        );
        if (dateError && row.status !== 'cancelled' && row.status !== 'rejected') {
            const err = new Error(dateError);
            err.statusCode = 400;
            throw err;
        }
        const hasDates = isDateKey(row.startDate) && isDateKey(row.endDate);
        const provided = Math.max(0, Number(row.eligibleWorkingDays ?? row.actualDays) || 0);
        let eligible = provided;
        if (hasDates && provided <= 0) {
            const stats = await calcWorkingDays({ from: row.startDate, to: row.endDate, staffType });
            eligible = stats.workingDays;
        }
        const calendarDays = hasDates ? inclusiveCalendarDays(row.startDate, row.endDate) : provided;
        out.push({
            ...row,
            calendarDays: calendarDays || provided,
            eligibleWorkingDays: eligible,
            actualDays: eligible,
            deductionDays: eligible,
        });
    }
    return out;
}

function combinedLeaveForOverlap(leaveRecords, annualLeaveRecords) {
    return [
        ...toLeaveRows(leaveRecords),
        ...toAnnualRows(annualLeaveRecords).map((row) => ({
            ...row,
            fromDate: row.startDate,
            toDate: row.endDate,
            leaveType: 'annual',
        })),
    ];
}

function validateRecords(leaveRecords, annualLeaveRecords, periodStart, periodEnd) {
    const leave = toLeaveRows(leaveRecords);
    const annual = toAnnualRows(annualLeaveRecords);
    for (const row of leave) {
        if (row.status === 'cancelled' || row.status === 'rejected') continue;
        const error = validateLeaveDates(row, periodStart, periodEnd);
        if (error) return error;
    }
    for (const row of annual) {
        if (row.status === 'cancelled' || row.status === 'rejected') continue;
        const error = validateLeaveDates(
            {
                leaveType: 'annual',
                fromDate: row.startDate,
                toDate: row.endDate,
                eligibleWorkingDays: row.eligibleWorkingDays,
            },
            periodStart,
            periodEnd,
        );
        if (error) return error;
    }
    const overlap = findOverlappingLeave(combinedLeaveForOverlap(leave, annual));
    if (overlap) return MESSAGES.leaveOverlap;
    return '';
}

function mapWorkflow(profile) {
    if (profile?.workflowStatus) return profile.workflowStatus;
    if (profile?.status === 'created') return 'locked';
    return 'draft';
}

async function loadEmployee(employeeId) {
    return EmployeeBasic.findOne({ employeeId })
        .select(
            '_id employeeId firstName lastName status profileStatus designation role department staffType dateOfJoining contractJoiningDate profilePicture primaryReportee reportingAuthority companyEmail company',
        )
        .populate('primaryReportee', 'firstName lastName employeeId')
        .populate('reportingAuthority', 'firstName lastName employeeId companyEmail')
        .populate('company', 'zohoOrganizationId name')
        .lean();
}

async function resolveSubmitterEmail(who) {
    if (who?.id) {
        const user = await User.findById(who.id).select('email employeeId').lean();
        if (user?.email) return String(user.email).trim();
        const code = String(user?.employeeId || who.employeeId || '').trim();
        if (code) {
            const emp = await EmployeeBasic.findOne({ employeeId: code }).select('companyEmail').lean();
            if (emp?.companyEmail) return String(emp.companyEmail).trim();
        }
    }
    if (who?.employeeId) {
        const emp = await EmployeeBasic.findOne({ employeeId: who.employeeId }).select('companyEmail').lean();
        if (emp?.companyEmail) return String(emp.companyEmail).trim();
    }
    return '';
}

export async function buildPayload(req, employeeId, overlay = {}) {
    const employee = await loadEmployee(employeeId);
    if (!employee || isCompanyShellEmployee(employee)) {
        const err = new Error('Employee not found.');
        err.statusCode = 404;
        throw err;
    }

    const canEdit = await userCanEdit(req);
    const canViewSalarySetup = await userCanViewSalarySetup(req);
    const [profile, enrollment, locations, salaryDoc, mainPolicyDoc] = await Promise.all([
        SalaryHistoricalProfile.findOne({ employeeId }).lean(),
        SalaryEnrollment.findOne({ employeeId }).lean(),
        listActiveWorkLocations(),
        EmployeeSalary.findOne({ employeeId }).select('basic basicSalary monthlySalary salaryHistory.basic').lean(),
        PayrollSettings.findOne({ key: 'default' }).select('_id').lean(),
    ]);
    const [policyFromEnrollment, livePolicy] = await Promise.all([
        resolveEmployeePayrollPolicy(employee),
        policyCopyForEmployee(employee),
    ]);
    const policy = withLiveLeaveEntitlements(policyFromEnrollment, livePolicy);

    const staffType = normalizeStaffTypeKey(employee.staffType);
    const workLocationLabel =
        (locations || []).find((row) => row.key === staffType)?.label || staffType;
    const originalJoining = toDateKey(
        profile?.originalContractJoiningDate || employee.contractJoiningDate || employee.dateOfJoining,
    );
    const joiningDate =
        toDateKey(overlay.contractJoiningDate) ||
        toDateKey(profile?.contractJoiningDate) ||
        originalJoining;
    let verpStartDate =
        toDateKey(overlay.verpStartDate) ||
        toDateKey(req.query?.verpStartDate) ||
        toDateKey(profile?.verpStartDate) ||
        '';
    if (!verpStartDate) {
        verpStartDate = verpDateFromEnrollment(enrollment);
        if (
            verpStartDate &&
            profile?._id &&
            !toDateKey(overlay.verpStartDate) &&
            !toDateKey(req.query?.verpStartDate)
        ) {
            await SalaryHistoricalProfile.updateOne(
                {
                    _id: profile._id,
                    $or: [{ verpStartDate: '' }, { verpStartDate: null }, { verpStartDate: { $exists: false } }],
                },
                { $set: { verpStartDate } },
            );
        }
    }
    const period = historicalPeriod(joiningDate, verpStartDate);
    const stats =
        joiningDate && period.end
            ? await calcWorkingDays({
                  from: joiningDate,
                  to: period.end,
                  staffType: employee.staffType,
              })
            : { workingDays: 0, weeklyOffs: 0, holidays: 0, calendarDays: 0 };

    const cycleDays = cycleDaysFromPolicy(policy);
    const leaveMultipliers = policyLeaveMultipliers(policy);
    const leaveRecords = consolidateCountOnlyLeaveRecords(
        historicalLeaveOnly(toLeaveRows(overlay.leaveRecords || profile?.leaveRecords, leaveMultipliers)),
        leaveMultipliers,
    );
    const annualLeaveRecords = historicalLeaveOnly(
        toAnnualRows(overlay.annualLeaveRecords || profile?.annualLeaveRecords),
    );

    const paymentCycles = toCycleRows(overlay.paymentCycles || profile?.paymentCycles, cycleDays);
    const workflowStatus = mapWorkflow(profile);
    const enrolled = Boolean(enrollment) || workflowStatus === 'locked';
    const todayKey = dubaiDateKey();
    const liveAttendance =
        enrolled && isDateKey(verpStartDate)
            ? await loadLiveAttendanceEligibility({
                  employee,
                  from: verpStartDate,
                  to: todayKey >= verpStartDate ? todayKey : '',
                  staffType: employee.staffType,
              })
            : { workingDays: 0, leaveRecords: [], from: '', to: '' };
    const priorSickDaysByYear = {};
    for (const row of leaveRecords || []) {
        if (String(row?.leaveType || '').toLowerCase() !== 'sick') continue;
        const year = String(row.fromDate || row.toDate || '').slice(0, 4);
        if (!/^\d{4}$/.test(year)) continue;
        priorSickDaysByYear[year] =
            (priorSickDaysByYear[year] || 0) + Math.max(1, Number(row.eligibleWorkingDays) || 1);
    }
    const hiddenSystemLeave = toHiddenSystemLeave(
        overlay.hiddenSystemLeave ?? profile?.hiddenSystemLeave,
    );
    liveAttendance.leaveRecords = applySickAllowanceToLeaveRecords(
        filterHiddenSystemLeave(liveAttendance.leaveRecords || [], hiddenSystemLeave),
        leavePolicyEntitlements(policy),
        { priorSickDaysByYear },
    );
    const calculation = calculateHistoricalEligibility({
        workingDays: stats.workingDays + (Number(liveAttendance.workingDays) || 0),
        calendarDays: stats.calendarDays,
        leaveRecords: [...leaveRecords, ...(liveAttendance.leaveRecords || [])],
        annualLeaveRecords,
        paymentCycles,
        cycleDays,
        leaveMultipliers,
    });
    const overlapError = findOverlappingLeave(combinedLeaveForOverlap(leaveRecords, annualLeaveRecords));
    const verpError = verpStartDate ? validateVerpStart(joiningDate, verpStartDate) : '';
    const leaveComplete = Boolean(overlay.leaveHistoryComplete ?? profile?.leaveHistoryComplete);
    const annualComplete = Boolean(overlay.annualLeaveComplete ?? profile?.annualLeaveComplete);
    const benefitsComplete = Boolean(overlay.benefitsComplete ?? profile?.benefitsComplete);
    const verified =
        workflowStatus === 'verified' ||
        workflowStatus === 'locked' ||
        workflowStatus === 'pending_hr';
    const companyMolCode = canViewSalarySetup
        ? String(overlay.companyMolCode ?? profile?.companyMolCode ?? '').trim()
        : '';
    const employeeMolId = canViewSalarySetup
        ? String(overlay.employeeMolId ?? profile?.employeeMolId ?? '').trim()
        : '';
    const salarySlip = Boolean(overlay.salarySlip ?? profile?.salarySlip);
    const readiness = buildReadinessItems({
        joiningDate,
        verpStartDate,
        periodEnd: period.end,
        workingDaysCalculated: Boolean(joiningDate && verpStartDate),
        companyMolCode,
        employeeMolId,
        leaveComplete,
        annualComplete,
        benefitsComplete,
        cyclesVerified: allCyclesVerified(paymentCycles),
        noOverlap: !overlapError,
        noErrors: !verpError,
        verified,
    });

    const isHrApprover = await viewerIsSalaryHr(req);
    const isFlowchartHr = await isUserActiveInFlowchart(req.user, 'hr');
    const employeeOut = serializeEmployee(employee, workLocationLabel);
    employeeOut.profilePicture = await signedProfilePicture(employee.profilePicture);

    return {
        employee: employeeOut,
        enrolled: Boolean(enrollment),
        profileStatus: profile?.status || (enrollment ? 'created' : 'draft'),
        workflowStatus,
        joiningDate,
        originalContractJoiningDate: originalJoining,
        contractJoiningDate: joiningDate,
        verpStartDate,
        companyMolCode,
        employeeMolId,
        salarySlip,
        historicalFrom: period.start,
        historicalTo: period.end,
        calendarDays: stats.calendarDays,
        workingDays: stats.workingDays,
        weeklyOffs: stats.weeklyOffs,
        holidays: stats.holidays,
        liveAttendance: {
            enabled: Boolean(liveAttendance.from),
            from: liveAttendance.from || '',
            to: liveAttendance.to || '',
            workingDays: Number(liveAttendance.workingDays) || 0,
            leaveRecords: liveAttendance.leaveRecords || [],
        },
        leaveRecords,
        annualLeaveRecords,
        hiddenSystemLeave,
        paymentCycles,
        cycleDays,
        employeeLeaveSalary: pickEmployeeLeaveSalary(salaryDoc),
        leaveMultipliers,
        policy,
        leaveHistoryComplete: leaveComplete,
        annualLeaveComplete: annualComplete,
        benefitsComplete: benefitsComplete,
        leaveDeduction: calculation.totalLeaveDeduction,
        netQualifying: calculation.netQualifyingDays,
        paidCycleDays: calculation.consumedEntitlementDays,
        eligibleBalance: calculation.eligibleBalance,
        calculation,
        readiness,
        calculatedAt: new Date().toISOString(),
        verifiedBy: profile?.verifiedByName || '',
        verifiedByDepartment: profile?.verifiedByDepartment || (await resolveVerifierDepartment(profile)),
        verifiedAt: profile?.verifiedAt || null,
        lockedAt: profile?.lockedAt || null,
        reopenReason: profile?.reopenReason || '',
        auditLog: Array.isArray(profile?.auditLog) ? profile.auditLog.slice(0, 50) : [],
        permissions: {
            canEdit: canEditProfile({ workflowStatus, canEdit }),
            canChangeJoiningDate:
                (canEdit && canEditProfile({ workflowStatus, canEdit })) ||
                (isHrApprover && workflowIsLocked(workflowStatus)),
            canVerify: canEdit && ['draft', 'correction', 'reopened'].includes(workflowStatus),
            canCreate: canEdit && readiness.canCreate && workflowStatus === 'verified',
            canApprove: isHrApprover && workflowStatus === 'pending_hr',
            canReject: isHrApprover && workflowStatus === 'pending_hr',
            canRevoke: canEdit && !isHrApprover && workflowStatus === 'pending_hr',
            canReopen: canEdit && workflowIsLocked(workflowStatus),
            canReturn: canEdit && workflowStatus === 'verified',
            canViewAudit: true,
            canViewPayrollCodes: canViewSalarySetup,
            isSalaryHr: isHrApprover,
            canResetEnrollment: Boolean(
                isFlowchartHr && profile && isDateKey(joiningDate) && isDateKey(verpStartDate),
            ),
            mainPolicyConfigured: Boolean(mainPolicyDoc?._id),
        },
        approvalSent: workflowStatus === 'pending_hr',
        submittedByName: profile?.submittedByName || '',
        lastRejectReason: profile?.lastRejectReason || '',
        dmf: serializeDmf(profile?.dmfApproval, {
            ready: false,
            ctx: await buildDmfViewerContext(req),
        }),
        errors: [verpError, overlapError ? MESSAGES.leaveOverlap : ''].filter(Boolean),
    };
}

async function persistRowsAttachments(rows, folder) {
    const list = Array.isArray(rows) ? rows : [];
    const out = [];
    for (const row of list) {
        const attachment = await persistAttachment(row?.attachment, folder);
        const copy = { ...row };
        delete copy.id;
        delete copy._id;
        if (attachment) copy.attachment = attachment;
        else copy.attachment = null;
        out.push(copy);
    }
    return out;
}

async function upsertFromBody(req, employeeId, extra = {}) {
    const existing = await SalaryHistoricalProfile.findOne({ employeeId }).lean();
    const workflowStatus = mapWorkflow(existing);
    const canEdit = await userCanEdit(req);
    const isSalaryHr = await viewerIsSalaryHr(req);
    const isLockedProfile = workflowIsLocked(workflowStatus);
    const body = req.body || {};
    const salarySlipOnly =
        hasBodyField(body, 'salarySlip') &&
        Object.keys(body).every((key) => key === 'salarySlip');

    if (isLockedProfile && !isSalaryHr) {
        const err = new Error(MESSAGES.createdProfileHrOnly);
        err.statusCode = 403;
        throw err;
    }
    if (!isLockedProfile && !canEdit) {
        const err = new Error(MESSAGES.joiningDateHrOnly.replace('contract joining date', 'historical salary setup'));
        err.statusCode = 403;
        throw err;
    }

    if (
        workflowStatus === 'pending_hr' &&
        extra.workflowStatus !== 'verified' &&
        extra.workflowStatus !== 'locked' &&
        extra.workflowStatus !== 'pending_hr'
    ) {
        const err = new Error(MESSAGES.awaitingHrApproval);
        err.statusCode = 403;
        throw err;
    }
    if (workflowIsLocked(workflowStatus) && extra.workflowStatus !== 'reopened' && extra.status !== 'created' && extra.workflowStatus !== 'locked') {
        if (!salarySlipOnly) {
            const err = new Error(MESSAGES.lockedReadOnly);
            err.statusCode = 403;
            throw err;
        }
    }

    const employee = await loadEmployee(employeeId);
    if (!employee || isCompanyShellEmployee(employee)) {
        const err = new Error('Employee not found.');
        err.statusCode = 404;
        throw err;
    }

    const who = actor(req);
    const originalJoining = toDateKey(
        existing?.originalContractJoiningDate || employee.contractJoiningDate || employee.dateOfJoining,
    );
    const nextJoining = toDateKey(body.contractJoiningDate) || originalJoining;
    if (nextJoining !== originalJoining && nextJoining !== toDateKey(existing?.contractJoiningDate)) {
        if (!canEdit && !isSalaryHr) {
            const err = new Error(MESSAGES.joiningDateHrOnly);
            err.statusCode = 403;
            throw err;
        }
        if (!String(body.joiningDateReason || '').trim()) {
            const err = new Error(MESSAGES.joiningReasonRequired);
            err.statusCode = 400;
            throw err;
        }
    }

    const verpStartDate =
        toDateKey(body.verpStartDate) || toDateKey(existing?.verpStartDate) || '';
    const verpError = verpStartDate ? validateVerpStart(nextJoining, verpStartDate) : '';
    if (verpError) {
        const err = new Error(verpError);
        err.statusCode = 400;
        throw err;
    }
    const period = historicalPeriod(nextJoining, verpStartDate);
    const [policyFromEnrollment, livePolicy] = await Promise.all([
        resolveEmployeePayrollPolicy(employee),
        policyCopyForEmployee(employee),
    ]);
    const policy = withLiveLeaveEntitlements(policyFromEnrollment, livePolicy);
    const cycleDays = cycleDaysFromPolicy(policy);

    const leaveRecords = consolidateCountOnlyLeaveRecords(
        await enrichLeaveWorkingDays(
            historicalLeaveOnly(body.leaveRecords || existing?.leaveRecords),
            employee.staffType,
            period.start,
            period.end,
            policyLeaveMultipliers(policy),
        ),
        policyLeaveMultipliers(policy),
    );
    const annualLeaveRecords = await enrichAnnualWorkingDays(
        historicalLeaveOnly(body.annualLeaveRecords || existing?.annualLeaveRecords),
        employee.staffType,
        period.start,
        period.end,
    );
    const recordError = validateRecords(leaveRecords, annualLeaveRecords, period.start, period.end);
    if (recordError) {
        const err = new Error(recordError);
        err.statusCode = 400;
        throw err;
    }

    const paymentCycles = toCycleRows(body.paymentCycles || existing?.paymentCycles, cycleDays);
    const duplicateCycle = findDuplicateConsumingCycles(paymentCycles, cycleDays);
    if (duplicateCycle) {
        const err = new Error(MESSAGES.cycleAlreadyConsumed);
        err.statusCode = 400;
        throw err;
    }
    const folder = `salary-historical/${employeeId}`;
    const [savedLeave, savedAnnual, savedCycles] = await Promise.all([
        persistRowsAttachments(leaveRecords, folder),
        persistRowsAttachments(annualLeaveRecords, folder),
        persistRowsAttachments(paymentCycles, folder),
    ]);

    let auditLog = existing?.auditLog || [];
    if (nextJoining && nextJoining !== toDateKey(existing?.contractJoiningDate || originalJoining)) {
        auditLog = pushAudit(existing, {
            action: 'change_joining_date',
            recordType: 'contract_joining_date',
            previousValue: existing?.contractJoiningDate || originalJoining,
            newValue: nextJoining,
            changedBy: who.id,
            changedByName: who.name,
            reason: String(body.joiningDateReason || '').trim(),
            verificationStatus: workflowStatus,
        });
    }
    if (extra.audit) {
        auditLog = pushAudit({ auditLog }, { ...extra.audit, changedBy: who.id, changedByName: who.name });
    }

    const payload = {
        employeeId,
        verpStartDate,
        contractJoiningDate: nextJoining,
        originalContractJoiningDate: originalJoining,
        companyMolCode: String(
            Object.prototype.hasOwnProperty.call(body, 'companyMolCode')
                ? body.companyMolCode
                : existing?.companyMolCode || '',
        ).trim(),
        employeeMolId: String(
            Object.prototype.hasOwnProperty.call(body, 'employeeMolId')
                ? body.employeeMolId
                : existing?.employeeMolId || '',
        ).trim(),
        salarySlip: hasBodyField(body, 'salarySlip')
            ? Boolean(body.salarySlip)
            : Boolean(existing?.salarySlip),
        leaveRecords: savedLeave,
        annualLeaveRecords: savedAnnual,
        hiddenSystemLeave: hasBodyField(body, 'hiddenSystemLeave')
            ? toHiddenSystemLeave(body.hiddenSystemLeave)
            : toHiddenSystemLeave(existing?.hiddenSystemLeave),
        paymentCycles: savedCycles,
        cycleDays,
        leaveHistoryComplete: hasBodyField(body, 'leaveHistoryComplete')
            ? Boolean(body.leaveHistoryComplete)
            : Boolean(existing?.leaveHistoryComplete),
        annualLeaveComplete: hasBodyField(body, 'annualLeaveComplete')
            ? Boolean(body.annualLeaveComplete)
            : Boolean(existing?.annualLeaveComplete),
        benefitsComplete: hasBodyField(body, 'benefitsComplete')
            ? Boolean(body.benefitsComplete)
            : Boolean(existing?.benefitsComplete),
        auditLog,
        updatedBy: who.id || null,
        ...extra,
    };
    delete payload.audit;
    if (!existing) payload.createdBy = who.id || null;
    if (salarySlipOnly && isLockedProfile) {
        payload.workflowStatus = existing.workflowStatus || 'locked';
        payload.status = existing.status || 'created';
    } else if (!extra.workflowStatus) {
        if (workflowStatus === 'verified') payload.workflowStatus = 'draft';
        else if (workflowStatus === 'reopened' || workflowStatus === 'correction') {
            payload.workflowStatus = workflowStatus;
        } else {
            payload.workflowStatus = 'draft';
        }
        if (!extra.status) payload.status = 'draft';
    }
    if (existing?.status === 'created' && extra.status !== 'created') {
        payload.status = 'created';
        if (!extra.workflowStatus) {
            payload.workflowStatus = existing.workflowStatus || 'locked';
        }
    }

    await SalaryHistoricalProfile.findOneAndUpdate(
        { employeeId },
        { $set: payload },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}

export async function getSalaryHistoricalProfile(req, res) {
    try {
        const employeeId = String(req.params?.employeeId || '').trim();
        if (!employeeId) return res.status(400).json({ message: 'Employee is required.' });
        const payload = await buildPayload(req, employeeId);
        return res.status(200).json(payload);
    } catch (error) {
        console.error('[getSalaryHistoricalProfile]', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Failed to load historical salary setup.',
        });
    }
}

export async function saveSalaryHistoricalProfile(req, res) {
    try {
        const employeeId = String(req.params?.employeeId || '').trim();
        if (!employeeId) return res.status(400).json({ message: 'Employee is required.' });
        const who = actor(req);
        const existing = await SalaryHistoricalProfile.findOne({ employeeId }).lean();
        const workflowStatus = mapWorkflow(existing);
        const keepLocked = workflowIsLocked(workflowStatus);
        await upsertFromBody(req, employeeId, {
            ...(keepLocked
                ? {
                      workflowStatus: existing?.workflowStatus || 'locked',
                      status: existing?.status || 'created',
                  }
                : {}),
            audit: {
                action: keepLocked ? 'update' : 'save_draft',
                recordType: 'historical_profile',
                previousValue: null,
                newValue: keepLocked ? 'updated' : 'draft',
                reason: String(req.body?.reason || '').trim(),
                verificationStatus: keepLocked ? workflowStatus : 'draft',
                changedBy: who.id,
                changedByName: who.name,
            },
        });
        if (keepLocked) {
            const [profile, employee] = await Promise.all([
                SalaryHistoricalProfile.findOne({ employeeId }).lean(),
                loadEmployee(employeeId),
            ]);
            if (profile && employee && !isCompanyShellEmployee(employee)) {
                await applySalaryEnrollmentFromProfile({ employee, profile, employeeId, who });
            }
        }
        const payload = await buildPayload(req, employeeId, { skipImport: true, ...req.body });
        return res.status(200).json(payload);
    } catch (error) {
        console.error('[saveSalaryHistoricalProfile]', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Failed to save draft.',
        });
    }
}

export async function verifySalaryHistoricalProfile(req, res) {
    try {
        const employeeId = String(req.params?.employeeId || '').trim();
        if (!employeeId) return res.status(400).json({ message: 'Employee is required.' });
        if (!(await userCanEdit(req))) {
            return res.status(403).json({ message: MESSAGES.joiningDateHrOnly.replace('modify the contract joining date', 'verify historical data') });
        }
        const who = actor(req);
        await upsertFromBody(req, employeeId);
        const preview = await buildPayload(req, employeeId, { skipImport: true, ...req.body });
        if (!preview.readiness?.canVerify) {
            return res.status(400).json({
                message: MESSAGES.completeBeforeCreate,
                readiness: preview.readiness,
            });
        }
        await SalaryHistoricalProfile.findOneAndUpdate(
            { employeeId },
            {
                $set: {
                    workflowStatus: 'verified',
                    status: 'draft',
                    verifiedBy: who.id,
                    verifiedByName: who.name,
                    verifiedByDepartment: (await EmployeeBasic.findOne({ employeeId: who.employeeId }).select('department').lean())?.department || '',
                    verifiedAt: new Date(),
                    updatedBy: who.id,
                    auditLog: pushAudit(preview, {
                        action: 'verify',
                        recordType: 'historical_profile',
                        previousValue: preview.workflowStatus,
                        newValue: 'verified',
                        changedBy: who.id,
                        changedByName: who.name,
                        reason: String(req.body?.reason || '').trim(),
                        verificationStatus: 'verified',
                    }),
                },
            },
        );
        return res.status(200).json(await buildPayload(req, employeeId, { skipImport: true }));
    } catch (error) {
        console.error('[verifySalaryHistoricalProfile]', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Failed to verify historical data.',
        });
    }
}

export async function returnSalaryHistoricalProfile(req, res) {
    try {
        const employeeId = String(req.params?.employeeId || '').trim();
        if (!employeeId) return res.status(400).json({ message: 'Employee is required.' });
        if (!(await userCanEdit(req))) {
            return res.status(403).json({ message: 'Only an authorized HR user can return this profile for correction.' });
        }
        const who = actor(req);
        await upsertFromBody(req, employeeId, {
            workflowStatus: 'correction',
            status: 'draft',
            verifiedBy: null,
            verifiedByName: '',
            verifiedAt: null,
            audit: {
                action: 'return_for_correction',
                recordType: 'historical_profile',
                previousValue: 'verified',
                newValue: 'correction',
                reason: String(req.body?.reason || '').trim(),
                verificationStatus: 'correction',
                changedBy: who.id,
                changedByName: who.name,
            },
        });
        return res.status(200).json(await buildPayload(req, employeeId, { skipImport: true }));
    } catch (error) {
        console.error('[returnSalaryHistoricalProfile]', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Failed to return profile for correction.',
        });
    }
}

export async function reopenSalaryHistoricalProfile(req, res) {
    try {
        const employeeId = String(req.params?.employeeId || '').trim();
        if (!employeeId) return res.status(400).json({ message: 'Employee is required.' });
        if (!(await userCanEdit(req))) {
            return res.status(403).json({ message: MESSAGES.joiningDateHrOnly.replace('modify the contract joining date', 'reopen a locked historical profile') });
        }
        const reason = String(req.body?.reason || req.body?.reopenReason || '').trim();
        if (!reason) {
            return res.status(400).json({ message: MESSAGES.reopenReasonRequired });
        }
        const existing = await SalaryHistoricalProfile.findOne({ employeeId }).lean();
        const workflowStatus = mapWorkflow(existing);
        if (!workflowIsLocked(workflowStatus)) {
            return res.status(400).json({ message: 'Only a locked historical profile can be reopened.' });
        }
        const who = actor(req);
        await SalaryHistoricalProfile.findOneAndUpdate(
            { employeeId },
            {
                $set: {
                    workflowStatus: 'reopened',
                    status: 'draft',
                    reopenedBy: who.id,
                    reopenedByName: who.name,
                    reopenedAt: new Date(),
                    reopenReason: reason,
                    updatedBy: who.id,
                    auditLog: pushAudit(existing, {
                        action: 'reopen',
                        recordType: 'historical_profile',
                        previousValue: 'locked',
                        newValue: 'reopened',
                        changedBy: who.id,
                        changedByName: who.name,
                        reason,
                        verificationStatus: 'reopened',
                    }),
                },
            },
        );
        return res.status(200).json(await buildPayload(req, employeeId, { skipImport: true }));
    } catch (error) {
        console.error('[reopenSalaryHistoricalProfile]', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Failed to reopen historical profile.',
        });
    }
}

function asPlainEnrollmentRows(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => {
        const obj = row?.toObject ? row.toObject() : { ...row };
        delete obj.__v;
        return obj;
    });
}

export async function resetSalaryHistoricalEnrollment(req, res) {
    try {
        const employeeId = String(req.params?.employeeId || '').trim();
        if (!employeeId) return res.status(400).json({ message: 'Employee is required.' });
        if (!(await isUserActiveInFlowchart(req.user, 'hr'))) {
            return res.status(403).json({ message: 'Only flowchart HR can reset enrolment.' });
        }
        await verifyFlowchartHrUserPassword(req.body?.password);

        const employee = await loadEmployee(employeeId);
        if (!employee || isCompanyShellEmployee(employee)) {
            return res.status(404).json({ message: 'Employee not found.' });
        }

        const existing = await SalaryHistoricalProfile.findOne({ employeeId }).lean();
        if (!existing) {
            return res.status(400).json({ message: 'No salary enrolment profile to reset.' });
        }

        const joiningDate = toDateKey(existing.contractJoiningDate);
        const verpStartDate = toDateKey(existing.verpStartDate);
        const period = historicalPeriod(joiningDate, verpStartDate);
        if (!period.start || !period.end || period.calendarDays <= 0) {
            return res.status(400).json({
                message:
                    'Contract joining date and VERP salary processing date are required to reset enrolment.',
            });
        }

        const leaveSplit = partitionEnrollmentRows(
            (existing.leaveRecords || []).filter((row) => !isSystemLeave(row)),
            period,
            leaveRecordPeriodRange,
        );
        const keptSystemLeave = (existing.leaveRecords || []).filter((row) => isSystemLeave(row));
        const annualSplit = partitionEnrollmentRows(
            existing.annualLeaveRecords,
            period,
            annualLeavePeriodRange,
        );
        const cycleSplit = partitionEnrollmentRows(
            existing.paymentCycles,
            period,
            paymentCyclePeriodRange,
        );
        const archivedCount =
            leaveSplit.archived.length + annualSplit.archived.length + cycleSplit.archived.length;
        if (archivedCount === 0) {
            return res.status(400).json({
                message:
                    'No enrolment details found between the contract joining date and VERP salary processing date.',
            });
        }

        const employeeName = personName(employee) || employeeId;
        const archiveTitle = `${employeeName} enrol details`;
        const snapshot = {
            employeeId,
            employeeName,
            period,
            contractJoiningDate: joiningDate,
            verpStartDate,
            leaveRecords: asPlainEnrollmentRows(leaveSplit.archived),
            annualLeaveRecords: asPlainEnrollmentRows(annualSplit.archived),
            paymentCycles: asPlainEnrollmentRows(cycleSplit.archived),
            leaveHistoryComplete: Boolean(existing.leaveHistoryComplete),
            annualLeaveComplete: Boolean(existing.annualLeaveComplete),
            benefitsComplete: Boolean(existing.benefitsComplete),
        };

        const archive = await awaitAdminDeletionArchive(req, {
            moduleName: archiveTitle,
            recordId: employeeId,
            details: `${joiningDate} — ${period.end}`,
            deletedPayload: snapshot,
            skipManagementEmail: true,
            retentionDays: SALARY_ENROLLMENT_RESET_RETENTION_DAYS,
            archive: {
                topModule: 'employees',
                category: 'salary',
                entityType: 'salary_enrollment_reset',
                title: archiveTitle,
                subtitle: employeeId,
                details: `Enrolment ${joiningDate} — ${period.end}`,
                parentRef: { employeeId },
                restoreDescriptor: { type: 'salary_enrollment_reset', employeeId },
            },
        });
        if (!archive?._id) {
            return res.status(500).json({
                message: 'Could not archive enrolment details. Reset was cancelled.',
            });
        }

        const who = actor(req);
        await SalaryHistoricalProfile.findOneAndUpdate(
            { employeeId },
            {
                $set: {
                    leaveRecords: [...keptSystemLeave, ...leaveSplit.kept],
                    annualLeaveRecords: annualSplit.kept,
                    paymentCycles: cycleSplit.kept,
                    leaveHistoryComplete: leaveSplit.archived.length
                        ? false
                        : existing.leaveHistoryComplete,
                    annualLeaveComplete: annualSplit.archived.length
                        ? false
                        : existing.annualLeaveComplete,
                    benefitsComplete: cycleSplit.archived.length
                        ? false
                        : existing.benefitsComplete,
                    updatedBy: who.id,
                    auditLog: pushAudit(existing, {
                        action: 'reset_enrollment',
                        recordType: 'historical_profile',
                        previousValue: `${joiningDate} — ${period.end}`,
                        newValue: archiveTitle,
                        changedBy: who.id,
                        changedByName: who.name,
                        reason: 'Reset enrolment',
                        verificationStatus: mapWorkflow(existing),
                    }),
                },
            },
        );

        await notifyManagementSalaryEnrollmentReset({
            req,
            employeeName,
            employeeId,
            period,
            archiveId: archive._id,
            resetByName: who.name,
        });

        return res.status(200).json({
            ...(await buildPayload(req, employeeId, { skipImport: true })),
            message: `Enrolment details were moved to Deleted Records for ${SALARY_ENROLLMENT_RESET_RETENTION_DAYS} days.`,
            archiveId: String(archive._id),
        });
    } catch (error) {
        console.error('[resetSalaryHistoricalEnrollment]', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Failed to reset enrolment.',
        });
    }
}

export async function getSalaryHistoricalAudit(req, res) {
    try {
        const employeeId = String(req.params?.employeeId || '').trim();
        if (!employeeId) return res.status(400).json({ message: 'Employee is required.' });
        const profile = await SalaryHistoricalProfile.findOne({ employeeId }).select('auditLog employeeId').lean();
        return res.status(200).json({
            employeeId,
            auditLog: Array.isArray(profile?.auditLog) ? profile.auditLog : [],
        });
    } catch (error) {
        console.error('[getSalaryHistoricalAudit]', error);
        return res.status(500).json({ message: error.message || 'Failed to load audit history.' });
    }
}

async function applySalaryEnrollmentFromProfile({ employee, profile, employeeId, who }) {
    const verpStartDate = toDateKey(profile?.verpStartDate);
    if (!verpStartDate) {
        const err = new Error('VERP salary processing start date is required.');
        err.statusCode = 400;
        throw err;
    }
    const fromMonth = verpStartDate.slice(0, 7);
    const salaryDay = String(Math.min(28, Math.max(1, Number(verpStartDate.slice(8, 10)) || 1)));
    let enrollment = await SalaryEnrollment.findOne({ employeeId });
    if (!enrollment) {
        const policy = await policyCopyForEmployee(employee, salaryDay);
        enrollment = await SalaryEnrollment.create({
            employeeId,
            fromMonth,
            salaryDate: salaryDay,
            processDate: salaryDay,
            policy,
            enrolledBy: who.id || null,
        });
    } else {
        enrollment.fromMonth = fromMonth;
        enrollment.salaryDate = salaryDay;
        enrollment.processDate = salaryDay;
        await enrollment.save();
    }
    return enrollment;
}

async function lockAndEnrollSalaryProfile({
    employeeId,
    employee,
    who,
    existing,
    auditAction,
    previousValue,
    reason = '',
}) {
    await SalaryHistoricalProfile.findOneAndUpdate(
        { employeeId },
        {
            $set: {
                status: 'created',
                workflowStatus: 'locked',
                createdProfileAt: existing?.createdProfileAt || new Date(),
                lockedBy: who.id,
                lockedByName: who.name,
                lockedAt: new Date(),
                lastRejectReason: '',
                updatedBy: who.id,
                auditLog: pushAudit(existing, {
                    action: auditAction,
                    recordType: 'historical_profile',
                    previousValue,
                    newValue: 'locked',
                    changedBy: who.id,
                    changedByName: who.name,
                    reason,
                    verificationStatus: 'locked',
                }),
            },
        },
    );
    const profile = await SalaryHistoricalProfile.findOne({ employeeId }).lean();
    await applySalaryEnrollmentFromProfile({ employee, profile, employeeId, who });
    return profile;
}

export async function createSalaryHistoricalProfile(req, res) {
    try {
        const employeeId = String(req.params?.employeeId || '').trim();
        if (!employeeId) return res.status(400).json({ message: 'Employee is required.' });
        if (!(await userCanEdit(req))) {
            return res.status(403).json({ message: 'Only an authorized HR user can create a salary profile.' });
        }
        await requireMainSalaryPolicy();

        const employee = await loadEmployee(employeeId);
        if (!employee || isCompanyShellEmployee(employee)) {
            return res.status(404).json({ message: 'Employee not found.' });
        }
        if (String(employee.status || '') === 'Left User') {
            return res.status(400).json({ message: 'Left users cannot be enrolled to salary.' });
        }

        req.body = req.body || {};
        const who = actor(req);
        const existing = await SalaryHistoricalProfile.findOne({ employeeId }).lean();
        const workflowStatus = mapWorkflow(existing);
        if (workflowStatus === 'pending_hr') {
            return res.status(400).json({ message: MESSAGES.alreadyAwaitingHr });
        }
        if (workflowStatus !== 'verified') {
            return res.status(400).json({ message: MESSAGES.completeBeforeCreate });
        }

        const isSalaryHr = await viewerIsSalaryHr(req);
        let hrResolved = null;
        if (!isSalaryHr) {
            hrResolved = await resolveFlowchartHrEmployee();
            if (hrResolved.error) {
                return res.status(400).json({ message: hrResolved.message });
            }
        }

        const keepCreated = existing?.status === 'created';
        await upsertFromBody(req, employeeId, {
            workflowStatus: 'verified',
            status: keepCreated ? 'created' : 'draft',
        });
        const preview = await buildPayload(req, employeeId, { skipImport: true, ...req.body });
        if (!preview.readiness?.canCreate) {
            return res.status(400).json({ message: MESSAGES.completeBeforeCreate, readiness: preview.readiness });
        }

        const verpStartDate = toDateKey(req.body.verpStartDate || preview.verpStartDate);
        if (!verpStartDate) {
            return res.status(400).json({ message: 'VERP salary processing start date is required.' });
        }

        if (isSalaryHr) {
            const latest = await SalaryHistoricalProfile.findOne({ employeeId }).lean();
            await lockAndEnrollSalaryProfile({
                employeeId,
                employee,
                who,
                existing: latest,
                auditAction: 'create_salary_profile',
                previousValue: 'verified',
                reason: String(req.body?.reason || '').trim(),
            });
            return res.status(200).json(await buildPayload(req, employeeId, { skipImport: true }));
        }

        const submitterEmail = await resolveSubmitterEmail(who);
        await upsertFromBody(req, employeeId, {
            status: keepCreated ? 'created' : 'draft',
            workflowStatus: 'pending_hr',
            submittedTo: hrResolved.employee._id,
            submittedBy: who.id,
            submittedByName: who.name,
            submittedByEmail: submitterEmail,
            submittedAt: new Date(),
            lastRejectReason: '',
            audit: {
                action: 'submit_salary_profile',
                recordType: 'historical_profile',
                previousValue: 'verified',
                newValue: 'pending_hr',
                reason: String(req.body?.reason || '').trim(),
                verificationStatus: 'pending_hr',
            },
        });

        const profile = await SalaryHistoricalProfile.findOne({ employeeId }).lean();
        try {
            await notifySalaryEnrollmentSubmitted({
                req,
                profile,
                employee,
                hrEmployee: hrResolved.employee,
                hrEmail: hrResolved.email,
                submittedByName: who.name,
            });
        } catch (notifyError) {
            console.error('[createSalaryHistoricalProfile] notify failed:', notifyError);
        }

        return res.status(200).json(await buildPayload(req, employeeId, { skipImport: true }));
    } catch (error) {
        if (error?.code === 11000) {
            return res.status(409).json({ message: 'This employee is already enrolled.' });
        }
        console.error('[createSalaryHistoricalProfile]', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Failed to create salary profile.',
        });
    }
}

export async function approveSalaryHistoricalProfile(req, res) {
    try {
        const employeeId = String(req.params?.employeeId || '').trim();
        if (!employeeId) return res.status(400).json({ message: 'Employee is required.' });
        if (!(await viewerIsSalaryHr(req))) {
            return res.status(403).json({ message: 'Only flowchart HR can approve a salary profile.' });
        }
        await requireMainSalaryPolicy();

        const employee = await loadEmployee(employeeId);
        if (!employee || isCompanyShellEmployee(employee)) {
            return res.status(404).json({ message: 'Employee not found.' });
        }

        const existing = await SalaryHistoricalProfile.findOne({ employeeId }).lean();
        if (mapWorkflow(existing) !== 'pending_hr') {
            return res.status(400).json({ message: MESSAGES.notAwaitingHr });
        }

        const who = actor(req);
        const creatorEmail = String(existing.submittedByEmail || '').trim() || (await resolveSubmitterEmail({
            id: existing.submittedBy,
            employeeId: '',
        }));
        const creatorName = existing.submittedByName || 'there';

        await lockAndEnrollSalaryProfile({
            employeeId,
            employee,
            who,
            existing,
            auditAction: 'approve_salary_profile',
            previousValue: 'pending_hr',
            reason: String(req.body?.reason || '').trim(),
        });

        try {
            await closeSalaryEnrollmentInbox({
                profile: existing,
                status: 'Approved',
                actionedBy: who.id,
                comment: 'Salary profile approved',
            });
        } catch (inboxError) {
            console.error('[approveSalaryHistoricalProfile] inbox close failed:', inboxError);
        }
        emailCreatorSalaryApproved({
            creatorEmail,
            creatorName,
            employee,
        });

        return res.status(200).json(await buildPayload(req, employeeId, { skipImport: true }));
    } catch (error) {
        if (error?.code === 11000) {
            return res.status(409).json({ message: 'This employee is already enrolled.' });
        }
        console.error('[approveSalaryHistoricalProfile]', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Failed to approve salary profile.',
        });
    }
}

export async function rejectSalaryHistoricalProfile(req, res) {
    try {
        const employeeId = String(req.params?.employeeId || '').trim();
        if (!employeeId) return res.status(400).json({ message: 'Employee is required.' });
        if (!(await viewerIsSalaryHr(req))) {
            return res.status(403).json({ message: 'Only flowchart HR can reject a salary profile.' });
        }

        const reason = String(req.body?.reason || req.body?.rejectReason || '').trim();
        if (!reason) {
            return res.status(400).json({ message: MESSAGES.rejectReasonRequired });
        }

        const employee = await loadEmployee(employeeId);
        if (!employee || isCompanyShellEmployee(employee)) {
            return res.status(404).json({ message: 'Employee not found.' });
        }

        const existing = await SalaryHistoricalProfile.findOne({ employeeId }).lean();
        if (mapWorkflow(existing) !== 'pending_hr') {
            return res.status(400).json({ message: MESSAGES.notAwaitingHr });
        }

        const who = actor(req);
        await SalaryHistoricalProfile.findOneAndUpdate(
            { employeeId },
            {
                $set: {
                    workflowStatus: 'verified',
                    status: existing.status === 'created' ? 'created' : 'draft',
                    lastRejectReason: reason,
                    updatedBy: who.id,
                    auditLog: pushAudit(existing, {
                        action: 'reject_salary_profile',
                        recordType: 'historical_profile',
                        previousValue: 'pending_hr',
                        newValue: 'verified',
                        changedBy: who.id,
                        changedByName: who.name,
                        reason,
                        verificationStatus: 'verified',
                    }),
                },
            },
        );

        try {
            await closeSalaryEnrollmentInbox({
                profile: existing,
                status: 'Rejected',
                actionedBy: who.id,
                comment: reason,
            });
        } catch (inboxError) {
            console.error('[rejectSalaryHistoricalProfile] inbox close failed:', inboxError);
        }
        emailEmployeeSalaryRejected({
            employee,
            reason,
            submittedByName: who.name,
        });

        return res.status(200).json(await buildPayload(req, employeeId, { skipImport: true }));
    } catch (error) {
        console.error('[rejectSalaryHistoricalProfile]', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Failed to reject salary profile.',
        });
    }
}

export async function revokeSalaryHistoricalProfile(req, res) {
    try {
        const employeeId = String(req.params?.employeeId || '').trim();
        if (!employeeId) return res.status(400).json({ message: 'Employee is required.' });
        if (!(await userCanEdit(req))) {
            return res.status(403).json({ message: 'Only the user who sent this request can revoke it.' });
        }
        if (await viewerIsSalaryHr(req)) {
            return res.status(403).json({
                message: 'Flowchart HR can approve or reject this request instead of revoking it.',
            });
        }

        const employee = await loadEmployee(employeeId);
        if (!employee || isCompanyShellEmployee(employee)) {
            return res.status(404).json({ message: 'Employee not found.' });
        }

        const existing = await SalaryHistoricalProfile.findOne({ employeeId }).lean();
        if (mapWorkflow(existing) !== 'pending_hr') {
            return res.status(400).json({ message: MESSAGES.notAwaitingHr });
        }

        const who = actor(req);
        await SalaryHistoricalProfile.findOneAndUpdate(
            { employeeId },
            {
                $set: {
                    workflowStatus: 'verified',
                    status: existing.status === 'created' ? 'created' : 'draft',
                    submittedTo: null,
                    submittedBy: null,
                    submittedByName: '',
                    submittedByEmail: '',
                    submittedAt: null,
                    lastRejectReason: '',
                    updatedBy: who.id,
                    auditLog: pushAudit(existing, {
                        action: 'revoke_salary_profile',
                        recordType: 'historical_profile',
                        previousValue: 'pending_hr',
                        newValue: 'verified',
                        changedBy: who.id,
                        changedByName: who.name,
                        reason: String(req.body?.reason || '').trim() || 'Request revoked by sender',
                        verificationStatus: 'verified',
                    }),
                },
            },
        );

        try {
            await closeSalaryEnrollmentInbox({
                profile: existing,
                status: 'Dismissed',
                actionedBy: who.id,
                comment: `Enrolment approval revoked by ${who.name || 'user'}`,
            });
        } catch (inboxError) {
            console.error('[revokeSalaryHistoricalProfile] inbox close failed:', inboxError);
        }

        try {
            const hrResolved = await resolveFlowchartHrEmployee();
            if (!hrResolved.error && hrResolved.email) {
                emailHrSalaryEnrollmentRevoked({
                    req,
                    employee,
                    hrEmployee: hrResolved.employee,
                    hrEmail: hrResolved.email,
                    revokedByName: who.name,
                });
            }
        } catch (emailError) {
            console.error('[revokeSalaryHistoricalProfile] email failed:', emailError);
        }

        return res.status(200).json(await buildPayload(req, employeeId, { skipImport: true }));
    } catch (error) {
        console.error('[revokeSalaryHistoricalProfile]', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Failed to revoke enrolment request.',
        });
    }
}
