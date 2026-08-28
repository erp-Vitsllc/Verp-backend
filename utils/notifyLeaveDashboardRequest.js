import mongoose from 'mongoose';
import { syncDashboardAction } from './syncDashboard.js';
import { sendAttendanceLeaveRequestEmail } from './sendAttendanceLeaveEmails.js';

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

export function leaveDashboardReviewPath({ from, to, attendanceId } = {}) {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (attendanceId) params.set('approvalId', String(attendanceId));
    const query = params.toString();
    return query ? `/HRM/Leave/annual-leave?${query}` : '/HRM/Leave/annual-leave';
}

function personName(person) {
    return [person?.firstName, person?.lastName].filter(Boolean).join(' ').trim() || 'Employee';
}

export async function notifyPrimaryReporteeOfLeaveRequest({
    employee,
    manager,
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
    const reportee = manager || employee?.primaryReportee;
    if (!reportee?._id) {
        console.warn('[LeaveNotify] No primary reportee for leave request.');
        return;
    }

    const start = String(from || '').trim();
    const end = String(to || start).trim();
    const rangeLabel = start && end && start !== end ? `${start} → ${end}` : start || end;
    const empName = personName(employee);
    const label = String(requestedLabel || 'Leave').trim() || 'Leave';
    const requestId = leaveDashboardRequestObjectId(groupId, attendanceId);

    await syncDashboardAction({
        requestId,
        requestType: LEAVE_DASHBOARD_REQUEST_TYPE,
        assignedTo: reportee._id,
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
            leaveRequestKind,
            leaveRequestGroupId: String(groupId || ''),
            leaveDashboard: true,
        }),
    });

    await sendAttendanceLeaveRequestEmail({
        manager: reportee,
        employee,
        date: start,
        dateLabel: rangeLabel,
        requestedLabel: label,
        currentLabel: 'Pending approval',
        reason,
        kind: leaveRequestKind,
        attachmentName,
        reviewPath: leaveDashboardReviewPath({
            from: start,
            to: end,
            attendanceId,
        }),
        buttonLabel: 'Open Leave Approval',
        emailTitle: `${label} Request`,
    });
}
