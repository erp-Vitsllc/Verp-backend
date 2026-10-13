import AttendanceChangeRequest from '../models/AttendanceChangeRequest.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { syncDashboardAction } from './syncDashboard.js';
import { sendAttendanceChangeRequestEmail } from './sendAttendanceLeaveEmails.js';

export const ATTENDANCE_CHANGE_REQUEST_TYPE = 'Attendance Change Request';

const OPEN_STAGES = ['pending_reportee', 'pending_hr'];

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

export function attendanceChangeSummary(request) {
    const who =
        request?.stage === 'pending_hr' ? 'Waiting for HR' : 'Waiting for primary reportee';
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

function reviewPath() {
    return '/HRM/Attendance?bell=1';
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

async function openChangeBell({ request, approver, employee, summary }) {
    if (!approver?._id || !request?._id) return;
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
        }),
    });
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
        reviewPath: reviewPath(),
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
        hrId: hr?._id ? String(hr._id) : '',
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

function pendingChangeRow(row) {
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
        requestedByName: row.requestedByName || '',
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
    return (rows || []).map(pendingChangeRow);
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
                requestedByName: row.requestedByName || '',
                leaveRequestKind: 'attendance_change',
                changeStage: row.stage,
                previousStatusLabel: row.previous?.statusLabel || 'Not marked',
                requestedStatusLabel: requestedLabel,
                timeIn: row.proposed?.timeIn || '',
                timeOut: row.proposed?.timeOut || '',
                reason: row.proposed?.reason || '',
                action: row.action || 'mark',
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
    request.hrId = hr?._id ? String(hr._id) : '';
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
