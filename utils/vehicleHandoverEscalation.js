import AssetHistory from '../models/AssetHistory.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import DashboardAction from '../models/DashboardAction.js';
import {
    advanceFleetHandoverOnAccept,
    formatEmployeeDisplayName,
    getVehicleHandoverFlow,
    isHandoverReportsComplete,
    resolveAdminOfficerEmployee,
    upsertHandoverAdminOfficerDashboardAction,
    upsertHandoverDashboardAction,
} from './vehicleHandoverApprovalFlow.js';
import {
    sendFleetHandoverAutoAcceptedEmail,
    sendFleetHandoverReminderEmail,
} from './sendFleetHandoverEscalationEmails.js';

export const FLEET_HANDOVER_REMINDER_START_DAY = 5;
export const FLEET_HANDOVER_AUTO_ACCEPT_DAY = 10;

const VEHICLE_INSPECTION_HANDOVER_KIND = 'vehicle_inspection';

const startOfDay = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
};

export function getHandoverEscalationDaysElapsed(requestedAt, today = startOfDay(new Date())) {
    if (!requestedAt) return 0;
    const start = startOfDay(requestedAt);
    const diffMs = today - start;
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function cloneJson(value) {
    if (value == null) return undefined;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return undefined;
    }
}

export async function findPreviousCompletedHandoverDetails(assetId, currentHistoryId) {
    const current = await AssetHistory.findById(currentHistoryId).select('createdAt date').lean();
    const beforeDate = current?.createdAt || current?.date || new Date();

    const candidates = await AssetHistory.find({
        assetId,
        _id: { $ne: currentHistoryId },
        createdAt: { $lt: beforeDate },
        'details.handoverKind': { $ne: VEHICLE_INSPECTION_HANDOVER_KIND },
        'details.firstInspection': { $ne: true },
    })
        .sort({ createdAt: -1 })
        .limit(25)
        .select('details')
        .lean();

    for (const row of candidates) {
        if (isHandoverReportsComplete(row)) return row.details;
        const d = row.details || {};
        if (d.receiverAssessmentCompleted && d.bodyConditionCompleted) return d;
    }
    return null;
}

export function cloneHandoverReportFields(prevDetails = {}) {
    const receiverAssessment =
        prevDetails.receiverAssessment || prevDetails.vehicleAssessmentReportByReceiver;
    const bodyConditionReport = prevDetails.bodyConditionReport || prevDetails.bodyCondition;
    const out = {};
    const ra = cloneJson(receiverAssessment);
    const bc = cloneJson(bodyConditionReport);
    if (ra && Object.keys(ra).length) out.receiverAssessment = ra;
    if (bc && Object.keys(bc).length) out.bodyConditionReport = bc;
    if (Object.keys(out).length) {
        out.receiverAssessmentCompleted = true;
        out.bodyConditionCompleted = true;
    }
    return out;
}

export async function applyPreviousHandoverReportsToHistory({ historyId, assetId, assigneeDoc }) {
    const record = await AssetHistory.findById(historyId);
    if (!record) return { applied: false, reason: 'history_not_found' };

    const prevDetails = await findPreviousCompletedHandoverDetails(assetId, historyId);
    if (!prevDetails) return { applied: false, reason: 'no_previous_reports' };

    const cloned = cloneHandoverReportFields(prevDetails);
    if (!Object.keys(cloned).length) return { applied: false, reason: 'empty_previous_reports' };

    const existing =
        record.details && typeof record.details === 'object' ? { ...record.details } : {};
    const workflow =
        existing.vehicleHandoverWorkflow && typeof existing.vehicleHandoverWorkflow === 'object'
            ? { ...existing.vehicleHandoverWorkflow }
            : {};
    const stages = { ...(workflow.stages || {}) };
    const assigneeName = formatEmployeeDisplayName(assigneeDoc);
    stages.target = {
        ...(stages.target || {}),
        actorName: assigneeName,
        actorId: assigneeDoc?._id?.toString?.() || stages.target?.actorId || '',
        actorEmployeeId: String(assigneeDoc?.employeeId || stages.target?.actorEmployeeId || '').trim(),
        date: new Date(),
    };

    record.details = {
        ...existing,
        ...cloned,
        vehicleHandoverWorkflow: {
            ...workflow,
            stages,
            reportsCopiedFromPreviousAssignment: true,
        },
    };
    record.markModified('details');
    await record.save();
    return { applied: true };
}

