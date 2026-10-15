import AttendanceChangeRequest from '../models/AttendanceChangeRequest.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { syncDashboardAction } from './syncDashboard.js';
import {
    sendAttendanceChangeRejectedEmail,
    sendAttendanceChangeRequestEmail,
} from './sendAttendanceLeaveEmails.js';
import { normalizeStaffType } from './workingTimeHelpers.js';

export const ATTENDANCE_CHANGE_REQUEST_TYPE = 'Attendance Change Request';

export const ATTENDANCE_CHANGE_OPEN_STAGES = ['pending_reportee', 'pending_hr', 'pending_requester'];

const OPEN_STAGES = ATTENDANCE_CHANGE_OPEN_STAGES;

export function personName(person) {
    return [person?.firstName, person?.lastName].filter(Boolean).join(' ').trim() || 'Employee';
}

/**
 * HR writes the day immediately.
 * The employee's primary reportee sends it to HR.
 * Anyone else waits for that reportee, then HR.
 * When the reportee is also HR, one HR approval is enough.
 */
export function approvalStageForAttendanceChange({ actorIsHr, actorId, reporteeId, hrId }) {
    if (actorIsHr) return 'apply';
    const reportee = String(reporteeId || '').trim();
    const actor = String(actorId || '').trim();
    const hr = String(hrId || '').trim();
    if (!reportee || (actor && actor === reportee) || (hr && reportee === hr)) {
        return 'pending_hr';
    }
    return 'pending_reportee';
}

/**
 * Hour requests travel requester → HOD → HR.
 * HR reject returns to the HOD. HOD reject returns to the requester.
 * The requester's reject removes the request.
 * When the HOD is the requester, or there is no HOD, HR reject returns to the requester.
 */
export function hourRejectNextStage({ stage, reporteeId, hrId, requesterId }) {
    const hod = String(reporteeId || '').trim();
    const hr = String(hrId || '').trim();
    const requester = String(requesterId || '').trim();
    if (stage === 'pending_hr') {
        if (hod && hod !== hr && hod !== requester) return 'pending_reportee';
        return 'pending_requester';
    }
    if (stage === 'pending_reportee') return 'pending_requester';
    if (stage === 'pending_requester') return 'gone';
    return 'rejected';
}

/** The requester sends a rejected hour request back to the HOD, or straight to HR. */
export function hourResubmitStage({ reporteeId, hrId, requesterId }) {
    const stage = approvalStageForAttendanceChange({
        actorIsHr: false,
        actorId: requesterId,
        reporteeId,
        hrId,
    });
    return stage === 'apply' ? 'pending_hr' : stage;
}

export function attendanceMarksMatch(existing, proposed) {
    if (!existing || !proposed) return false;
    const same = (left, right) => String(left || '').trim() === String(right || '').trim();
    return (
        same(existing.statusKey, proposed.statusKey) &&
        same(existing.statusLabel, proposed.statusLabel) &&
        same(existing.timeIn, proposed.timeIn) &&
        same(existing.timeOut, proposed.timeOut) &&
        same(existing.reason, proposed.reason) &&
        same(existing.attachmentName, proposed.attachmentName)
    );
}

export function attendanceChangeQueuedMessage(stage) {
    if (stage === 'pending_reportee') {
        return 'Sent to the primary reportee. Attendance stays unchanged until HR approves.';
    }
    return 'Sent to HR. Attendance stays unchanged until HR approves.';
}

export function attendanceChangeWaitingLabel(stage) {
    if (stage === 'pending_hr') return 'Waiting for HR';
    if (stage === 'pending_requester') return 'Waiting for requester';
    return 'Waiting for primary reportee';
}

