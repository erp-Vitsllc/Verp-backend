import EmployeeBasic from '../models/EmployeeBasic.js';
import EmployeeDrivingLicense from '../models/EmployeeDrivingLicense.js';
import User from '../models/User.js';
import DashboardAction from '../models/DashboardAction.js';
import Flowchart from '../models/Flowchart.js';
import AssetHistory from '../models/AssetHistory.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { resolveAssetControllerEmployee, getResolvedFleetHrEmployee } from './assetApprovalHelpers.js';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import { sendAssetAssignmentEmail } from './sendAssetAssignmentEmail.js';
import { sendAssetResponseEmail } from './sendAssetResponseEmail.js';
import nodemailer from 'nodemailer';
import { pickEffectiveEmail } from './resolveEmployeeEmail.js';
import { normalizeS3Key } from './s3Upload.js';

export const HANDOVER_FLOW_STAGES = {
    TARGET: 'target',
    HOD: 'hod',
    HR: 'hr',
    /** @deprecated use HR — kept for in-flight records */
    MANAGEMENT: 'management',
};

export function formatEmployeeDisplayName(emp) {
    if (!emp) return '';
    if (typeof emp === 'string') return emp.trim();
    const name = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();
    return name || String(emp.employeeId || '').trim();
}

export function formatHandoverPersonDisplayLabel(person) {
    const name = formatEmployeeDisplayName(person);
    const empId = String(person?.employeeId || '').trim();
    if (name && empId) return `${name} (${empId})`;
    return name || empId || '—';
}

/** Name shown on fleet pending badges — assignee when they can self-acknowledge, else admin officer. */
export function buildHandoverFlowPendingActorName(assignee, fleetActor) {
    if (!fleetActor) {
        return formatHandoverPersonDisplayLabel(assignee) || '';
    }
    if (fleetActor.assigneeCanSelfAcknowledge) {
        return (
            formatHandoverPersonDisplayLabel(assignee) ||
            formatHandoverPersonDisplayLabel(fleetActor.actorDoc) ||
            ''
        );
    }
    return formatHandoverPersonDisplayLabel(fleetActor.actorDoc) || 'Admin Officer';
}

/** Frozen table labels — do not derive from live asset after creation. */
export function buildFleetHandoverDisplayLabels({
    workflowMeta = null,
    assigner = null,
    assignee = null,
    previousAssignee = null,
    adminOfficer = null,
    isInspection = false,
    isReinspection = false,
    isReturn = false,
}) {
    if (isReturn) {
        const returningEmp = previousAssignee || assignee;
        const adminLabel =
            workflowMeta?.stages?.target?.actorName ||
            formatHandoverPersonDisplayLabel(adminOfficer) ||
            '—';
        return {
            handoverByDisplay: formatHandoverPersonDisplayLabel(returningEmp) || '—',
            handoverToDisplay: adminLabel,
        };
    }
    if (isInspection) {
        // Custodian = assigned owner if vehicle is assigned, else Admin Officer.
        const custodian = previousAssignee || adminOfficer || assignee;
        const custodianLabel = formatHandoverPersonDisplayLabel(custodian) || '—';
        if (isReinspection) {
            // Reinspection: By and To are both the custodian.
            return {
                handoverByDisplay: custodianLabel,
                handoverToDisplay: custodianLabel,
            };
        }
        // First inspection: By stays empty; To = custodian.
        return {
            handoverByDisplay: '—',
            handoverToDisplay: custodianLabel,
        };
    }

    // Assign / reassign: By = Admin Officer if unassigned (from pool), else current assigned owner;
    // To = targeted user.
    const fromPool = Boolean(workflowMeta?.wasAssignedFromPool);
    let handoverByDisplay;
    if (fromPool || !previousAssignee) {
        handoverByDisplay =
            formatHandoverPersonDisplayLabel(adminOfficer) ||
            workflowMeta?.stages?.assigner?.actorName ||
            formatHandoverPersonDisplayLabel(assigner) ||
            '—';
    } else {
        handoverByDisplay = formatHandoverPersonDisplayLabel(previousAssignee) || '—';
    }

    const handoverToDisplay = formatHandoverPersonDisplayLabel(assignee) || '—';
    return { handoverByDisplay, handoverToDisplay };
}

const HANDOVER_HISTORY_IMMUTABLE_DETAIL_KEYS = [
    'handoverByDisplay',
    'handoverToDisplay',
    'vehicleHandoverWorkflow',
    'handoverKind',
    'handoverLifecycleStatus',
    'handoverTargetAcceptedAt',
    'handoverHrApprovedAt',
    'firstInspection',
    'reinspection',
    'inspectionFormStatus',
    'inspectionReview',
    'reportsCopiedFromPreviousAssignment',
];

export function preserveHandoverHistoryImmutableDetails(existingDetails = {}, mergedDetails = {}) {
    const next = { ...mergedDetails };
    for (const key of HANDOVER_HISTORY_IMMUTABLE_DETAIL_KEYS) {
        if (existingDetails[key] !== undefined && existingDetails[key] !== null) {
            next[key] = existingDetails[key];
        }
    }
    return next;
}

export const VEHICLE_RETURN_HANDOVER_KIND = 'vehicle_return';

export function isReturnHandoverHistoryRecord(record) {
    if (!record) return false;
    if (String(record?.details?.handoverKind || '').trim() === VEHICLE_RETURN_HANDOVER_KIND) {
        return true;
    }
    return String(record?.action || '').trim() === 'Returned' &&
        !!record?.details?.vehicleHandoverWorkflow &&
        !record?.details?.handoverKind;
}