export async function refreshHandoverEscalationReminders({
    asset,
    historyId,
    assigner,
    assigneeDoc,
    actionRecipient,
    adminOfficer,
    daysElapsed,
}) {
    const daysLeft = Math.max(0, FLEET_HANDOVER_AUTO_ACCEPT_DAY - daysElapsed);
    const reminderLabel = `Vehicle Handover — reminder (day ${daysElapsed}, ${daysLeft} day(s) left)`;
    const subjectName = formatEmployeeDisplayName(assigneeDoc);
    const subjectEmpId = assigneeDoc?.employeeId || '';

    await upsertHandoverDashboardAction({
        asset,
        actor: actionRecipient,
        assigner,
        historyId,
        stageLabel: reminderLabel,
        subjectName,
        subjectEmpId,
    });

    if (adminOfficer?._id) {
        await upsertHandoverAdminOfficerDashboardAction({
            asset,
            adminOfficer,
            historyId,
            subjectName,
            subjectEmpId,
            stageLabel: reminderLabel,
        });
    }

    await DashboardAction.updateMany(
        {
            requestId: asset._id,
            requestType: 'Asset Assignment',
            status: 'Pending',
        },
        { $set: { requestedDate: new Date() } },
    );

    await sendFleetHandoverReminderEmail({
        asset,
        historyId,
        assigneeDoc,
        actionRecipient,
        adminOfficer,
        daysElapsed,
        daysLeft,
    });
}

export async function autoAcceptFleetHandoverTargetStage(item) {
    const flow = getVehicleHandoverFlow(item);
    if (!flow || flow.stage !== 'target' || flow.escalation?.autoAcceptedAt) {
        return { ok: false, reason: 'not_eligible' };
    }

    const historyId = flow.historyId;
    if (!historyId) return { ok: false, reason: 'missing_history' };

    const assigneeId = item.assignedTo?._id || item.assignedTo;
    const assigneeDoc = assigneeId
        ? await EmployeeBasic.findById(assigneeId)
              .select(
                  'firstName lastName employeeId companyEmail workEmail personalEmail email signature enablePortalAccess primaryReportee',
              )
              .lean()
        : null;
    if (!assigneeDoc?._id) return { ok: false, reason: 'missing_assignee' };

    const copyResult = await applyPreviousHandoverReportsToHistory({
        historyId,
        assetId: item._id,
        assigneeDoc,
    });

    let historyRecord = await AssetHistory.findById(historyId).lean();
    if (!historyRecord) return { ok: false, reason: 'history_not_found' };

    if (!isHandoverReportsComplete(historyRecord) && !copyResult.applied) {
        return { ok: false, reason: 'reports_incomplete' };
    }

    const assignerId = item.assignedBy?._id || item.assignedBy;
    const assigner = assignerId
        ? await EmployeeBasic.findById(assignerId).select('firstName lastName employeeId').lean()
        : null;

    const advance = await advanceFleetHandoverOnAccept({
        item,
        historyRecord,
        assigneeDoc,
        actor: assigneeDoc,
        assigner,
    });

    if (advance.error) return { ok: false, reason: advance.error };

    if (!advance.advanced && !advance.finalize) {
        return { ok: false, reason: 'advance_failed' };
    }

    item.pendingActionDetails = {
        ...(item.pendingActionDetails || {}),
        vehicleHandoverFlow: {
            ...flow,
            ...(advance.advanced ? { stage: 'hr' } : {}),
            escalation: {
                ...(flow.escalation || {}),
                autoAcceptedAt: new Date(),
                reportsCopiedFromPrevious: copyResult.applied === true,
            },
        },
    };
    await item.save();

    const adminOfficer = await resolveAdminOfficerEmployee();

    await sendFleetHandoverAutoAcceptedEmail({
        asset: item,
        historyId,
        assigneeDoc,
        assigner,
        adminOfficer,
        reportsCopied: copyResult.applied === true,
        autoAcceptDay: FLEET_HANDOVER_AUTO_ACCEPT_DAY,
    });

    await AssetHistory.create({
        assetId: item._id,
        action: 'Comment',
        performedBy: null,
        comments:
            'Vehicle handover auto-accepted after 10 days with no response. Assessment and body condition data were carried forward from the previous assignment where available.',
        date: new Date(),
        details: {
            auto: true,
            reason: 'FleetHandoverAutoAccept',
            historyId: String(historyId),
            reportsCopiedFromPrevious: copyResult.applied === true,
        },
    }).catch(() => null);

    return { ok: true, advanced: !!advance.advanced, finalized: !!advance.finalize };
}

export function buildInitialHandoverEscalationMeta() {
    return {
        requestedAt: new Date(),
        lastReminderDay: null,
    };
}

export function markHandoverEscalationResolved(flow = {}) {
    return {
        ...flow,
        escalation: {
            ...(flow.escalation || {}),
            resolvedAt: new Date(),
        },
    };
}
