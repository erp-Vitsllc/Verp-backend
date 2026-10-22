import mongoose from 'mongoose';
import EmployeeBasic from '../models/EmployeeBasic.js';
import DashboardAction from '../models/DashboardAction.js';
import { syncDashboardAction } from './syncDashboard.js';
import { sendAttendanceLeaveRequestEmail } from './sendAttendanceLeaveEmails.js';
import { resolveFlowchartHrEmployee } from './resolveFlowchartHrEmployee.js';
import { LEAVE_STAGE_HR, LEAVE_STAGE_REPORTEE } from './leaveRequestApproval.js';
import { normalizeStaffTypeKey } from './workLocationHelpers.js';

export const LEAVE_DASHBOARD_REQUEST_TYPE = 'Employee Leave Request';

export const LEAVE_DASHBOARD_KINDS = new Set(['leave', 'future_leave', 'future_annual']);

export const LEAVE_DASHBOARD_STATUS_KEYS = new Set([
    'sick_leave',
    'on_leave',
    'authorized_leave',
    'unauthorized_leave',
    'compoff_leave',
]);

export function isLeaveDashboardAttendanceRow(row) {
    const kind = String(row?.leaveRequestKind || '').trim();
    if (LEAVE_DASHBOARD_KINDS.has(kind)) return true;
    if (kind === 'yellow' || kind === 'future_late' || kind === 'future_early') return false;
    return LEAVE_DASHBOARD_STATUS_KEYS.has(String(row?.requestedStatusKey || '').trim());
}

export function leaveDashboardRequestObjectId(groupId, attendanceId) {
    const group = String(groupId || '').trim();
    if (group && mongoose.Types.ObjectId.isValid(group)) return group;
    return attendanceId;
}

export function leaveDashboardReviewPath({
    from,
    to,
    attendanceId,
    requestedStatusKey = '',
    staffType = '',
    employeeMongoId = '',
    employeeName = '',
} = {}) {
    const group = normalizeStaffTypeKey(staffType) || 'office';
    const person = String(employeeMongoId || '').trim();
    if (String(requestedStatusKey || '') === 'sick_leave') {
        const params = new URLSearchParams();
        if (from) params.set('date', from);
        params.set('staffType', group);
        params.set('group', group);
        if (person) params.set('blinkEmployee', person);
        if (attendanceId) params.set('leaveAttendanceId', String(attendanceId));
        return `/HRM/Attendance/mark?${params.toString()}`;
    }
    const params = new URLSearchParams();
    if (person) params.set('employeeId', person);
    if (employeeName) params.set('employeeName', employeeName);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    params.set('group', group);
    if (attendanceId) params.set('approvalId', String(attendanceId));
    return `/HRM/Leave/annual-leave?${params.toString()}`;
}

async function mailIdsForRequest({ requestId, requestType }) {
    if (requestId && requestType) {
        const row = await DashboardAction.findOne({ requestId, requestType })
            .sort({ updatedAt: -1 })
            .select('_id')
            .lean();
        if (row?._id) return [String(row._id)];
    }
    return [requestId];
}

function personName(person) {
    return [person?.firstName, person?.lastName].filter(Boolean).join(' ').trim() || 'Employee';
}

async function resolveLeaveReceiver(person) {
    if (!person) return null;
    if (person._id && (person.firstName || person.lastName || person.employeeId || person.email)) return person;
    const id = person._id || person;
    if (!mongoose.Types.ObjectId.isValid(String(id))) return null;
    return EmployeeBasic.findById(id)
        .select('_id employeeId firstName lastName companyEmail workEmail email')
        .lean();
}