export function buildReturnHandoverWorkflowMeta({ adminOfficer, requester, prevAssignee, assignDate = new Date() }) {
    const adminName = formatEmployeeDisplayName(adminOfficer);
    return {
        handoverKind: VEHICLE_RETURN_HANDOVER_KIND,
        assigneeCanSelfAcknowledge: false,
        assignerUsesAdminOfficer: true,
        prevAssigneeId: prevAssignee?._id?.toString?.() || '',
        stages: {
            assigner: {
                actorName: '—',
                actorId: requester?._id?.toString?.() || '',
                actorEmployeeId: String(requester?.employeeId || '').trim(),
                date: assignDate,
            },
            target: {
                actorName: adminName,
                actorId: adminOfficer?._id?.toString?.() || '',
                actorEmployeeId: String(adminOfficer?.employeeId || '').trim(),
                date: null,
            },
            hod: { actorName: null, date: null },
            hr: { actorName: null, date: null },
        },
    };
}

export function buildInitialHandoverWorkflowMeta({
    assigneeCanSelfAcknowledge,
    assigner,
    assignee,
    firstActorDoc,
    assignerActorDoc = null,
    wasAssignedFromPool = false,
    previousAssignee = null,
    assignDate = new Date(),
}) {
    const assignerStageDoc = assignerActorDoc || assigner;
    const assignerName = formatEmployeeDisplayName(assignerStageDoc);
    const assigneeName = formatEmployeeDisplayName(assignee);
    const targetStageDoc = assigneeCanSelfAcknowledge ? assignee : firstActorDoc;
    const targetStageName = formatEmployeeDisplayName(targetStageDoc) || assigneeName;

    return {
        assigneeCanSelfAcknowledge: !!assigneeCanSelfAcknowledge,
        assignerUsesAdminOfficer: Boolean(
            assignerStageDoc &&
                assigner &&
                String(assignerStageDoc._id || assignerStageDoc) !== String(assigner._id || assigner),
        ),
        wasAssignedFromPool: !!wasAssignedFromPool,
        ...(previousAssignee?._id
            ? { previousAssigneeId: previousAssignee._id.toString() }
            : {}),
        stages: {
            assigner: {
                actorName: assignerName,
                actorId: assignerStageDoc?._id?.toString?.() || '',
                date: assignDate,
            },
            target: {
                actorName: targetStageName,
                actorId: targetStageDoc?._id?.toString?.() || '',
                date: null,
            },
            hod: { actorName: null, date: null },
            hr: { actorName: null, date: null },
        },
    };
}

/** Attach digital signatures to workflow stage actors for PDF / handover views. */
export async function enrichHandoverWorkflowActorSignatures(recordObj, signFileUrl) {
    const workflow = recordObj?.details?.vehicleHandoverWorkflow;
    if (!workflow?.stages || typeof workflow.stages !== 'object') return recordObj;

    const stages = { ...workflow.stages };
    const stageKeys = ['assigner', 'target', 'hod', 'hr', 'management'];

    const resolveActorEmployee = async (stage) => {
        const actorId = String(stage?.actorId || '').trim();
        if (actorId) {
            const byId = await EmployeeBasic.findById(actorId).select('signature employeeId').lean();
            if (byId) return byId;
        }
        const empCode = String(stage?.actorEmployeeId || '').trim();
        if (!empCode) return null;
        const escapeRegExp = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return EmployeeBasic.findOne({
            employeeId: {
                $regex: new RegExp(`^${escapeRegExp(empCode).replace(/\s+/g, '\\s*')}$`, 'i'),
            },
        })
            .select('signature employeeId')
            .lean();
    };

    await Promise.all(
        stageKeys.map(async (key) => {
            const stage = stages[key];
            if (!stage) return;

            try {
                const emp = await resolveActorEmployee(stage);
                if (!emp?.signature) return;

                const raw = emp.signature;
                const actorSignature = {
                    ...(typeof raw === 'object' && raw ? raw : {}),
                };
                const keyOrUrl = String(
                    actorSignature.publicId || actorSignature.url || actorSignature.path || '',
                ).trim();
                if (!keyOrUrl) return;

                if (typeof signFileUrl === 'function') {
                    const signed = await signFileUrl(keyOrUrl);
                    if (signed) {
                        actorSignature.url = signed;
                        if (!actorSignature.publicId && !/^https?:\/\//i.test(keyOrUrl) && !keyOrUrl.startsWith('data:')) {
                            actorSignature.publicId = keyOrUrl;
                        }
                    } else if (!actorSignature.url) {
                        actorSignature.url = keyOrUrl.startsWith('http') || keyOrUrl.startsWith('data:')
                            ? keyOrUrl
                            : '';
                    }
                } else if (!actorSignature.url) {
                    actorSignature.url = keyOrUrl;
                }

                if (!actorSignature.url && !actorSignature.publicId && !actorSignature.data) return;

                stages[key] = {
                    ...stage,
                    actorId: stage.actorId || emp._id?.toString?.() || '',
                    actorEmployeeId:
                        stage.actorEmployeeId || String(emp.employeeId || '').trim() || '',
                    actorSignature,
                };
            } catch {
                /* non-fatal */
            }
        }),
    );

    recordObj.details = {
        ...(recordObj.details && typeof recordObj.details === 'object' ? recordObj.details : {}),
        vehicleHandoverWorkflow: {
            ...workflow,
            stages,
        },
    };

    return recordObj;
}