export function attendanceChangeSummary(request) {
    const who = attendanceChangeWaitingLabel(request?.stage);
    const rejection = String(request?.rejectReason || '').trim();
    if (request?.action === 'hour_adjust' && rejection) {
        return `Rejected hour request. Reapply or reject. ${rejection}`;
    }
    if (request?.action === 'flexible_ot' && rejection) {
        return `Rejected OT request. Reapply or reject. ${rejection}`;
    }
    if (request?.action === 'flexible_ot' || request?.action === 'hour_adjust') {
        const label =
            request?.proposed?.statusLabel ||
            (request.action === 'hour_adjust' ? 'Hour approval' : 'Apply OT');
        return `${label} · ${who}`;
    }
    const from = request?.previous?.statusLabel || 'Not marked';
    const to =
        request?.action === 'map'
            ? `Mapped punches (${request?.proposed?.statusLabel || 'Updated'})`
            : request?.proposed?.statusLabel || 'Updated';
    const timeIn = String(request?.proposed?.timeIn || '').trim();
    const timeOut = String(request?.proposed?.timeOut || '').trim();
    const times = [timeIn, timeOut].filter(Boolean).join(' – ');
    return `${from} → ${to}${times ? ` (${times})` : ''} · ${who}`;
}

export function describeAttendanceSave({ savedCount = 0, pending = [] }) {
    const waiting = Array.isArray(pending) ? pending : [];
    if (!waiting.length) {
        return savedCount ? 'Attendance saved successfully' : 'Attendance saved successfully';
    }
    const reportee = waiting.filter((row) => row.stage === 'pending_reportee').length;
    const hr = waiting.filter((row) => row.stage === 'pending_hr').length;
    const parts = [];
    if (reportee) {
        parts.push(
            reportee === 1
                ? '1 change sent to the primary reportee'
                : `${reportee} changes sent to the primary reportee`,
        );
    }
    if (hr) {
        parts.push(hr === 1 ? '1 change sent to HR' : `${hr} changes sent to HR`);
    }
    if (savedCount) {
        parts.push(savedCount === 1 ? '1 saved' : `${savedCount} saved`);
    }
    const tail = savedCount
        ? 'Saved rows are updated. The others stay unchanged until HR approves.'
        : 'Attendance stays unchanged until HR approves.';
    return `${parts.join('. ')}. ${tail}`;
}

function changeReviewPath(request, employee) {
    const params = new URLSearchParams();
    const date = String(request?.date || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) params.set('date', date);
    params.set('staffType', normalizeStaffType(request?.staffType || employee?.staffType) || 'office');
    const person = String(request?.employeeMongoId || employee?._id || '').trim();
    if (person) params.set('blinkEmployee', person);
    const id = request?._id ? String(request._id) : '';
    if (id) params.set('changeRequestId', id);
    return `/HRM/Attendance/mark?${params.toString()}`;
}

async function closeChangeBells(requestId, status, actorId) {
    if (!requestId) return;
    await syncDashboardAction({
        requestId,
        requestType: ATTENDANCE_CHANGE_REQUEST_TYPE,
        status,
        actionedBy: actorId || null,
    });
}

async function openChangeBell({ request, approver, employee, summary, notice = 'request' }) {
    if (!approver?._id || !request?._id) return;
    const path = changeReviewPath(request, employee);
    await syncDashboardAction({
        requestId: request._id,
        requestType: ATTENDANCE_CHANGE_REQUEST_TYPE,
        assignedTo: approver._id,
        status: 'Pending',
        subjectEmployee: employee,
        requestedByName: request.requestedByName || '',
        extra1: summary,
        extra2: summary,
        extra3: JSON.stringify({
            attendanceChange: true,
            stage: request.stage,
            date: request.date,
            employeeMongoId: request.employeeMongoId,
            staffType: normalizeStaffType(request.staffType || employee?.staffType) || 'office',
            leaveRequestKind: 'attendance_change',
            attendanceId: String(request._id),
            action: request.action || 'mark',
        }),
    });
    if (notice === 'rejected') {
        const requestNoun =
            request.action === 'flexible_ot' ? 'OT' : request.action === 'hour_adjust' ? 'Hour' : 'Attendance';
        await sendAttendanceChangeRejectedEmail({
            approver,
            employee,
            date: request.date,
            rejectedByName: request.rejectedByName || '',
            reason: request.rejectReason || '',
            requestedLabel: request.proposed?.statusLabel || `${requestNoun} approval`,
            requestNoun,
            reviewPath: path,
        });
        return;
    }
    await sendAttendanceChangeRequestEmail({
        approver,
        employee,
        date: request.date,
        requestedByName: request.requestedByName,
        currentLabel: request.previous?.statusLabel || 'Not marked',
        requestedLabel: request.proposed?.statusLabel || 'Updated',
        timeIn: request.proposed?.timeIn || '',
        timeOut: request.proposed?.timeOut || '',
        reason: request.proposed?.reason || '',
        stage: request.stage,
        reviewPath: path,
    });
}

