import AssetHistory from '../models/AssetHistory.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import DashboardAction from '../models/DashboardAction.js';
import TaskManagerTask from '../models/TaskManagerTask.js';
import {
    advanceFleetHandoverOnAccept,
    buildHandoverAssignDetailsPath,
    formatEmployeeDisplayName,
    getVehicleHandoverFlow,
    isBodyConditionReportComplete,
    isHandoverReportsComplete,
    isReceiverAssessmentComplete,
    resolveAdminOfficerEmployee,
    upsertHandoverAdminOfficerDashboardAction,
    upsertHandoverDashboardAction,
} from './vehicleHandoverApprovalFlow.js';
import {
    sendFleetHandoverAutoAcceptedEmail,
    sendFleetHandoverImagesMissingEmail,
    sendFleetHandoverReminderEmail,
} from './sendFleetHandoverEscalationEmails.js';

export const FLEET_HANDOVER_REMINDER_START_DAY = 5;
export const FLEET_HANDOVER_AUTO_ACCEPT_DAY = 10;
export const HANDOVER_IMAGES_MISSING_REQUEST_TYPE = 'Vehicle Handover Images Missing';

function bodyPhotoValue(photo) {
    if (!photo) return false;
    if (typeof photo === 'string') return Boolean(String(photo).trim());
    if (typeof photo === 'object') {
        return Boolean(photo.url || photo.publicId || photo.data || photo.path);
    }
    return false;
}

/** Any saved body-condition photo, including a partial previous handover. */
export function bodyConditionReportHasAnyPhoto(report) {
    if (!report || typeof report !== 'object') return false;
    return Object.values(report).some((row) => {
        if (!row || typeof row !== 'object') return false;
        return bodyPhotoValue(row.photo ?? row.image ?? row.attachment);
    });
}

/** True when this handover already has the body-condition images. */
export function currentHandoverBodyPhotosAdded(details = {}) {
    if (!details || typeof details !== 'object') return false;
    if (details.bodyConditionCompleted === true) return true;
    return isBodyConditionReportComplete(details);
}

/**
 * Day 10 must not copy old pictures or advance when the current handover
 * has no body-condition images. A missing previous image is the same stop.
 */
export function handoverMissingImagesDecision(currentDetails = {}, previousBodyReport = null) {
    const photosAdded = currentHandoverBodyPhotosAdded(currentDetails);
    const noPreviousPhoto = !bodyConditionReportHasAnyPhoto(previousBodyReport);
    if (photosAdded) {
        return { block: false, photosAdded: true, noPreviousPhoto };
    }
    return { block: true, photosAdded: false, noPreviousPhoto };
}

export function handoverImagesMissingMessage({ noPreviousPhoto = false } = {}) {
    if (noPreviousPhoto) {
        return 'Images were not added and there is no previous image. This handover cannot go to the next step. Do not update without images.';
    }
    return 'Images were not added. This handover cannot go to the next step. Do not update without images.';
}

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
        action: { $in: ['Assigned', 'Accepted', 'Transfer', 'ControllerHandover'] },
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

function historyHasBodyConditionData(details = {}) {
    const bc = details.bodyConditionReport || details.bodyCondition;
    if (!bc || typeof bc !== 'object') return false;
    return Object.values(bc).some((row) => {
        if (!row || typeof row !== 'object') return false;
        const photo = row.photo ?? row.image ?? row.attachment;
        const comment = String(row.comment ?? row.notes ?? '').trim();
        return Boolean(photo) || Boolean(comment);
    });
}

function historyHasReceiverAssessmentData(details = {}) {
    const ra = details.receiverAssessment || details.vehicleAssessmentReportByReceiver;
    if (!ra || typeof ra !== 'object') return false;
    return Object.values(ra).some((row) => {
        if (!row || typeof row !== 'object') return false;
        return row.present === true || row.present === false || Boolean(row.photo);
    });
}

async function loadPriorHandoverCandidates(assetId, currentHistoryId) {
    const current = await AssetHistory.findById(currentHistoryId).select('createdAt date').lean();
    const beforeDate = current?.createdAt || current?.date || new Date();

    return AssetHistory.find({
        assetId,
        _id: { $ne: currentHistoryId },
        createdAt: { $lt: beforeDate },
        action: { $in: ['Assigned', 'Accepted', 'Transfer', 'ControllerHandover'] },
    })
        .sort({ createdAt: -1 })
        .limit(25)
        .select('details')
        .lean();
}

function pickPriorDetailsWithAssessment(details = {}) {
    const ra = details.receiverAssessment || details.vehicleAssessmentReportByReceiver;
    if (!ra || typeof ra !== 'object' || !Object.keys(ra).length) return null;
    if (!historyHasReceiverAssessmentData(details)) return null;
    return details;
}