/** Sign receiver-assessment and body-condition photos before API responses. */
export async function signHandoverAssessmentMediaInDetails(details, signFileUrl) {
    if (!details || typeof details !== 'object' || typeof signFileUrl !== 'function') return details;

    const signPhotoValue = async (photo) => {
        if (photo == null || photo === '') return photo;

        if (typeof photo === 'string') {
            const trimmed = photo.trim();
            if (!trimmed) return photo;
            if (trimmed.startsWith('data:')) return trimmed;

            const storageKey = normalizeS3Key(trimmed);
            if (storageKey) {
                const signed = await signFileUrl(storageKey);
                return signed || trimmed;
            }
            if (trimmed.startsWith('http')) return trimmed;

            const signed = await signFileUrl(trimmed);
            return signed || trimmed;
        }

        if (typeof photo === 'object' && !Array.isArray(photo)) {
            const next = { ...photo };
            const ref = next.publicId || next.url || next.path;
            if (ref) {
                const storageKey = normalizeS3Key(String(ref));
                if (storageKey) {
                    const signed = await signFileUrl(storageKey);
                    if (signed) next.url = signed;
                } else if (typeof next.url === 'string' && next.url.trim().startsWith('http')) {
                    return next;
                }
            }
            return next;
        }

        return photo;
    };

    const signPhotoMap = async (map) => {
        if (!map || typeof map !== 'object') return map;
        const next = { ...map };
        await Promise.all(
            Object.keys(next).map(async (key) => {
                const row = next[key];
                if (!row || typeof row !== 'object' || !('photo' in row)) return;
                next[key] = { ...row, photo: await signPhotoValue(row.photo) };
            }),
        );
        return next;
    };

    if (details.receiverAssessment) {
        details.receiverAssessment = await signPhotoMap(details.receiverAssessment);
    }
    if (details.vehicleAssessmentReportByReceiver) {
        details.vehicleAssessmentReportByReceiver = await signPhotoMap(details.vehicleAssessmentReportByReceiver);
    }
    if (details.bodyConditionReport) {
        details.bodyConditionReport = await signPhotoMap(details.bodyConditionReport);
    }
    if (details.bodyCondition) {
        details.bodyCondition = await signPhotoMap(details.bodyCondition);
    }

    return details;
}

export async function persistHandoverWorkflowMeta(historyId, workflowMeta) {
    if (!historyId || !workflowMeta) return;
    const record = await AssetHistory.findById(historyId).select('details').lean();
    if (!record) return;

    await AssetHistory.findByIdAndUpdate(historyId, {
        $set: {
            details: {
                ...(record.details && typeof record.details === 'object' ? record.details : {}),
                vehicleHandoverWorkflow: workflowMeta,
            },
        },
    });
}

export async function recordHandoverStageApproval(historyId, stageKey, actor, approvedAt = new Date()) {
    if (!historyId || !stageKey || !actor) return;

    const record = await AssetHistory.findById(historyId).select('details').lean();
    if (!record) return;

    const existing =
        record.details?.vehicleHandoverWorkflow && typeof record.details.vehicleHandoverWorkflow === 'object'
            ? record.details.vehicleHandoverWorkflow
            : { stages: {} };

    const stages = { ...(existing.stages || {}) };
    stages[stageKey] = {
        actorName: formatEmployeeDisplayName(actor),
        actorId: actor._id?.toString?.() || '',
        date: approvedAt,
    };

    await persistHandoverWorkflowMeta(historyId, {
        ...existing,
        stages,
    });
}

/** Update the original Assigned handover row — do not create a second history entry. */
export const HANDOVER_LIFECYCLE = {
    PENDING: 'pending',
    ACCEPTED: 'accepted',
    APPROVED: 'approved',
    REJECTED: 'rejected',
};

export async function markHandoverLifecycleOnHistory(historyId, lifecycle, extraFields = {}) {
    if (!historyId || !lifecycle) return;
    const patch = {
        'details.handoverLifecycleStatus': lifecycle,
        ...extraFields,
    };
    await AssetHistory.findByIdAndUpdate(historyId, { $set: patch });
}

export async function resolvePreviousHandoverAssignee(assetId, currentHistoryId) {
    if (!assetId) return null;
    const current = currentHistoryId
        ? await AssetHistory.findById(currentHistoryId).select('createdAt date').lean()
        : null;
    const beforeDate = current?.createdAt || current?.date;

    const filter = {
        assetId,
        action: { $in: ['Assigned', 'Accepted'] },
        assignedTo: { $ne: null },
        'details.handoverKind': { $ne: 'vehicle_inspection' },
        'details.firstInspection': { $ne: true },
    };
    if (currentHistoryId) filter._id = { $ne: currentHistoryId };
    if (beforeDate) filter.createdAt = { $lt: beforeDate };

    const row = await AssetHistory.findOne(filter)
        .sort({ createdAt: -1 })
        .select('assignedTo')
        .lean();
    if (!row?.assignedTo) return null;
    return EmployeeBasic.findById(row.assignedTo)
        .select('firstName lastName employeeId companyEmail workEmail personalEmail email')
        .lean();
}

export async function updateFleetHandoverHistoryRecord({
    historyId,
    action,
    performedBy,
    comments,
    snapshotItem = null,
    detailsPatch = {},
}) {
    if (!historyId) return null;

    const existing = await AssetHistory.findById(historyId);
    if (!existing) return null;

    const snapshotObj =
        snapshotItem && typeof snapshotItem.toObject === 'function'
            ? snapshotItem.toObject()
            : snapshotItem && typeof snapshotItem === 'object'
              ? snapshotItem
              : null;

    const mergedDetails = preserveHandoverHistoryImmutableDetails(
        existing.details && typeof existing.details === 'object' ? existing.details : {},
        {
            ...(snapshotObj || {}),
            ...(existing.details && typeof existing.details === 'object' ? existing.details : {}),
            ...detailsPatch,
        },
    );

    if (action === 'Accepted') {
        mergedDetails.acceptanceStatus = 'Accepted';
        mergedDetails.handoverLifecycleStatus = HANDOVER_LIFECYCLE.APPROVED;
        mergedDetails.handoverHrApprovedAt = new Date();
    } else if (action === 'Rejected') {
        mergedDetails.acceptanceStatus = 'Rejected';
        mergedDetails.handoverLifecycleStatus = HANDOVER_LIFECYCLE.REJECTED;
    }

    existing.action = action;
    existing.performedBy = performedBy;
    if (comments !== undefined && comments !== null) {
        existing.comments = comments;
    }
    existing.details = mergedDetails;
    existing.markModified('details');
    await existing.save();

    return existing;
}