export async function supersedeOpenAttendanceChanges({ date, employeeMongoId, actorId }) {
    const open = await AttendanceChangeRequest.find({
        date,
        employeeMongoId: String(employeeMongoId),
        stage: { $in: OPEN_STAGES },
    }).select('_id');
    if (!open.length) return;
    await AttendanceChangeRequest.updateMany(
        { _id: { $in: open.map((row) => row._id) } },
        { $set: { stage: 'superseded' } },
    );
    await Promise.all(
        open.map((row) => closeChangeBells(row._id, 'Rejected', actorId)),
    );
}

export async function submitAttendanceChange({
    employee,
    date,
    proposed,
    previous,
    stage,
    actor,
    reportee,
    hr,
    action = 'mark',
}) {
    const employeeMongoId = String(employee?._id || '');
    const summaryEmployee = {
        _id: employee?._id,
        employeeId: employee?.employeeId || '',
        firstName: employee?.firstName || '',
        lastName: employee?.lastName || '',
    };
    const requestedByName = actor ? personName(actor) : 'User';
    const fields = {
        date,
        employeeMongoId,
        employeeId: String(employee?.employeeId || ''),
        employeeName: personName(employee),
        stage,
        action: ['map', 'flexible_ot', 'hour_adjust', 'clear'].includes(action) ? action : 'mark',
        proposed,
        previous,
        requestedBy: actor?._id || null,
        requestedByName,
        reporteeId: reportee?._id ? String(reportee._id) : '',
        reporteeName: reportee?._id ? personName(reportee) : '',
        hrId: hr?._id ? String(hr._id) : '',
        hrName: hr?._id ? personName(hr) : '',
        staffType: normalizeStaffType(employee?.staffType) || 'office',
        rejectReason: '',
        rejectedByName: '',
        decidedByReportee: null,
        decidedAtReportee: null,
        decidedByHr: null,
        decidedAtHr: null,
    };

    let request = await AttendanceChangeRequest.findOne({
        date,
        employeeMongoId,
        stage: { $in: OPEN_STAGES },
    });
    if (request) {
        await closeChangeBells(request._id, 'Rejected', actor?._id);
        request.set(fields);
        await request.save();
    } else {
        request = await AttendanceChangeRequest.create(fields);
    }

    const approver = stage === 'pending_hr' ? hr : reportee;
    const summary = attendanceChangeSummary(request);
    await openChangeBell({
        request,
        approver,
        employee: summaryEmployee,
        summary,
    });

    return {
        id: String(request._id),
        employeeMongoId,
        employeeName: request.employeeName,
        stage,
        statusLabel: proposed?.statusLabel || '',
        summary,
    };
}

const REPORTEE_SELECT = 'firstName lastName employeeId companyEmail workEmail email';

