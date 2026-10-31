import mongoose from 'mongoose';
import DashboardAction from '../models/DashboardAction.js';
import TaskManagerTask from '../models/TaskManagerTask.js';
import { LEAVE_DASHBOARD_REQUEST_TYPE } from './notifyLeaveDashboardRequest.js';
import { LEAVE_STAGE_HR, LEAVE_STAGE_REPORTEE } from './leaveRequestApproval.js';
import { normalizeStaffTypeKey } from './workLocationHelpers.js';

const CLOSED_TASK = new Set(['Completed', 'Rejected']);
const OPEN_ACTION = new Set(['Pending', 'On Hold']);

function actionTime(action) {
    return new Date(action?.updatedAt || action?.actionedDate || action?.requestedDate || 0).getTime();
}

function personName(person) {
    return [person?.firstName, person?.lastName].filter(Boolean).join(' ').trim();
}

/**
 * Pick the leave task that already belongs to this request.
 * A newer pending copy is not the task to keep. The completed task is reopened,
 * and any other open copy is dismissed.
 */
export function planLeaveTaskReopen(actions = [], overlays = []) {
    const leave = (actions || []).filter(
        (action) => String(action?.requestType || '') === LEAVE_DASHBOARD_REQUEST_TYPE,
    );
    const overlayBySource = new Map();
    for (const overlay of overlays || []) {
        if (String(overlay?.status || '') === 'Cancelled') continue;
        const sourceId = String(overlay?.sourceDashboardActionId || '');
        if (!sourceId) continue;
        const current = overlayBySource.get(sourceId);
        if (!current || actionTime(overlay) >= actionTime(current)) overlayBySource.set(sourceId, overlay);
    }

    const withTask = leave.filter((action) => overlayBySource.has(String(action?._id || '')));
    const usable = leave.filter((action) => !['Dismissed', 'Rejected'].includes(String(action?.status || '')));
    const pool = withTask.length ? withTask : usable;
    const approved = pool.filter((action) => String(action?.status || '') === 'Approved');
    const pending = pool.filter((action) => OPEN_ACTION.has(String(action?.status || '')));
    const ranked = (approved.length ? approved : pending.length ? pending : pool)
        .slice()
        .sort((left, right) => actionTime(right) - actionTime(left));
    const action = ranked[0] || null;
    const dismissIds = leave
        .filter((row) => action && String(row._id) !== String(action._id))
        .filter((row) => OPEN_ACTION.has(String(row.status || '')))
        .map((row) => row._id);

    return {
        action,
        overlay: action ? overlayBySource.get(String(action._id)) || null : null,
        dismissIds,
    };
}

/** Put a finished leave task back to pending. This does not send email. */
export function applyLeaveTaskReopen(task, approver, approverName = '') {
    if (!task) return false;
    const status = String(task.status || '');
    const closed = CLOSED_TASK.has(status) || Boolean(task.closeRequest?.closedAt);
    if (approver?._id) {
        task.assignee = approver._id;
        task.assigneeEmpId = approver.employeeId || task.assigneeEmpId || '';
        task.assigneeName = approverName || personName(approver) || task.assigneeName || '';
    }
    if (!closed) return false;
    const saved = task.closeRequest?.toObject ? task.closeRequest.toObject() : { ...(task.closeRequest || {}) };
    task.status = 'Pending';
    task.closeRequest = {
        ...saved,
        reopenedAt: new Date(),
        closedAt: null,
        closedByName: '',
        completesAt: null,
        completionConfirmedAt: null,
        reviewPending: false,
        requesterNotifiedAt: null,
    };
    if (typeof task.markModified === 'function') task.markModified('closeRequest');
    task.history = task.history || [];
    task.history.push({
        event: 'Reopened',
        detail: 'This leave was returned to a request. The same task is open again.',
        actorName: 'System',
        createdAt: new Date(),
    });
    return true;
}

/**
 * Reopen the dashboard task for a leave that was returned to a request.
 * Does not create a task and does not send the leave email.
 */
export async function reopenExistingLeaveRequestTask({
    requestIds = [],
    approver = null,
    employee = null,
    stage = '',
    from = '',
    to = '',
    attendanceId = '',
    groupId = '',
    requestedLabel = 'Leave',
    requestedStatusKey = '',
    leaveRequestKind = 'leave',
} = {}) {
    const ids = [...new Set(
        (requestIds || []).map((id) => String(id || '').trim()).filter((id) => mongoose.Types.ObjectId.isValid(id)),
    )];
    if (!ids.length) return { reopened: false };

    const or = [{ requestId: { $in: ids } }];
    for (const id of ids) {
        or.push({ extra3: new RegExp(`"attendanceId":"${id}"`) });
        or.push({ extra3: new RegExp(`"leaveRequestGroupId":"${id}"`) });
    }
    const actions = await DashboardAction.find({
        requestType: LEAVE_DASHBOARD_REQUEST_TYPE,
        $or: or,
    });
    if (!actions.length) return { reopened: false };

    const overlays = await TaskManagerTask.find({
        sourceDashboardActionId: { $in: actions.map((action) => action._id) },
    });
    const plan = planLeaveTaskReopen(actions, overlays);
    if (!plan.action) return { reopened: false };

    const action = actions.find((row) => String(row._id) === String(plan.action._id)) || plan.action;
    const start = String(from || '').trim();
    const end = String(to || start).trim();
    const rangeLabel = start && end && start !== end ? `${start} → ${end}` : start || end;
    const label = String(requestedLabel || 'Leave').trim() || 'Leave';
    const hrStep = stage === LEAVE_STAGE_HR;

    if (approver?._id) {
        action.assignedTo = approver._id;
        action.assignedToEmpId = approver.employeeId || action.assignedToEmpId || '';
    }
    action.status = 'Pending';
    action.actionedDate = null;
    action.actionedBy = null;
    if (String(action.comment || '').startsWith('Closed:')) action.comment = '';
    if (start) action.extra1 = start;
    action.extra2 = `${label} request for ${rangeLabel}`;
    action.extra3 = JSON.stringify({
        attendanceId: String(attendanceId || ''),
        employeeMongoId: String(employee?._id || ''),
        from: start,
        to: end,
        requestedStatusKey: String(requestedStatusKey || ''),
        staffType: normalizeStaffTypeKey(employee?.staffType) || 'office',
        leaveRequestKind: String(leaveRequestKind || 'leave'),
        leaveRequestGroupId: String(groupId || ''),
        leaveDashboard: true,
        approvalStage: hrStep ? LEAVE_STAGE_HR : LEAVE_STAGE_REPORTEE,
    });
    await action.save();

    const overlay = overlays.find((row) => String(row._id) === String(plan.overlay?._id || ''));
    if (overlay) {
        applyLeaveTaskReopen(overlay, approver, personName(approver));
        if (approver?._id && String(overlay.assignee || '') !== String(approver._id)) {
            overlay.assignee = approver._id;
            overlay.assigneeEmpId = approver.employeeId || overlay.assigneeEmpId || '';
            overlay.assigneeName = personName(approver) || overlay.assigneeName || '';
        }
        await overlay.save();
    }

    if (plan.dismissIds.length) {
        await DashboardAction.updateMany(
            { _id: { $in: plan.dismissIds }, status: { $in: ['Pending', 'On Hold'] } },
            {
                $set: {
                    status: 'Dismissed',
                    actionedDate: new Date(),
                    comment: 'Closed: duplicate task',
                },
            },
        );
    }

    return { reopened: true, actionId: String(action._id) };
}