export function resolveFleetHandoverHistoryId(handoverFlow, historyRecord = null) {
    return (
        handoverFlow?.historyId ||
        historyRecord?._id?.toString?.() ||
        (historyRecord?._id ? String(historyRecord._id) : null)
    );
}

const RECEIVER_ASSESSMENT_KEYS = [
    'spareTyre',
    'toolsKit',
    'scissorJack',
    'firstAidKit',
    'fireExtinguisher',
];

const BODY_CONDITION_KEYS = [
    'frontView',
    'backView',
    'frontRightCorner',
    'backRightCorner',
    'frontLeftCorner',
    'backLeftCorner',
    'frontRightDoor',
    'backRightDoor',
    'frontLeftDoor',
    'backLeftDoor',
    'frontInsideView',
    'backInsideView',
    'frontDashBoard',
    'carTopView',
];

function hasDrivingLicenseCard(details) {
    if (!details || typeof details !== 'object') return false;
    if (!String(details.number || '').trim()) return false;
    const document = details.document;
    return Boolean(
        document?.url ||
            document?.data ||
            document?.publicId ||
            (typeof document === 'string' && document.trim()),
    );
}

function hasPhotoValue(photo) {
    if (!photo) return false;
    if (typeof photo === 'string') return !!String(photo).trim();
    if (typeof photo === 'object') {
        return Boolean(photo.url || photo.publicId || photo.data || photo.path);
    }
    return false;
}

export async function employeeHasDrivingLicense(employeeId) {
    if (!employeeId) return false;
    const row = await EmployeeDrivingLicense.findOne({ employeeId: String(employeeId) })
        .select('drivingLicenceDetails')
        .lean();
    return hasDrivingLicenseCard(row?.drivingLicenceDetails);
}

/** Profile driving-license start (issue) date for Hand Over To / assignee. */
export async function getEmployeeDrivingLicenseIssueDate(employeeId) {
    if (!employeeId) return null;
    const row = await EmployeeDrivingLicense.findOne({ employeeId: String(employeeId) })
        .select('drivingLicenceDetails.issueDate')
        .lean();
    return row?.drivingLicenceDetails?.issueDate || null;
}

/**
 * Attach profile `drivingLicenceDetails.issueDate` onto populated `assignedTo`
 * so handover UI can compute Driving License Age (issue date → today).
 */
export async function attachAssigneeDrivingLicenseIssueDate(assignedTo) {
    if (!assignedTo || typeof assignedTo !== 'object') return assignedTo;
    if (assignedTo.drivingLicenceDetails?.issueDate || assignedTo.drivingLicenseDetails?.issueDate) {
        return assignedTo;
    }
    const employeeId = assignedTo.employeeId;
    if (!employeeId) return assignedTo;
    const issueDate = await getEmployeeDrivingLicenseIssueDate(employeeId);
    if (!issueDate) return assignedTo;
    assignedTo.drivingLicenceDetails = {
        ...(assignedTo.drivingLicenceDetails && typeof assignedTo.drivingLicenceDetails === 'object'
            ? assignedTo.drivingLicenceDetails
            : {}),
        issueDate,
    };
    return assignedTo;
}

/** Batch-attach license issue dates for handover history list rows. */
export async function attachAssigneeDrivingLicenseIssueDates(records = []) {
    if (!Array.isArray(records) || records.length === 0) return records;
    const employeeIds = [
        ...new Set(
            records
                .map((row) => row?.assignedTo?.employeeId)
                .filter(Boolean)
                .map((id) => String(id)),
        ),
    ];
    if (employeeIds.length === 0) return records;

    const licenseRows = await EmployeeDrivingLicense.find({ employeeId: { $in: employeeIds } })
        .select('employeeId drivingLicenceDetails.issueDate')
        .lean();
    const issueByEmployeeId = new Map(
        licenseRows
            .filter((row) => row?.drivingLicenceDetails?.issueDate)
            .map((row) => [String(row.employeeId), row.drivingLicenceDetails.issueDate]),
    );

    for (const record of records) {
        const assignee = record?.assignedTo;
        if (!assignee || typeof assignee !== 'object') continue;
        if (assignee.drivingLicenceDetails?.issueDate || assignee.drivingLicenseDetails?.issueDate) {
            continue;
        }
        const issueDate = issueByEmployeeId.get(String(assignee.employeeId || ''));
        if (!issueDate) continue;
        assignee.drivingLicenceDetails = {
            ...(assignee.drivingLicenceDetails && typeof assignee.drivingLicenceDetails === 'object'
                ? assignee.drivingLicenceDetails
                : {}),
            issueDate,
        };
    }
    return records;
}

export async function employeeHasActivePortalUser(emp) {
    const empId = emp?.employeeId;
    if (!empId) return false;
    const user = await User.findOne({ employeeId: String(empId), status: 'Active' })
        .select('enablePortalAccess')
        .lean();
    return !!(user && user.enablePortalAccess === true);
}

export function assigneeHasCompanyEmail(emp) {
    return !!(emp?.companyEmail && String(emp.companyEmail).trim().length > 0);
}

export async function assigneeCanSelfAcknowledgeFleetHandover(emp) {
    if (!emp || !assigneeHasCompanyEmail(emp)) return false;
    if (emp.enablePortalAccess === true) return true;
    return employeeHasActivePortalUser(emp);
}

export async function resolveAdminOfficerEmployee() {
    const row = await getDepartmentHOD('admincontroller');
    if (!row) return null;
    return resolveAssetControllerEmployee(row);
}