export async function notifyLeaveRequestApprover({
    employee,
    approver,
    stage = LEAVE_STAGE_REPORTEE,
    from,
    to,
    attendanceId,
    groupId = '',
    requestedLabel,
    requestedStatusKey = '',
    leaveRequestKind = 'leave',
    reason = '',
    attachmentName = '',
}) {
    const receiver = await resolveLeaveReceiver(approver);
    if (!receiver?._id) {
        console.warn('[LeaveNotify] No approver for leave request.');
        return null;
    }

    const start = String(from || '').trim();
    const end = String(to || start).trim();
    const rangeLabel = start && end && start !== end ? `${start} → ${end}` : start || end;
    const empName = personName(employee);
    const label = String(requestedLabel || 'Leave').trim() || 'Leave';
    const requestId = leaveDashboardRequestObjectId(groupId, attendanceId);
    const hrStep = stage === LEAVE_STAGE_HR;
    const waitingLabel = hrStep ? 'Pending with HR' : 'Pending with primary reportee';
    const staffType = normalizeStaffTypeKey(employee?.staffType) || 'office';
    const sickLeave = String(requestedStatusKey || '') === 'sick_leave';

    await syncDashboardAction({
        requestId,
        requestType: LEAVE_DASHBOARD_REQUEST_TYPE,
        assignedTo: receiver._id,
        status: 'Pending',
        subjectEmployee: employee,
        requestedByName: empName,
        extra1: start,
        extra2: `${label} request for ${rangeLabel}`,
        extra3: JSON.stringify({
            attendanceId: String(attendanceId || ''),
            employeeMongoId: String(employee?._id || ''),
            from: start,
            to: end,
            requestedStatusKey,
            staffType,
            leaveRequestKind,
            leaveRequestGroupId: String(groupId || ''),
            leaveDashboard: true,
            approvalStage: hrStep ? LEAVE_STAGE_HR : LEAVE_STAGE_REPORTEE,
        }),
    });

    await sendAttendanceLeaveRequestEmail({
        manager: receiver,
        employee,
        date: start,
        dateLabel: rangeLabel,
        requestedLabel: label,
        currentLabel: waitingLabel,
        reason,
        kind: leaveRequestKind,
        attachmentName,
        reviewPath: leaveDashboardReviewPath({
            from: start,
            to: end,
            attendanceId,
            requestedStatusKey,
            staffType,
            employeeMongoId: employee?._id,
            employeeName: empName,
        }),
        buttonLabel: sickLeave ? 'Open attendance' : 'Open Leave Approval',
        emailTitle: hrStep ? `${label} — HR approval` : `${label} Request`,
        recordIds: await mailIdsForRequest({
            requestId,
            requestType: LEAVE_DASHBOARD_REQUEST_TYPE,
        }),
    });

    return receiver;
}

export async function notifyPrimaryReporteeOfLeaveRequest(payload) {
    return notifyLeaveRequestApprover({
        ...payload,
        approver: payload?.approver || payload?.manager || payload?.employee?.primaryReportee,
        stage: payload?.stage || LEAVE_STAGE_REPORTEE,
    });
}

export async function notifyFlowchartHrOfIneligibleAnnualLeave({
    employee,
    from,
    to,
    attendanceId,
    groupId = '',
    requestedLabel = 'Annual Leave',
    requestedStatusKey = 'on_leave',
    leaveRequestKind = 'future_annual',
    reason = '',
    eligibleDays = 0,
    requiredDays = 0,
    extraNote = '',
} = {}) {
    const resolved = await resolveFlowchartHrEmployee();
    const hr = resolved?.employee;
    if (!hr?._id) {
        console.warn('[LeaveNotify] No designated Flowchart HR for ineligible annual leave.');
        return;
    }

    const start = String(from || '').trim();
    const end = String(to || start).trim();
    const rangeLabel = start && end && start !== end ? `${start} → ${end}` : start || end;
    const empName = personName(employee);
    const label = String(requestedLabel || 'Annual Leave').trim() || 'Annual Leave';
    const requestId = leaveDashboardRequestObjectId(groupId, attendanceId);
    const eligibilityNote =
        String(extraNote || '').trim() ||
        `Not eligible for leave (${eligibleDays}/${requiredDays} days).`;

    await syncDashboardAction({
        requestId,
        requestType: LEAVE_DASHBOARD_REQUEST_TYPE,
        assignedTo: hr._id,
        status: 'Pending',
        subjectEmployee: employee,
        requestedByName: empName,
        extra1: start,
        extra2: `${label} request for ${rangeLabel} · ${eligibilityNote}`,
        extra3: JSON.stringify({
            attendanceId: String(attendanceId || ''),
            employeeMongoId: String(employee?._id || ''),
            from: start,
            to: end,
            requestedStatusKey,
            staffType: normalizeStaffTypeKey(employee?.staffType) || 'office',
            leaveRequestKind,
            leaveRequestGroupId: String(groupId || ''),
            leaveDashboard: true,
            approvalStage: LEAVE_STAGE_HR,
            annualLeaveNotEligible: true,
        }),
    });

    await sendAttendanceLeaveRequestEmail({
        manager: hr,
        employee,
        date: start,
        dateLabel: rangeLabel,
        requestedLabel: label,
        currentLabel: 'Pending HR review',
        reason: [reason, eligibilityNote].filter(Boolean).join(' '),
        kind: leaveRequestKind,
        reviewPath: leaveDashboardReviewPath({
            from: start,
            to: end,
            attendanceId,
            requestedStatusKey,
            staffType: employee?.staffType,
            employeeMongoId: employee?._id,
            employeeName: empName,
        }),
        buttonLabel: 'Open Leave Approval',
        emailTitle: `${label} — not eligible`,
        recordIds: await mailIdsForRequest({
            requestId,
            requestType: LEAVE_DASHBOARD_REQUEST_TYPE,
        }),
    });
}