function pendingChangeRow(row, names = new Map()) {
    const reporteeId = String(row.reporteeId || '');
    const hrId = String(row.hrId || '');
    return {
        id: String(row._id),
        date: row.date || '',
        employeeMongoId: row.employeeMongoId,
        employeeName: row.employeeName || '',
        stage: row.stage,
        action: row.action || 'mark',
        statusKey: row.proposed?.statusKey || '',
        statusLabel: row.proposed?.statusLabel || '',
        timeIn: row.proposed?.timeIn || '',
        timeOut: row.proposed?.timeOut || '',
        reason: row.proposed?.reason || '',
        requestedById: row.requestedBy ? String(row.requestedBy) : '',
        requestedByName: row.requestedByName || '',
        reporteeId,
        reporteeName: row.reporteeName || names.get(reporteeId) || '',
        hrName: row.hrName || names.get(hrId) || '',
        rejectReason: row.rejectReason || '',
        rejectedByName: row.rejectedByName || '',
        hoursApproved: Number(row.proposed?.hoursApproved) || 0,
        flexibleOtApprovedHours: Number(row.proposed?.flexibleOtApprovedHours) || 0,
        flexibleOtHours: Number(row.proposed?.flexibleOtHours) || 0,
        createdAt: row.createdAt || null,
        decidedAtReportee: row.decidedAtReportee || null,
        hoursTaken: Number(row.proposed?.hoursTaken) || 0,
        hoursMax: Number(row.proposed?.hoursMax) || 0,
        hourAdjustKind: row.proposed?.hourAdjustKind || '',
        hourAdjustFlexible: row.proposed?.hourAdjustFlexible === true,
        targetDate: row.proposed?.targetDate || '',
        confirmNextDay: row.proposed?.confirmNextDay === true,
    };
}

export async function loadPendingAttendanceChanges(date) {
    const day = String(date || '').trim();
    const rows = await AttendanceChangeRequest.find({
        stage: { $in: OPEN_STAGES },
        $or: [
            { date: day },
            {
                action: 'flexible_ot',
                'proposed.confirmNextDay': true,
                'proposed.targetDate': day,
            },
        ],
    })
        .sort({ updatedAt: 1 })
        .lean();
    const missingIds = new Set();
    for (const row of rows || []) {
        if (!row.reporteeName && row.reporteeId) missingIds.add(String(row.reporteeId));
        if (!row.hrName && row.hrId) missingIds.add(String(row.hrId));
    }
    const names = new Map();
    if (missingIds.size) {
        const people = await EmployeeBasic.find({ _id: { $in: [...missingIds] } })
            .select('firstName lastName')
            .lean();
        for (const person of people || []) names.set(String(person._id), personName(person));
    }
    return (rows || []).map((row) => pendingChangeRow(row, names));
}

/**
 * Queue a change for the employee's primary reportee, then HR.
 * The caller applies the change immediately when the actor is flowchart HR.
 */
export async function openAttendanceChangeForEmployee({
    employee,
    date,
    proposed,
    previous,
    actor,
    hr,
    action = 'mark',
}) {
    const reporteeRef = employee?.primaryReportee;
    const reporteeId = reporteeRef?._id || reporteeRef || '';
    const stage = approvalStageForAttendanceChange({
        actorIsHr: false,
        actorId: actor?._id,
        reporteeId,
        hrId: hr?._id,
    });
    if (stage === 'pending_hr' && !hr?._id) {
        return { error: 'Flowchart HR is not set, so this attendance change cannot be sent for approval.' };
    }
    if (!employee?._id) {
        return { error: 'Employee not found, so this attendance change cannot be sent for approval.' };
    }

    let reportee = null;
    if (reporteeRef && typeof reporteeRef === 'object' && reporteeRef._id) {
        reportee = reporteeRef;
    } else if (reporteeId) {
        reportee = await EmployeeBasic.findById(reporteeId).select(REPORTEE_SELECT).lean();
    }
    if (stage === 'pending_reportee' && !reportee?._id) {
        return { error: 'This employee has no primary reportee, so the change cannot be sent for approval.' };
    }

    const pending = await submitAttendanceChange({
        employee,
        date,
        proposed,
        previous,
        stage,
        actor,
        reportee,
        hr,
        action,
    });
    return { pending };
}