export async function resolveHrEmployee() {
    return getResolvedFleetHrEmployee();
}

export async function resolveHodEmployee(assignee) {
    const pr = assignee?.primaryReportee;
    if (!pr) return null;
    if (typeof pr === 'object' && pr._id) return pr;
    return EmployeeBasic.findById(pr)
        .select('firstName lastName employeeId companyEmail workEmail personalEmail email enablePortalAccess')
        .lean();
}

export async function resolveFleetHandoverAssignerActor({
    assigner,
    previousAssignee = null,
    wasFromPool = false,
    adminOfficer = null,
}) {
    const ownerCanSelfServe = previousAssignee
        ? await assigneeCanSelfAcknowledgeFleetHandover(previousAssignee)
        : true;

    const useAdminOfficer =
        wasFromPool || (previousAssignee && !ownerCanSelfServe);

    if (useAdminOfficer && adminOfficer?._id) {
        return {
            actorDoc: adminOfficer,
            actorId: adminOfficer._id,
            usesAdminOfficer: true,
        };
    }

    return {
        actorDoc: assigner,
        actorId: assigner?._id || null,
        usesAdminOfficer: false,
    };
}

async function resolveFleetHandoverTargetRecipient({
    assignee,
    assigneeCanSelfAcknowledge,
    adminOfficer,
}) {
    if (!assigneeCanSelfAcknowledge) return adminOfficer;
    if (assignee?._id) {
        return typeof assignee === 'object' && assignee.employeeId
            ? assignee
            : EmployeeBasic.findById(assignee._id || assignee)
                  .select('firstName lastName employeeId companyEmail workEmail personalEmail email')
                  .lean();
    }
    return adminOfficer;
}

export async function resolvePreviousHandoverRejectionRecipient(
    stage,
    { assigner, assignee, assigneeCanSelfAcknowledge, adminOfficer, historyId },
) {
    let assignerUsesAdmin = false;
    if (historyId) {
        const record = await AssetHistory.findById(historyId).select('details').lean();
        assignerUsesAdmin = !!record?.details?.vehicleHandoverWorkflow?.assignerUsesAdminOfficer;
    }

    if (
        stage === HANDOVER_FLOW_STAGES.HR ||
        stage === HANDOVER_FLOW_STAGES.MANAGEMENT ||
        stage === HANDOVER_FLOW_STAGES.HOD
    ) {
        return resolveFleetHandoverTargetRecipient({
            assignee,
            assigneeCanSelfAcknowledge,
            adminOfficer,
        });
    }

    if (stage === HANDOVER_FLOW_STAGES.TARGET) {
        if (assignerUsesAdmin) return adminOfficer;
        if (assigner?._id || typeof assigner === 'object') {
            return typeof assigner === 'object' && assigner.employeeId
                ? assigner
                : EmployeeBasic.findById(assigner._id || assigner)
                      .select('firstName lastName employeeId companyEmail workEmail personalEmail email')
                      .lean();
        }
        return adminOfficer;
    }

    return adminOfficer;
}

export async function notifyHandoverRejectedToPrevious({
    asset,
    recipient,
    actor,
    comment,
    historyId,
    stageLabel = 'Vehicle Handover',
}) {
    const email = pickEffectiveEmail(recipient);
    if (!email) {
        const adminOfficer = await resolveAdminOfficerEmployee();
        await notifyHandoverRejectedToAdmin({
            asset,
            adminOfficer,
            actor,
            comment,
            historyId,
        });
        return;
    }

    const detailsUrl = buildHandoverAssignDetailsUrl(asset._id, historyId);
    const actorName = formatEmployeeDisplayName(actor) || 'User';
    const recipientName = formatEmployeeDisplayName(recipient) || 'User';

    await sendSimpleEmail({
        to: email,
        subject: `Vehicle handover rejected (${stageLabel}): ${asset.assetId} — ${asset.name || ''}`,
        html: `
            <p>Hi ${recipientName},</p>
            <p>The vehicle handover for <strong>${asset.name || ''}</strong> (${asset.assetId}) was rejected at the <strong>${stageLabel}</strong> step by ${actorName}.</p>
            ${comment ? `<p><strong>Reason:</strong> ${comment}</p>` : ''}
            <p><a href="${detailsUrl}">View handover details</a></p>
        `,
    }).catch(() => null);
}

export async function resolveFleetHandoverFirstActor(employeeToAssign) {
    const canSelf = await assigneeCanSelfAcknowledgeFleetHandover(employeeToAssign);
    if (canSelf) {
        return {
            actorId: employeeToAssign._id,
            actorDoc: employeeToAssign,
            assigneeCanSelfAcknowledge: true,
        };
    }
    const adminOfficer = await resolveAdminOfficerEmployee();
    return {
        actorId: adminOfficer?._id || null,
        actorDoc: adminOfficer,
        assigneeCanSelfAcknowledge: false,
    };
}

export function buildHandoverAssignDetailsPath(assetId, historyId) {
    return `/HRM/Asset/Vehicle/details/${encodeURIComponent(String(assetId))}/assign/${encodeURIComponent(String(historyId))}`;
}

export function buildHandoverAssignDetailsUrl(assetId, historyId) {
    const base = String(emailFrontendUrl() || '').replace(/\/+$/, '');
    return `${base}${buildHandoverAssignDetailsPath(assetId, historyId)}`;
}

export function buildHandoverAttachmentTabUrl(assetId, historyId) {
    return `${buildHandoverAssignDetailsUrl(assetId, historyId)}?tab=attachment`;
}

export function buildVehicleDetailUrl(assetId) {
    const base = String(emailFrontendUrl() || '').replace(/\/+$/, '');
    return `${base}/HRM/Asset/Vehicle/details/${encodeURIComponent(String(assetId))}?tab=handover`;
}