function pickPriorDetailsWithBodyCondition(details = {}) {
    const bc = details.bodyConditionReport || details.bodyCondition;
    if (!bc || typeof bc !== 'object' || !Object.keys(bc).length) return null;
    if (!historyHasBodyConditionData(details)) return null;
    return details;
}

/** Prior handover with any saved accessory or body photos (partial OK). */
export async function findPreviousHandoverDetailsForSeed(assetId, currentHistoryId) {
    const candidates = await loadPriorHandoverCandidates(assetId, currentHistoryId);

    let assessmentDetails = null;
    let bodyDetails = null;

    for (const row of candidates) {
        const d = row.details || {};
        if (!assessmentDetails) {
            assessmentDetails = pickPriorDetailsWithAssessment(d);
        }
        if (!bodyDetails) {
            bodyDetails = pickPriorDetailsWithBodyCondition(d);
        }
        if (assessmentDetails && bodyDetails) break;
        if (isHandoverReportsComplete(row)) {
            if (!assessmentDetails) assessmentDetails = d;
            if (!bodyDetails) bodyDetails = d;
            if (assessmentDetails && bodyDetails) break;
        }
    }

    if (!assessmentDetails && !bodyDetails) return null;

    return {
        receiverAssessment:
            assessmentDetails?.receiverAssessment ||
            assessmentDetails?.vehicleAssessmentReportByReceiver,
        vehicleAssessmentReportByReceiver:
            assessmentDetails?.vehicleAssessmentReportByReceiver ||
            assessmentDetails?.receiverAssessment,
        bodyConditionReport:
            bodyDetails?.bodyConditionReport || bodyDetails?.bodyCondition,
        bodyCondition: bodyDetails?.bodyCondition || bodyDetails?.bodyConditionReport,
    };
}

export function cloneHandoverReportFieldsForSeed(prevDetails = {}) {
    const out = {};
    const ra = cloneJson(
        prevDetails.receiverAssessment || prevDetails.vehicleAssessmentReportByReceiver,
    );
    if (ra && Object.keys(ra).length) out.receiverAssessment = ra;
    return out;
}

export function bodyConditionReportHasUserSelectedRows(bodyConditionReport) {
    if (!bodyConditionReport || typeof bodyConditionReport !== 'object') return false;
    return Object.values(bodyConditionReport).some(
        (row) => row && typeof row === 'object' && row.userSelected === true,
    );
}

/** True when the assignee has edited at least one body view (not only auto-copied photos). */
export function bodyConditionReportHasUserEdits(bodyConditionReport) {
    if (!bodyConditionReport || typeof bodyConditionReport !== 'object') return false;
    return Object.values(bodyConditionReport).some((row) => {
        if (!row || typeof row !== 'object') return false;
        if (row.userSelected === true) return true;
        if (row.photoSource === 'previous' || row.photoSource === 'new') return true;
        if (String(row.comment ?? row.notes ?? '').trim()) return true;
        return false;
    });
}

/** Remove auto-copied body photos until the assignee picks Previous / New via Add. */
export function stripUnconfirmedBodyConditionDetails(details = {}) {
    if (!details || typeof details !== 'object' || details.bodyConditionCompleted === true) {
        return { details, changed: false };
    }
    const bc = details.bodyConditionReport;
    if (!bc || typeof bc !== 'object' || !Object.keys(bc).length) {
        return { details, changed: false };
    }
    if (bodyConditionReportHasUserEdits(bc)) {
        return { details, changed: false };
    }
    return {
        details: { ...details, bodyConditionReport: {} },
        changed: true,
    };
}

/**
 * Copy previous assignment accessory/body photos onto a new handover row (does not mark sections complete).
 */