export async function loadAttendanceChangeInboxItems({ viewerId, viewerIsHr, reporteeIds }) {
    const clauses = [];
    const viewer = String(viewerId || '').trim();
    if (viewer) {
        clauses.push({ stage: 'pending_reportee', reporteeId: viewer });
        clauses.push({ stage: 'pending_requester', requestedBy: viewer });
    }
    if (Array.isArray(reporteeIds) && reporteeIds.length) {
        clauses.push({
            stage: 'pending_reportee',
            employeeMongoId: { $in: reporteeIds.map(String) },
        });
    }
    if (viewerIsHr) {
        clauses.push({ stage: 'pending_hr' });
    }
    if (!clauses.length) return [];

    const rows = await AttendanceChangeRequest.find({ $or: clauses })
        .sort({ updatedAt: -1 })
        .limit(200)
        .lean();
    const staffIds = [...new Set((rows || []).map((row) => String(row.employeeMongoId || '')).filter(Boolean))];
    const staffRows = staffIds.length
        ? await EmployeeBasic.find({ _id: { $in: staffIds } }).select('staffType').lean()
        : [];
    const staffById = new Map(
        (staffRows || []).map((row) => [String(row._id), normalizeStaffType(row.staffType) || 'office']),
    );

    const seen = new Set();
    return (rows || [])
        .filter((row) => {
            const id = String(row._id);
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        })
        .map((row) => {
            const summary = attendanceChangeSummary(row);
            const requestedLabel =
                row.action === 'map'
                    ? `Mapped punches (${row.proposed?.statusLabel || 'Updated'})`
                    : row.proposed?.statusLabel || 'Updated';
            return {
                id: String(row._id),
                dashboardActionId: String(row._id),
                requestType: ATTENDANCE_CHANGE_REQUEST_TYPE,
                requestObjectId: String(row._id),
                date: row.date,
                employeeMongoId: row.employeeMongoId,
                employeeId: row.employeeId || '',
                subjectName: row.employeeName || 'Employee',
                staffType: row.staffType || staffById.get(String(row.employeeMongoId || '')) || 'office',
                requestedByName: row.requestedByName || '',
                leaveRequestKind: 'attendance_change',
                changeStage: row.stage,
                previousStatusLabel: row.previous?.statusLabel || 'Not marked',
                requestedStatusLabel: requestedLabel,
                timeIn: row.proposed?.timeIn || '',
                timeOut: row.proposed?.timeOut || '',
                reason: row.proposed?.reason || '',
                action: row.action || 'mark',
                hoursApproved: Number(row.proposed?.hoursApproved) || 0,
                flexibleOtApprovedHours: Number(row.proposed?.flexibleOtApprovedHours) || 0,
                flexibleOtHours: Number(row.proposed?.flexibleOtHours) || 0,
                createdAt: row.createdAt || null,
                decidedAtReportee: row.decidedAtReportee || null,
                reporteeName: row.reporteeName || '',
                hrName: row.hrName || '',
                rejectReason: row.rejectReason || '',
                rejectedByName: row.rejectedByName || '',
                targetDate: row.proposed?.targetDate || '',
                confirmNextDay: row.proposed?.confirmNextDay === true,
                status: 'Pending',
                extra1: summary,
                extra2: summary,
                message: summary,
            };
        });
}

export async function closeAttendanceChangeRequest(request, { status, actorId }) {
    await closeChangeBells(request?._id, status, actorId);
}

export async function forwardAttendanceChangeToHr({ request, actor, hr, employee }) {
    await closeChangeBells(request._id, 'Approved', actor?._id);
    request.stage = 'pending_hr';
    request.hrId = hr?._id ? String(hr._id) : request.hrId || '';
    if (hr?._id) request.hrName = personName(hr);
    request.decidedByReportee = actor?._id || null;
    request.decidedAtReportee = new Date();
    await request.save();
    const summary = attendanceChangeSummary(request);
    await openChangeBell({
        request,
        approver: hr,
        employee,
        summary,
    });
    return summary;
}