export function buildHandoverDashboardExtra3(assetId, historyId, options = {}) {
    const { viewerRole = 'actor' } = options;
    return JSON.stringify({
        isFleetVehicle: true,
        vehicleMongoId: String(assetId),
        historyId: String(historyId),
        detailsPath: buildHandoverAssignDetailsPath(assetId, historyId),
        handoverViewerRole: viewerRole,
    });
}

const HANDOVER_ACTOR_ROW_FILTER = {
    extra3: { $regex: '"handoverViewerRole"\\s*:\\s*"actor"', $options: 'i' },
};

const HANDOVER_ASSIGNER_ROW_FILTER = {
    extra3: { $regex: '"handoverViewerRole"\\s*:\\s*"assigner"', $options: 'i' },
};

const HANDOVER_ADMIN_OFFICER_ROW_FILTER = {
    extra3: { $regex: '"handoverViewerRole"\\s*:\\s*"adminOfficer"', $options: 'i' },
};

const HANDOVER_TARGET_ASSIGNEE_ROW_FILTER = {
    extra3: { $regex: '"handoverViewerRole"\\s*:\\s*"targetAssignee"', $options: 'i' },
};

export function isFleetHandoverDashboardMeta(meta) {
    return meta?.isFleetVehicle === true && !!meta?.historyId;
}

export function isFleetHandoverTrackingViewerRole(viewerRole) {
    return ['assigner', 'adminOfficer', 'targetAssignee'].includes(String(viewerRole || '').trim());
}

export function getVehicleHandoverFlow(item) {
    return item?.pendingActionDetails?.vehicleHandoverFlow || null;
}

export function isReceiverAssessmentComplete(details = {}) {
    const source = details.receiverAssessment || details.vehicleAssessmentReportByReceiver || null;
    if (!source || typeof source !== 'object') return false;
    return RECEIVER_ASSESSMENT_KEYS.every((key) => {
        const row = source[key];
        if (!row || typeof row !== 'object') return false;
        const present = row.present === true || row.present === 'true';
        const absent = row.present === false || row.present === 'false';
        if (!present && !absent) return false;
        if (present && !hasPhotoValue(row.photo || row.image)) return false;
        return true;
    });
}

export function isBodyConditionReportComplete(details = {}) {
    const source = details.bodyConditionReport || details.bodyCondition || null;
    if (!source || typeof source !== 'object') return false;
    return BODY_CONDITION_KEYS.every((key) => {
        const row = source[key];
        if (!row || typeof row !== 'object') return false;
        return hasPhotoValue(row.photo || row.image);
    });
}

export function isHandoverReportsComplete(historyRecord) {
    const details = historyRecord?.details || {};
    const handoverKind = String(details.handoverKind || '').trim();
    if (handoverKind === 'vehicle_inspection') {
        return details.bodyConditionCompleted === true || isBodyConditionReportComplete(details);
    }
    if (details.receiverAssessmentCompleted === true && details.bodyConditionCompleted === true) {
        return true;
    }
    return isReceiverAssessmentComplete(details) && isBodyConditionReportComplete(details);
}

export function getHandoverReportsIncompleteError(historyRecord) {
    const details = historyRecord?.details || {};
    const handoverKind = String(details.handoverKind || '').trim();
    if (handoverKind === 'vehicle_inspection') {
        if (details.bodyConditionCompleted === true || isBodyConditionReportComplete(details)) {
            return null;
        }
        return 'Complete Body Condition Report (Go to Approval) before accepting.';
    }

    const assessmentOk =
        details.receiverAssessmentCompleted === true || isReceiverAssessmentComplete(details);
    const bodyOk =
        details.bodyConditionCompleted === true || isBodyConditionReportComplete(details);

    if (assessmentOk && bodyOk) return null;

    const missing = [];
    if (!assessmentOk) {
        missing.push('Vehicle Accessories (click Process Next)');
    }
    if (!bodyOk) {
        missing.push('Body Condition Report (click Go to Approval)');
    }
    return `Complete ${missing.join(' and ')} before accepting.`;
}