export async function seedPreviousHandoverReportsOnHistory({ historyId, assetId }) {
    const record = await AssetHistory.findById(historyId);
    if (!record) return { applied: false, reason: 'history_not_found' };
    if (String(record.action || '').trim() !== 'Assigned') {
        return { applied: false, reason: 'not_assigned' };
    }

    const existing = record.details && typeof record.details === 'object' ? { ...record.details } : {};
    const needsAssessment = !historyHasReceiverAssessmentData(existing);
    const needsBody = !historyHasBodyConditionData(existing);
    if (!needsAssessment && !needsBody) {
        return { applied: false, reason: 'already_has_reports' };
    }

    const prevDetails = await findPreviousHandoverDetailsForSeed(assetId, historyId);
    if (!prevDetails) return { applied: false, reason: 'no_previous_reports' };

    const cloned = cloneHandoverReportFieldsForSeed(prevDetails);
    const patch = {};
    if (needsAssessment && cloned.receiverAssessment) {
        patch.receiverAssessment = cloned.receiverAssessment;
    }
    // Body condition starts empty on new handover — user picks Previous or New per view via Add.
    if (!Object.keys(patch).length) return { applied: false, reason: 'empty_previous_reports' };

    record.details = {
        ...existing,
        ...patch,
        vehicleHandoverWorkflow: {
            ...(existing.vehicleHandoverWorkflow && typeof existing.vehicleHandoverWorkflow === 'object'
                ? existing.vehicleHandoverWorkflow
                : {}),
            reportsCopiedFromPreviousAssignment: true,
        },
    };
    record.markModified('details');
    await record.save();
    return { applied: true, patched: Object.keys(patch) };
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

export async function applyPreviousHandoverReportsToHistory({
    historyId,
    assetId,
    assigneeDoc,
    preserveCompleteBody = false,
}) {
    const record = await AssetHistory.findById(historyId);
    if (!record) return { applied: false, reason: 'history_not_found' };

    const prevDetails = await findPreviousCompletedHandoverDetails(assetId, historyId);
    if (!prevDetails) return { applied: false, reason: 'no_previous_reports' };

    const existingPreview =
        record.details && typeof record.details === 'object' ? record.details : {};
    const cloned = cloneHandoverReportFields(prevDetails);
    if (preserveCompleteBody && currentHandoverBodyPhotosAdded(existingPreview)) {
        const copiedAssessment = Boolean(cloned.receiverAssessment);
        delete cloned.bodyConditionReport;
        cloned.bodyConditionCompleted = true;
        if (!copiedAssessment) {
            if (
                existingPreview.receiverAssessmentCompleted === true ||
                isReceiverAssessmentComplete(existingPreview)
            ) {
                cloned.receiverAssessmentCompleted = true;
            } else {
                delete cloned.receiverAssessmentCompleted;
            }
        }
    }
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

    const historyBeforeCopy = await AssetHistory.findById(historyId).select('details').lean();
    if (!historyBeforeCopy) return { ok: false, reason: 'history_not_found' };

    const previousSeed = await findPreviousHandoverDetailsForSeed(item._id, historyId);
    const previousBody = previousSeed?.bodyConditionReport || previousSeed?.bodyCondition || null;
    const imageDecision = handoverMissingImagesDecision(historyBeforeCopy.details || {}, previousBody);
    if (imageDecision.block) {
        const adminOfficer = await resolveAdminOfficerEmployee();
        const alreadyNotified = Boolean(flow.escalation?.imagesMissingNotifiedAt);
        if (adminOfficer?._id && !alreadyNotified) {
            item.pendingActionDetails = {
                ...(item.pendingActionDetails || {}),
                vehicleHandoverFlow: {
                    ...flow,
                    escalation: {
                        ...(flow.escalation || {}),
                        imagesMissingNotifiedAt: new Date(),
                        imagesMissingReason: imageDecision.noPreviousPhoto
                            ? 'no_previous_photo'
                            : 'photos_not_added',
                    },
                },
            };
            item.markModified('pendingActionDetails');
            await item.save();
        }
        const assigneeId = item.assignedTo?._id || item.assignedTo;
        const assigneeDoc = assigneeId
            ? await EmployeeBasic.findById(assigneeId)
                  .select('firstName lastName employeeId')
                  .lean()
            : null;
        if (adminOfficer?._id) {
            await notifyAdminOfficerHandoverImagesMissing({
                asset: item,
                historyId,
                adminOfficer,
                assigneeDoc,
                noPreviousPhoto: imageDecision.noPreviousPhoto,
                sendEmail: !alreadyNotified,
            });
        }
        return { ok: false, reason: 'images_missing' };
    }

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
        preserveCompleteBody: true,
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
            'Vehicle handover auto-accepted after 10 days. Body condition images already on this handover were kept and it moved to the next step.',
        date: new Date(),
        details: {
            auto: true,
            reason: 'FleetHandoverAutoAccept',
            historyId: String(historyId),
            reportsCopiedFromPrevious: copyResult.applied === true,
        },
    }).catch(() => null);

    await closeHandoverImagesMissingNotice(
        item._id,
        'Body condition images are on the handover',
    ).catch(() => null);

    return { ok: true, advanced: !!advance.advanced, finalized: !!advance.finalize };
}