const APPROVER_SELECT = 'firstName lastName employeeId companyEmail workEmail email';

async function loadPerson(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    return EmployeeBasic.findById(key).select(APPROVER_SELECT).lean();
}

async function approverForHourStage(stage, request) {
    if (stage === 'pending_hr') return loadPerson(request?.hrId);
    if (stage === 'pending_reportee') return loadPerson(request?.reporteeId);
    if (stage === 'pending_requester') return loadPerson(request?.requestedBy);
    return null;
}

function hourStageLabel(stage) {
    if (stage === 'pending_hr') return 'HR';
    if (stage === 'pending_reportee') return 'the primary reportee';
    return 'the requester';
}

export async function bounceHourAttendanceChange({ request, actor, employee, reason, noun = 'hour' }) {
    const next = hourRejectNextStage({
        stage: request.stage,
        reporteeId: request.reporteeId,
        hrId: request.hrId,
        requesterId: request.requestedBy,
    });
    const rejectReason = String(reason || '').trim();
    if (!rejectReason) return { error: 'Reject reason is required.' };
    if (next === 'gone') {
        request.rejectReason = rejectReason;
        request.rejectedByName = personName(actor);
        request.stage = 'rejected';
        await request.save();
        await closeChangeBells(request._id, 'Rejected', actor?._id);
        const label = String(noun || 'hour').trim() || 'hour';
        return { message: `${label.charAt(0).toUpperCase()}${label.slice(1)} request removed.` };
    }
    const approver = await approverForHourStage(next, request);
    if (!approver?._id) {
        return { error: `Could not send this rejection back to ${hourStageLabel(next)}.` };
    }
    await closeChangeBells(request._id, 'Rejected', actor?._id);
    request.stage = next;
    request.rejectReason = rejectReason;
    request.rejectedByName = personName(actor);
    if (next === 'pending_reportee' || next === 'pending_requester') {
        request.decidedByReportee = null;
        request.decidedAtReportee = null;
    }
    await request.save();
    const label = String(noun || 'hour').trim() || 'hour';
    const summary = `Rejected ${label} request. Reapply or reject. ${rejectReason}`;
    await openChangeBell({
        request,
        approver,
        employee,
        summary,
        notice: 'rejected',
    });
    return { message: `Rejected. Sent back to ${personName(approver)}.` };
}

export async function resubmitHourAttendanceChange({ request, actor, employee, hr }) {
    const stage = hourResubmitStage({
        reporteeId: request.reporteeId,
        hrId: hr?._id || request.hrId,
        requesterId: request.requestedBy,
    });
    if (stage === 'pending_hr' && !hr?._id && !request.hrId) {
        return { error: 'Flowchart HR is not set, so this hour request cannot be sent.' };
    }
    if (stage === 'pending_reportee' && !request.reporteeId) {
        return { error: 'This employee has no primary reportee, so the hour request cannot be sent.' };
    }
    const approver =
        stage === 'pending_hr' ? hr || (await loadPerson(request.hrId)) : await loadPerson(request.reporteeId);
    if (!approver?._id) {
        return { error: `Could not send this hour request to ${hourStageLabel(stage)}.` };
    }
    await closeChangeBells(request._id, 'Approved', actor?._id);
    request.stage = stage;
    request.rejectReason = '';
    request.rejectedByName = '';
    if (hr?._id) {
        request.hrId = String(hr._id);
        request.hrName = personName(hr);
    }
    await request.save();
    const summary = attendanceChangeSummary(request);
    await openChangeBell({
        request,
        approver,
        employee,
        summary,
    });
    return {
        message:
            stage === 'pending_hr'
                ? 'Sent to HR. Attendance stays unchanged until HR approves.'
                : 'Sent to the primary reportee. Attendance stays unchanged until HR approves.',
    };
}