export async function upsertHandoverDashboardAction({
    asset,
    actor,
    assigner,
    historyId,
    stageLabel = 'Vehicle Handover',
    subjectName,
    subjectEmpId,
}) {
    if (!actor?._id) return;
    await DashboardAction.findOneAndUpdate(
        {
            requestId: asset._id,
            requestType: 'Asset Assignment',
            status: 'Pending',
            ...HANDOVER_ACTOR_ROW_FILTER,
        },
        {
            assignedTo: actor._id,
            assignedToEmpId: actor.employeeId,
            requestId: asset._id,
            requestType: 'Asset Assignment',
            subjectEmployeeId: subjectEmpId || '',
            subjectName: subjectName || '',
            requestedByName: assigner
                ? `${assigner.firstName || ''} ${assigner.lastName || ''}`.trim() || 'System'
                : 'System',
            extra1: `${asset.assetId} — ${asset.name || ''}`,
            extra2: stageLabel,
            extra3: buildHandoverDashboardExtra3(asset._id, historyId, { viewerRole: 'actor' }),
            status: 'Pending',
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}

/** Outgoing task for the admin/assigner — stays pending until HR final approval. */
export async function upsertHandoverAssignerDashboardAction({
    asset,
    assigner,
    historyId,
    subjectName,
    subjectEmpId,
}) {
    if (!assigner?._id || !historyId) return;
    const assignerName =
        `${assigner.firstName || ''} ${assigner.lastName || ''}`.trim() || 'System';
    await DashboardAction.findOneAndUpdate(
        {
            requestId: asset._id,
            requestType: 'Asset Assignment',
            status: 'Pending',
            ...HANDOVER_ASSIGNER_ROW_FILTER,
        },
        {
            assignedTo: assigner._id,
            assignedToEmpId: assigner.employeeId,
            requestId: asset._id,
            requestType: 'Asset Assignment',
            subjectEmployeeId: subjectEmpId || '',
            subjectName: subjectName || '',
            requestedByName: assignerName,
            extra1: `${asset.assetId} — ${asset.name || ''}`,
            extra2: 'Vehicle Handover — awaiting HR approval',
            extra3: buildHandoverDashboardExtra3(asset._id, historyId, { viewerRole: 'assigner' }),
            status: 'Pending',
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}

/** Tracking row for flowchart Admin Officer — stays pending until HR final approval. */
export async function upsertHandoverAdminOfficerDashboardAction({
    asset,
    adminOfficer,
    historyId,
    subjectName,
    subjectEmpId,
    stageLabel = 'Vehicle Handover — awaiting HR approval',
}) {
    if (!adminOfficer?._id || !historyId) return;
    await DashboardAction.findOneAndUpdate(
        {
            requestId: asset._id,
            requestType: 'Asset Assignment',
            status: 'Pending',
            ...HANDOVER_ADMIN_OFFICER_ROW_FILTER,
        },
        {
            assignedTo: adminOfficer._id,
            assignedToEmpId: adminOfficer.employeeId,
            requestId: asset._id,
            requestType: 'Asset Assignment',
            subjectEmployeeId: subjectEmpId || '',
            subjectName: subjectName || '',
            requestedByName: 'System',
            extra1: `${asset.assetId} — ${asset.name || ''}`,
            extra2: stageLabel,
            extra3: buildHandoverDashboardExtra3(asset._id, historyId, { viewerRole: 'adminOfficer' }),
            status: 'Pending',
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}

/** Tracking row for the new assignee — visible until HR final approval. */
export async function upsertHandoverTargetAssigneeDashboardAction({
    asset,
    assignee,
    historyId,
    subjectName,
    subjectEmpId,
    assigner = null,
    stageLabel = 'Vehicle Handover — assigned to you',
}) {
    if (!assignee?._id || !historyId) return;
    const assignerName = assigner
        ? `${assigner.firstName || ''} ${assigner.lastName || ''}`.trim() || 'System'
        : 'System';
    await DashboardAction.findOneAndUpdate(
        {
            requestId: asset._id,
            requestType: 'Asset Assignment',
            status: 'Pending',
            ...HANDOVER_TARGET_ASSIGNEE_ROW_FILTER,
        },
        {
            assignedTo: assignee._id,
            assignedToEmpId: assignee.employeeId,
            requestId: asset._id,
            requestType: 'Asset Assignment',
            subjectEmployeeId: subjectEmpId || assignee.employeeId || '',
            subjectName: subjectName || '',
            requestedByName: assignerName,
            extra1: `${asset.assetId} — ${asset.name || ''}`,
            extra2: stageLabel,
            extra3: buildHandoverDashboardExtra3(asset._id, historyId, { viewerRole: 'targetAssignee' }),
            status: 'Pending',
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}

export async function closeFleetHandoverDashboardActions(requestId, status, actionedBy = null, comment = '') {
    if (!requestId) return;
    const patch = {
        status,
        actionedDate: new Date(),
    };
    if (actionedBy) patch.actionedBy = actionedBy;
    if (comment) patch.comment = comment;
    await DashboardAction.updateMany(
        { requestId, requestType: 'Asset Assignment', status: 'Pending' },
        patch,
    );
}

export async function notifyHandoverStageEmail({
    asset,
    employee,
    recipient,
    stageLabel,
    historyId,
    pendingAssignment = true,
}) {
    const detailsPath = buildHandoverAssignDetailsUrl(asset._id, historyId);
    await sendAssetAssignmentEmail({
        asset,
        employee,
        recipient,
        pendingAssignment,
        notificationContext: 'assignment',
        detailsPath,
        stageLabel,
    }).catch(() => null);
}

async function sendSimpleEmail({ to, subject, html }) {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!to || !emailUser || !emailPass) return;
    const transporter = nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });
    await transporter.sendMail({
        from: emailUser,
        to,
        subject,
        html,
    });
}

export async function notifyHandoverRejectedToAdmin({ asset, adminOfficer, actor, comment, historyId }) {
    const email = pickEffectiveEmail(adminOfficer);
    if (!email) return;
    const detailsUrl = buildHandoverAssignDetailsUrl(asset._id, historyId);
    const actorName = `${actor?.firstName || ''} ${actor?.lastName || ''}`.trim() || 'User';
    await sendSimpleEmail({
        to: email,
        subject: `Vehicle handover rejected: ${asset.assetId} — ${asset.name || ''}`,
        html: `
            <p>The vehicle handover for <strong>${asset.name || ''}</strong> (${asset.assetId}) was rejected by ${actorName}.</p>
            ${comment ? `<p><strong>Reason:</strong> ${comment}</p>` : ''}
            <p><a href="${detailsUrl}">View handover details</a></p>
        `,
    }).catch(() => null);
}

async function listActiveFlowchartEmployees() {
    const rows = await Flowchart.find({ status: 'Active' })
        .populate('empObjectId', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
        .lean();
    const seen = new Set();
    const list = [];
    for (const row of rows || []) {
        const emp = row.empObjectId;
        const id = emp?._id?.toString?.();
        if (!emp || !id || seen.has(id)) continue;
        seen.add(id);
        list.push(emp);
    }
    return list;
}

export async function notifyHandoverCompletionEmails({
    asset,
    assignee,
    assigner = null,
    adminOfficer,
    hod,
    hrEmployee,
    historyId,
    attachmentBuffers = [],
}) {
    const attachmentUrl = buildHandoverAttachmentTabUrl(asset._id, historyId);
    const detailsUrl = buildHandoverAssignDetailsUrl(asset._id, historyId);
    const assigneeName = `${assignee?.firstName || ''} ${assignee?.lastName || ''}`.trim() || assignee?.employeeId || 'Assignee';

    const assigneeDoc =
        assignee?._id && assignee?.employeeId
            ? assignee
            : assignee?._id
              ? await EmployeeBasic.findById(assignee._id)
                    .select(
                        'firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee',
                    )
                    .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
                    .lean()
              : null;

    const previousAssignee = await resolvePreviousHandoverAssignee(asset._id, historyId);

    const recipients = [];
    const seen = new Set();
    const push = (emp) => {
        const id = emp?._id?.toString?.();
        if (!emp || !id || seen.has(id)) return;
        seen.add(id);
        recipients.push(emp);
    };

    push(assigneeDoc || assignee);
    push(adminOfficer);
    push(assigner);
    push(previousAssignee);

    const primaryReportee = assigneeDoc?.primaryReportee;
    if (primaryReportee?._id) {
        push(
            typeof primaryReportee === 'object' && primaryReportee.employeeId
                ? primaryReportee
                : await EmployeeBasic.findById(primaryReportee._id || primaryReportee)
                      .select('firstName lastName employeeId companyEmail workEmail personalEmail email')
                      .lean(),
        );
    } else if (hod?._id) {
        push(hod);
    }

    const att = attachmentBuffers.map((buf, i) => ({
        filename: `vehicle-handover-${asset.assetId || i}.pdf`,
        content: buf,
        contentType: 'application/pdf',
    }));

    const downloadButtonHtml = `
        <p style="margin:20px 0;">
            <a href="${attachmentUrl}"
               style="display:inline-block;padding:12px 20px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">
                Download handover report
            </a>
        </p>
    `;

    for (const recipient of recipients) {
        const email = pickEffectiveEmail(recipient);
        if (!email) continue;
        await sendSimpleEmail({
            to: email,
            subject: `Vehicle handover approved: ${asset.assetId} — ${asset.name || ''}`,
            html: `
                <p>Vehicle handover for <strong>${asset.name || ''}</strong> (${asset.assetId}) assigned to <strong>${assigneeName}</strong> has been approved by HR.</p>
                <p>The asset is now assigned. You can open the handover record and download the signed handover report.</p>
                ${downloadButtonHtml}
                <p><a href="${detailsUrl}">Open handover details</a></p>
            `,
        }).catch(() => null);

        if (att.length) {
            await sendAssetResponseEmail({
                asset,
                actor: assignee,
                recipient,
                action: 'Accept',
                comment: 'Vehicle handover approved.',
                assignedToType: 'Employee',
                attachments: att,
            }).catch(() => null);
        }
    }
}

export async function advanceFleetHandoverOnAccept({
    item,
    historyRecord,
    assigneeDoc,
    actor,
    assigner,
}) {
    const flow = getVehicleHandoverFlow(item);
    if (!flow?.stage) {
        return { finalize: true };
    }

    let stage = flow.stage;
    const historyId = flow.historyId || historyRecord?._id?.toString?.();

    if (stage === HANDOVER_FLOW_STAGES.HOD) {
        stage = HANDOVER_FLOW_STAGES.HR;
        item.pendingActionDetails = {
            ...(item.pendingActionDetails || {}),
            vehicleHandoverFlow: {
                ...flow,
                stage: HANDOVER_FLOW_STAGES.HR,
                historyId,
            },
        };
    }

    if (stage === HANDOVER_FLOW_STAGES.TARGET) {
        if (!isHandoverReportsComplete(historyRecord)) {
            return {
                error:
                    getHandoverReportsIncompleteError(historyRecord) ||
                    'Complete Vehicle Accessories (Process Next) and Body Condition Report (Go to Approval) before accepting.',
            };
        }
        if (actor?._id) {
            await recordHandoverStageApproval(historyId, 'target', actor);
        }
        if (historyId) {
            const assignedRow = await AssetHistory.findById(historyId).select('action details').lean();
            if (assignedRow?.action === 'Assigned') {
                await markHandoverLifecycleOnHistory(historyId, HANDOVER_LIFECYCLE.ACCEPTED, {
                    'details.handoverTargetAcceptedAt': new Date(),
                });
            }
        }
        const hr = await resolveHrEmployee();
        if (!hr?._id) {
            return { error: 'HR approver is not configured in the flowchart.' };
        }
        item.pendingActionDetails = {
            ...(item.pendingActionDetails || {}),
            vehicleHandoverFlow: {
                ...flow,
                stage: HANDOVER_FLOW_STAGES.HR,
                historyId,
            },
        };
        item.actionRequiredBy = hr._id;
        item.acceptanceStatus = 'Pending';
        item.status = 'Pending';
        await upsertHandoverDashboardAction({
            asset: item,
            actor: hr,
            assigner,
            historyId,
            stageLabel: 'HR Approval',
            subjectName: `${assigneeDoc?.firstName || ''} ${assigneeDoc?.lastName || ''}`.trim(),
            subjectEmpId: assigneeDoc?.employeeId,
        });
        await notifyHandoverStageEmail({
            asset: item,
            employee: assigneeDoc,
            recipient: hr,
            stageLabel: 'HR Approval',
            historyId,
        });
        return { advanced: true, stage: HANDOVER_FLOW_STAGES.HR };
    }

    if (stage === HANDOVER_FLOW_STAGES.HR || stage === HANDOVER_FLOW_STAGES.MANAGEMENT) {
        if (actor?._id) {
            await recordHandoverStageApproval(historyId, 'hr', actor);
        }
        if (item.pendingActionDetails?.vehicleHandoverFlow) {
            delete item.pendingActionDetails.vehicleHandoverFlow;
        }
        return { finalize: true, historyId };
    }

    return { finalize: true };
}