async function ensureHandoverImagesMissingTask(action, adminOfficer, message) {
    if (!action?._id || !adminOfficer?._id) return null;
    const assigneeName = formatEmployeeDisplayName(adminOfficer);
    const existing = await TaskManagerTask.findOne({
        sourceDashboardActionId: action._id,
        status: { $ne: 'Cancelled' },
    }).sort({ updatedAt: -1 });

    if (existing) {
        existing.taskType = 'System Task';
        existing.priority = 'High';
        existing.taskName = 'Handover Images Missing';
        existing.description = message;
        existing.assignee = adminOfficer._id;
        existing.assigneeEmpId = adminOfficer.employeeId || existing.assigneeEmpId || '';
        if (assigneeName) existing.assigneeName = assigneeName;
        existing.requestedByName = existing.requestedByName || 'System';
        if (['Completed', 'Rejected'].includes(String(existing.status || ''))) {
            existing.status = 'Pending';
        }
        await existing.save();
        return existing;
    }

    return TaskManagerTask.create({
        sourceDashboardActionId: action._id,
        taskType: 'System Task',
        priority: 'High',
        taskName: 'Handover Images Missing',
        description: message,
        assignee: adminOfficer._id,
        assigneeEmpId: adminOfficer.employeeId || '',
        assigneeName,
        completionDate: new Date(),
        requestedByName: 'System',
        status: 'Pending',
        history: [
            {
                event: 'Created',
                detail: message,
                actorName: 'System',
                createdAt: new Date(),
            },
        ],
    });
}

export async function notifyAdminOfficerHandoverImagesMissing({
    asset,
    historyId,
    adminOfficer,
    assigneeDoc = null,
    noPreviousPhoto = false,
    sendEmail = false,
}) {
    if (!adminOfficer?._id || !asset?._id || !historyId) return null;
    const message = handoverImagesMissingMessage({ noPreviousPhoto });
    const vehicleLabel = `${asset.assetId || 'Vehicle'}${asset.name ? ` — ${asset.name}` : ''}`;
    const assigneeName = formatEmployeeDisplayName(assigneeDoc);
    const extra3 = JSON.stringify({
        isFleetVehicle: true,
        vehicleMongoId: String(asset._id),
        vehicleId: String(asset._id),
        historyId: String(historyId),
        detailsPath: buildHandoverAssignDetailsPath(asset._id, historyId),
        handoverImagesMissing: true,
        noPreviousPhoto: Boolean(noPreviousPhoto),
    });

    const action = await DashboardAction.findOneAndUpdate(
        {
            requestId: asset._id,
            requestType: HANDOVER_IMAGES_MISSING_REQUEST_TYPE,
            status: 'Pending',
        },
        {
            $set: {
                assignedTo: adminOfficer._id,
                assignedToEmpId: adminOfficer.employeeId || '',
                requestId: asset._id,
                requestType: HANDOVER_IMAGES_MISSING_REQUEST_TYPE,
                status: 'Pending',
                subjectEmployeeId: assigneeDoc?.employeeId || '',
                subjectName: assigneeName || asset.name || 'Vehicle',
                requestedByName: 'System',
                extra1: vehicleLabel,
                extra2: message,
                extra3,
                comment: message,
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    await ensureHandoverImagesMissingTask(action, adminOfficer, message);

    if (sendEmail) {
        await sendFleetHandoverImagesMissingEmail({
            asset,
            historyId,
            adminOfficer,
            assigneeDoc,
            message,
        });
        await AssetHistory.create({
            assetId: asset._id,
            action: 'Comment',
            performedBy: null,
            comments: message,
            date: new Date(),
            details: {
                auto: true,
                reason: 'FleetHandoverImagesMissing',
                historyId: String(historyId),
                noPreviousPhoto: Boolean(noPreviousPhoto),
                adminOfficerEmployeeId: adminOfficer.employeeId || '',
            },
        }).catch(() => null);
    }

    return action;
}

export async function closeHandoverImagesMissingNotice(assetId, comment = 'Body condition images were added') {
    if (!assetId) return;
    const rows = await DashboardAction.find({
        requestId: assetId,
        requestType: HANDOVER_IMAGES_MISSING_REQUEST_TYPE,
        status: 'Pending',
    })
        .select('_id')
        .lean();
    if (!rows.length) return;
    const ids = rows.map((row) => row._id);
    await DashboardAction.updateMany(
        { _id: { $in: ids } },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment,
            },
        },
    );
    await TaskManagerTask.updateMany(
        {
            sourceDashboardActionId: { $in: ids },
            status: { $nin: ['Completed', 'Cancelled', 'Rejected'] },
        },
        { $set: { status: 'Completed' } },
    );
}

export function buildInitialHandoverEscalationMeta(requestedAt = new Date()) {
    return {
        requestedAt: requestedAt instanceof Date ? requestedAt : new Date(requestedAt),
        lastReminderDay: null,
    };
}

export async function resolveHandoverEscalationRequestedAt(historyId, fallbackDate = new Date()) {
    if (!historyId) return fallbackDate instanceof Date ? fallbackDate : new Date(fallbackDate);
    const history = await AssetHistory.findById(historyId).select('createdAt date').lean();
    const resolved = history?.createdAt || history?.date || fallbackDate;
    return resolved instanceof Date ? resolved : new Date(resolved);
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
