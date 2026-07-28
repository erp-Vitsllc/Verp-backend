import AssetItem from '../models/AssetItem.js';
import { resolveFrontendBaseUrl, emailFrontendUrl } from '../utils/resolveFrontendBaseUrl.js';
import mongoose from 'mongoose';
import AssetType from '../models/AssetType.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import AssetHistory from '../models/AssetHistory.js';
import Company from '../models/Company.js';
import User from '../models/User.js';
import { getSignedFileUrl, uploadDocumentToS3, persistStoredAttachmentValue, deleteDocumentFromS3, normalizeS3Key } from '../utils/s3Upload.js';
import { generatePdf } from '../utils/generatePdf.js';
import { sendAssetAssignmentEmail } from '../utils/sendAssetAssignmentEmail.js';
import {
    advanceFleetHandoverOnAccept,
    buildHandoverAssignDetailsUrl,
    buildHandoverDashboardExtra3,
    buildInitialHandoverWorkflowMeta,
    enrichHandoverWorkflowActorSignatures,
    signHandoverAssessmentMediaInDetails,
    employeeHasDrivingLicense,
    attachAssigneeDrivingLicenseIssueDate,
    attachAssigneeDrivingLicenseIssueDates,
    getVehicleHandoverFlow,
    notifyHandoverCompletionEmails,
    notifyHandoverRejectedToAdmin,
    notifyHandoverRejectedToPrevious,
    persistHandoverWorkflowMeta,
    resolveAdminOfficerEmployee,
    resolveFleetHandoverAssignerActor,
    resolveFleetHandoverFirstActor,
    resolvePreviousHandoverRejectionRecipient,
    assigneeCanSelfAcknowledgeFleetHandover,
    buildHandoverFlowPendingActorName,
    resolveHodEmployee,
    updateFleetHandoverHistoryRecord,
    upsertHandoverDashboardAction,
    upsertHandoverAssignerDashboardAction,
    upsertHandoverAdminOfficerDashboardAction,
    upsertHandoverTargetAssigneeDashboardAction,
    notifyHandoverStageEmail,
    isFleetHandoverDashboardMeta,
    isFleetHandoverTrackingViewerRole,
    closeFleetHandoverDashboardActions,
    markHandoverLifecycleOnHistory,
    HANDOVER_LIFECYCLE,
    buildFleetHandoverDisplayLabels,
    formatEmployeeDisplayName,
} from '../utils/vehicleHandoverApprovalFlow.js';
import { allocateNextServiceReqNo } from '../utils/assetServiceReqNo.js';
import {
    buildInitialHandoverEscalationMeta,
    markHandoverEscalationResolved,
    resolveHandoverEscalationRequestedAt,
    seedPreviousHandoverReportsOnHistory,
    stripUnconfirmedBodyConditionDetails,
} from '../utils/vehicleHandoverEscalation.js';
import { syncVehicleAccessoriesListOnAssessmentComplete, signVehicleAccessoriesListEntries, buildPendingAccessoriesChanges, applyPendingHandoverAccessoriesToVehicleList, handoverRequiresHrApproval } from '../utils/vehicleAccessoriesListSync.js';
import { sendAssetResponseEmail } from '../utils/sendAssetResponseEmail.js';
import { sendAssetReassignmentEmail } from '../utils/sendAssetReassignmentEmail.js';
import DashboardAction from '../models/DashboardAction.js';
import { sendAssetActionApprovalEmail } from '../utils/sendAssetActionApprovalEmail.js';
import { sendAssetActionFinalAcknowledgeEmail } from '../utils/sendAssetActionFinalAcknowledgeEmail.js';
import Fine from '../models/Fine.js';
import AssetCategory from '../models/AssetCategory.js';
import Flowchart from '../models/Flowchart.js';
import {
    getDepartmentHOD,
    isUserInFlowchart,
    isUserActiveInFlowchart,
    getCompanyAssetCoordinator,
    isUserCompanyAssetCoordinator,
    isUserActiveCompanyAssetCoordinator
} from '../utils/getDepartmentHOD.js';
import { getManagementHOD } from '../utils/getManagementHOD.js';
import { sendAssetCreationApprovalEmail } from '../utils/sendAssetCreationApprovalEmail.js';
import { sendAssetCreationDecisionEmail, sendAssetCreatedByAdminInfoEmail } from '../utils/sendAssetCreationDecisionEmail.js';
import { notifyAssetCreationRejectedToCreator } from '../utils/notifyAssetCreationRejectedToCreator.js';
import { notifyLossDamageRejectedToRequester } from '../utils/notifyLossDamageRejectedToRequester.js';
import { resolveAssetCreatorEmployee } from '../utils/assetApprovalHelpers.js';
import { hasPermission, isUserAdministrator } from '../services/permissionService.js';
import { collectAssetDocumentIdsForDeletion } from '../utils/assetDocumentDeletion.js';
import {
    actorMayManageOilService,
    actorMayManageTireChangeRequest,
    actorMayCreateOrInitiateVehicleService,
    appendOilServiceActivity,
    getRequesterName,
    submitOilServiceAssignment,
    saveOilServiceDetailsDraft,
    submitOilServiceDetails,
    updateOilServiceDates,
    userMayEditOilServiceDates,
    closeOilServicePendingDashboardActions,
    healStaleOilServicePendingDashboardActions,
    activateOilServiceOnStartDate,
    processOilServiceStartDateActivation,
    maybeAutoCreateOilServiceDue,
} from '../utils/oilServiceWorkflow.js';
import { activateShopServiceOnStartDate } from '../utils/vehicleShopServiceScheduled.js';
import {
    updateShopServiceExtendDate,
    userMayExtendServiceEndDate,
} from '../utils/vehicleShopServiceExtendDate.js';
import {
    resolveAssetControllerEmployee,
    getAssetRequesterDisplayName,
    resolveNewAssetCreationStatus,
    resolveAssetCreationApproverEmployee,
    creationApproverRoleLabel,
    isFleetVehicleAssetFields,
    syncStaleAssetCreationApprover,
    isAssetAssignmentAcknowledgmentPending,
    rerouteAllPendingAssetCreationApprovals,
    userCanAssignAssets,
    getResolvedAssetControllerEmployee,
    getResolvedFleetHrEmployee,
    userCanAssignFleetVehicleAssets,
    isFleetVehicleProfileActive,
    FLEET_PROFILE_INACTIVE_ASSIGNMENT_MSG,
    userIsFlowchartAdminOfficer,
} from '../utils/assetApprovalHelpers.js';
import { buildFleetVehicleMongoScope } from '../utils/fleetVehicleAssetId.js';
import AssetAccessoryCatalog from '../models/AssetAccessoryCatalog.js';
import { sendAssignedEmployeeActionEmail } from '../utils/sendAssignedEmployeeActionEmail.js';
import { processParkingAssets } from '../utils/processParkingAssets.js';
import {
    isLeaveActive,
    isServiceActive,
    isParkingStatus,
    isServiceOperationalStatus,
    hasActiveParkingContext,
    snapshotParkingFields,
    restoreParkingFields,
    applyPostServiceOperationalState,
    resolvePostServiceStatus,
    applyParkingLeaveStatus,
    applyLeavePackToCustodian,
    applyServiceActiveState,
    applyAcceptedAssignmentState,
    stampAssignmentDatesOnAccept,
    clearParkingFlags,
    healStaleParkingFields,
    clearServiceFlag,
    migrateLegacyOperationalFlags,
    onLeaveQueryFilter,
    onServiceQueryFilter,
    onLeaveActiveOnlyQueryFilter,
    onServiceActiveOnlyQueryFilter,
    applyOnDutyFromLeaveState,
    applyOnDutyFromServiceState,
    requiresOwnerOnDutyApproval,
    MAX_ASSET_LEAVE_DAYS,
    MAX_ASSET_SERVICE_DAYS,
    ON_LEAVE_TRANSFER_BLOCKED_MESSAGE,
    assertAssetNotOnLeaveForTransfer,
} from '../utils/assetOperationalFlags.js';
import { sendParkingReassignAcceptedEmail } from '../utils/sendParkingReassignAcceptedEmail.js';
import { sendParkingExtensionEmail } from '../utils/sendAssetParkingNotifications.js';
import { notifyAssetControllerReassignmentAcceptedWithHandover } from '../utils/notifyAssetControllerReassignmentAcceptedWithHandover.js';
import { notifyPreviousAssigneeReassignmentAcceptedWithHandover } from '../utils/notifyPreviousAssigneeReassignmentAcceptedWithHandover.js';
import { pickEffectiveEmail } from '../utils/resolveEmployeeEmail.js';
import { submitInspectionHandoverAfterAssessment, isVehicleInspectionWorkflowActive, isInspectionHandoverHistoryRecord, canEditInspectionHandoverContent, VEHICLE_INSPECTION_HANDOVER_KIND } from './vehicleInspectionController.js';
import { ASSET_HANDOVER_PDF_SELECTOR, VEHICLE_HANDOVER_PDF_SELECTOR } from '../utils/assetHandoverPdfConstants.js';
import {
    requireBulkAssetInventoryPdfAttachment,
    requireBulkAssignmentHandoverPdfAttachment,
    buildBulkAssignmentHandoverPdfAttachment,
    generateBulkAssignmentHandoverPdf,
    resolveSignatureUrlForPdf,
} from '../utils/generateBulkAssetInventoryPdf.js';
import { sendAssetBulkDispositionResultEmail } from '../utils/sendAssetBulkDispositionResultEmail.js';
import { sendAssetTransferDecisionEmail, sendLeaveEosTransferOwnerHodEmail } from '../utils/sendAssetTransferDecisionEmail.js';
import {
    sendAssigneeTransferRequestEmails,
    sendAssigneeTransferResultEmails,
    buildAssigneeTransferHandoverAttachments,
    loadEmployeeWithReportee,
} from '../utils/sendAssigneeTransferEmails.js';
import { notifyAssetServiceStakeholderEmails } from '../utils/notifyAssetServiceStakeholderEmails.js';
import { assertAssetActionStakeholderEmails } from '../utils/assertAssetActionStakeholderEmails.js';
import {
    notifyLossDamageRequestStakeholders,
    notifyLossDamageDecisionToRequester,
    notifyAccessoryTransferApprovedEmails,
} from '../utils/notifyAssetLossDamageStakeholderEmails.js';
import { completeOperationalExpiryDashboardTasks } from '../utils/upsertOperationalExpiryDashboardTask.js';
import {
    buildServiceExtendHistoryDetails,
    buildServiceReceiveHistoryDetails,
    buildServiceSendHistoryDetails,
} from '../utils/buildAssetServiceHistoryDetails.js';
import {
    buildAssignmentHandoverEmailAttachments,
    buildBulkActionHandoverEmailAttachments,
    buildCreationRequestHandoverAttachments,
    buildPendingRequestHandoverCtx,
    buildFullySignedHandoverCtx,
    buildApprovedActionHandoverAttachments,
    finalizeHandoverPdfCtx,
    hodDisplayFromEmployee,
} from '../utils/buildAssignmentHandoverEmailAttachments.js';
import { sendAssetControllerDirectAssignmentRecordEmail } from '../utils/sendAssetControllerDirectAssignmentRecordEmail.js';
import { sendAssetTransferHandoverEmails } from '../utils/sendAssetTransferHandoverEmails.js';
import { notifyBulkAssignmentResponseEmails } from '../utils/sendAssetBulkAssignmentOutcomeEmails.js';
import {
    OWNER_ON_DUTY_REQUEST_TYPE,
    resolveOwnerOnDutyParkingAssetsForDashboard,
    closeStaleOwnerOnDutyDashboardAction,
    refreshStaleOwnerOnDutyDashboardForOwner,
} from './ownerOnDutyController.js';
import { buildVehicleFleetAnalytics } from '../utils/vehicleFleetAnalytics.js';
import { resolveRegistrationExpiryDate } from '../utils/vehicleDocumentRenewal.js';
import { collectVehicleExpiryDocuments, resolveVehicleExpiryFocusCard, resolveVehicleExpiryTab } from '../utils/vehicleExpiryScanUtils.js';

/** Upload server-generated handover PDF bytes to S3; store returned key on AssetHistory.file */
async function persistHandoverPdfBufferToHistory(pdfBuffer, filename) {
    if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) return null;
    try {
        const payload = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;
        const safe = String(filename || 'handover.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
        const { publicId } = await uploadDocumentToS3(payload, 'asset-history', safe);
        return publicId;
    } catch (e) {
        return null;
    }
}

function frontendBaseUrl() {
    return String(resolveFrontendBaseUrl()).replace(/\/+$/, '');
}
import {
    notifyAdminDeletedWholeAsset,
    isReqUserAdmin,
    getAssetControllerNotificationEmail,
    scheduleManagementAdminDeletionEmail,
} from '../utils/sendAdminDeletionNotificationEmails.js';
import { isJwtSystemSuperUser } from '../utils/systemSuperUser.js';
import {
    buildAssigneeClauses,
    resolveDashboardAssigneeContext,
} from '../utils/resolveDashboardAssigneeContext.js';
import { awaitAdminDeletionArchive } from '../utils/adminDeletionArchiveRun.js';
import {
    cleanupDashboardActionsForDeletedAsset,
    deleteDashboardActionsForVehicleService,
    ASSET_DASHBOARD_INBOX_TYPES,
    ASSET_TOOLS_INBOX_TYPES,
    VEHICLE_DASHBOARD_INBOX_TYPES,
} from '../utils/cleanupAssetDashboardActions.js';
import { notifyAdminOfficerOnVehicleServiceCreated } from '../utils/vehicleServiceAdminOfficerNotification.js';
import {
    maybeStartVehicleServiceWorkflow,
    maybeStartCarWashWorkflow,
    getWorkflowAssigneePayloadForStage,
    userMayRespondVehicleServiceWorkflow,
    mergeWorkflowServiceRecord,
} from './vehicleServiceWorkflowController.js';
import { actorMayManageCarWashRequest, findExistingCarWashForMonth, getLatestOccupiedCarWashMonth, normalizeCarWashMonthKey } from '../utils/carWashWorkflow.js';
import {
    submitTireChangeGarage,
    completeTireChangeService,
    appendTireChangeActivity,
    updateTireChangeQuoteEmployeeRows,
} from '../utils/tireChangeWorkflow.js';
import {
    submitMechanicalWorkGarage,
    completeMechanicalWorkService,
    updateMechanicalWorkQuoteEmployeeRows,
} from '../utils/mechanicalWorkWorkflow.js';
import {
    submitBodyWorkGarage,
    completeBodyWorkService,
    updateBodyWorkQuoteEmployeeRows,
} from '../utils/bodyWorkWorkflow.js';
import {
    submitAccidentRepairGarage,
    completeAccidentRepairService,
    updateAccidentRepairQuoteEmployeeRows,
} from '../utils/accidentRepairWorkflow.js';
import {
    generateVegaAccessoryCatalogId,
    syncAllAccessoryInstancesForAsset,
    markCatalogInstancesDetachedFromAsset
} from '../utils/syncAssetAccessoryCatalog.js';
import {
    filterAccessoriesHidingPendingAdds,
    computeCanSeePendingAddsForAsset
} from '../utils/assetPendingAccessoryVisibility.js';

const generateAccessoryCatalogId = generateVegaAccessoryCatalogId;

async function buildPendingAccessoryVisibilityCtx(req) {
    const isSysAdmin = await isUserAdministrator(req.user?.id);
    const isPortalAdmin = isJwtSystemSuperUser(req.user);
    const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);
    const assetController = await getDepartmentHOD('assetcontroller');

    let currentEmpId = req.user?.employeeObjectId?.toString();
    if (!currentEmpId && req.user?.employeeId) {
        const empRow = await EmployeeBasic.findOne({
            employeeId: { $regex: new RegExp(`^${String(req.user.employeeId).replace(/\s+/g, '\\s*')}$`, 'i') }
        })
            .select('_id')
            .lean()
            .catch(() => null);
        if (empRow?._id) currentEmpId = empRow._id.toString();
    }

    const normEmpView = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
    let currentEmployeeIdNorm = normEmpView(req.user?.employeeId);
    if (!currentEmployeeIdNorm && currentEmpId) {
        const curEmp = await EmployeeBasic.findById(currentEmpId).select('employeeId').lean().catch(() => null);
        if (curEmp?.employeeId) currentEmployeeIdNorm = normEmpView(curEmp.employeeId);
    }

    const isDeptAssetController = !!(
        assetController?._id &&
        currentEmpId &&
        assetController._id.toString() === currentEmpId
    );
    const canSeeAllPending = isSysAdmin || isPortalAdmin || isAssetController || isDeptAssetController;
    return {
        canSeeAllPending,
        currentEmpId: currentEmpId || null,
        currentEmployeeIdNorm: currentEmployeeIdNorm || null
    };
}

/** Non-draft assets are visible to all authenticated users; Draft only to the creating User. */
const POOL_ASSIGNABLE_ASSET_STATUSES = new Set(['Unassigned', 'Returned']);

const isAssignableFromPoolStatus = (status) =>
    POOL_ASSIGNABLE_ASSET_STATUSES.has(String(status || '').trim());

/** Returned rows may still carry stale assignee fields — clear before a fresh pool assign. */
const prepareAssetItemForPoolAssignment = (item) => {
    if (!item || String(item.status || '').trim() !== 'Returned') return;
    item.assignedTo = null;
    item.assignedCompany = null;
    item.assignedToType = null;
    item.assignedBy = null;
    item.acceptedBy = null;
    item.acceptanceStatus = null;
    item.actionRequiredBy = null;
};

function buildDraftVisibilityQuery(reqUser) {
    const uid = reqUser?._id || reqUser?.id;
    if (uid && mongoose.Types.ObjectId.isValid(String(uid))) {
        return {
            $or: [{ status: { $ne: 'Draft' } }, { createdBy: new mongoose.Types.ObjectId(String(uid)) }]
        };
    }
    return { status: { $ne: 'Draft' } };
}

const generateFineIdInternal = async () => {
    try {
        const fines = await Fine.find({ fineId: /VEGA-(FINE|FNE)-(\d+)/i }).select('fineId').lean();
        let maxNum = 0;
        if (fines.length > 0) {
            fines.forEach(f => {
                const match = f.fineId.match(/VEGA-(FINE|FNE)-(\d+)/i);
                if (match && match[2]) {
                    const num = parseInt(match[2], 10);
                    if (num > maxNum) maxNum = num;
                }
            });
        }
        const nextNum = maxNum + 1;
        return `VEGA-FINE-${nextNum.toString().padStart(4, '0')}`;
    } catch (error) {
        return `fine${Date.now().toString().slice(-4)}`;
    }
};

const validateFineTrackerFlowchart = async () => {
    const hrHOD = await getDepartmentHOD('hr');
    const accountsHOD = await getDepartmentHOD('accounts');
    const managementHOD = await getManagementHOD();

    const missing = [];
    if (!hrHOD?._id) missing.push('HR');
    if (!accountsHOD?._id) missing.push('Accounts');
    if (!managementHOD?._id) missing.push('Management');

    if (missing.length > 0) {
        return {
            ok: false,
            message: `Cannot proceed with Loss and Damage. Missing Flowchart setup: ${missing.join(', ')}. Please configure these roles first in Settings > FlowChart.`
        };
    }

    return { ok: true, hrHOD, accountsHOD, managementHOD };
};

const notifyAssignedEmployeeIfController = async (
    req,
    assetDoc,
    action,
    details = '',
    { attachments: attachmentsOverride = null, attachApprovedHandover = false } = {},
) => {
    try {
        const isAssetControllerUser = await isUserInFlowchart(req.user, 'assetcontroller');
        if (!isAssetControllerUser) return;

        if (!assetDoc) return;

        const mapActionToDashboardRequestType = (actionString) => {
            if (!actionString) return null;
            const a = String(actionString).toLowerCase();
            if (a.includes('loss') || a.includes('loss and damage')) return 'Asset Loss Damage';
            if (a.includes('end of life')) return 'Asset End of Life';
            if (a.includes('transfer')) return 'Asset Transfer';
            if (a.includes('assign') || a.includes('reassign')) return 'Asset Assignment';
            if (a.includes('leave') || a.includes('on leave')) return 'Asset Leave';
            return 'Asset Approval';
        };

        let companyDoc = null;
        if (assetDoc?.assignedCompany) {
            if (typeof assetDoc.assignedCompany === 'object') {
                companyDoc = assetDoc.assignedCompany;
            } else {
                const compId = assetDoc.assignedCompany;
                companyDoc = await Company.findById(compId).select('name companyId nickName').lean().catch(() => null);
            }
        }

        const appendCompanyToDetails = (msg) => {
            if (!msg) msg = '';
            if (assetDoc?.assignedToType === 'Company') {
                const name = companyDoc?.name || assetDoc?.assignedCompany?.name || '';
                if (name) return `${msg}${msg ? ' ' : ''}(Company: ${name})`;
            }
            return msg;
        };

        // Company-assigned assets: email/dashboard flowchart Assigned User (else Admin), not HR.
        if (assetDoc?.assignedToType === 'Company') {
            const companyCoordinator = await getCompanyAssetCoordinator();
            if (!companyCoordinator?._id) return;

            const requestType = mapActionToDashboardRequestType(action);
            const companyName = companyDoc?.name || '';
            const companyId = companyDoc?.companyId || '';
            const subjectName = companyName || 'Company allocation';
            const subjectEmployeeId = companyId || 'UNASSIGNED';

            let companyAtt = attachmentsOverride;
            if (attachApprovedHandover && (!companyAtt || !companyAtt.length)) {
                try {
                    companyAtt = await buildApprovedActionHandoverAttachments(req, assetDoc);
                } catch (e) {
                }
            }
            await sendAssignedEmployeeActionEmail({
                asset: assetDoc,
                employee: companyCoordinator,
                action,
                performedBy: req.user.employeeId || 'Asset Controller',
                details: appendCompanyToDetails(details),
                attachments: companyAtt || [],
            });

            if (requestType) {
                await DashboardAction.create({
                    assignedTo: companyCoordinator._id,
                    assignedToEmpId: companyCoordinator.employeeId,
                    requestId: assetDoc._id,
                    requestType,
                    status: 'Approved',
                    subjectEmployeeId,
                    subjectName,
                    requestedByName: req.user.name || req.user.employeeId || 'Asset Controller',
                    actionedDate: new Date(),
                    actionedBy: req.user.employeeObjectId || req.user.id || null,
                    extra1: `${assetDoc.assetId} — ${assetDoc.name || ''}`,
                    extra2: appendCompanyToDetails(action || '')
                });
            }
            return;
        }

        // Employee-assigned assets: email the assigned employee.
        if (!assetDoc?.assignedTo) return;
        const employee = await EmployeeBasic.findById(assetDoc.assignedTo)
            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee signature')
            .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
            .lean();
        if (!employee) return;

        let handoverAtt = attachmentsOverride;
        if (attachApprovedHandover && (!handoverAtt || !handoverAtt.length)) {
            try {
                handoverAtt = await buildApprovedActionHandoverAttachments(req, assetDoc);
            } catch (e) {
            }
        }

        const performedByDisplay =
            req.user?.employeeId && !String(req.user.employeeId).match(/^\d+$/)
                ? req.user.employeeId
                : `${req.user?.firstName || ''} ${req.user?.lastName || ''}`.trim() ||
                req.user?.name ||
                'Asset Controller';

        await sendAssignedEmployeeActionEmail({
            asset: assetDoc,
            employee,
            action,
            performedBy: performedByDisplay,
            details,
            attachments: handoverAtt || [],
        });
    } catch (e) {
    }
};

/** One email + consolidated handover-form PDF per employee after AC bulk-direct Leave/EOS (same template as bulk assign). */
const notifyEmployeesGroupedControllerBulkDirect = async (req, employeeSnapshots, actionSummary) => {
    try {
        const assigner = req.user?.employeeObjectId
            ? await EmployeeBasic.findById(req.user.employeeObjectId)
                .select('firstName lastName employeeId signature department')
                .lean()
                .catch(() => null)
            : null;
        const assignerDisplay =
            `${assigner?.firstName || ''} ${assigner?.lastName || ''}`.trim() ||
            req.user?.name ||
            'Asset Controller';

        const byEmp = new Map();
        for (const s of employeeSnapshots || []) {
            if (!s?._id || !s.assignedTo) continue;
            const eid = s.assignedTo._id?.toString?.() || s.assignedTo.toString?.();
            if (!eid) continue;
            if (!byEmp.has(eid)) byEmp.set(eid, []);
            byEmp.get(eid).push(s._id.toString());
        }
        for (const [eid, ids] of byEmp) {
            if (!ids.length || !eid) continue;
            const employee = await EmployeeBasic.findById(eid)
                .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee department')
                .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
                .lean();
            if (!employee) continue;
            let pdf = [];
            const handoverFilenameBase = actionSummary.handoverFilenameBase
                || `${String(actionSummary.pdfBase || 'bulk-action').replace(/-inventory$/i, '')}-handover`;
            try {
                pdf = await buildAssignmentHandoverEmailAttachments(req, ids, {
                    ...buildPendingRequestHandoverCtx({
                        assigner,
                        assignerName: assignerDisplay,
                        assigneeName: `${employee.firstName || ''} ${employee.lastName || ''}`.trim() || 'Employee',
                        employeeCode: employee.employeeId || '—',
                        department: (employee.department && String(employee.department).trim()) || '—',
                        hodName: hodDisplayFromEmployee(employee),
                    }),
                    filenameBase: handoverFilenameBase,
                });
            } catch (e) {
            }
            const firstSnap = employeeSnapshots.find((x) => x._id.toString() === ids[0]);
            await sendAssignedEmployeeActionEmail({
                asset:
                    ids.length > 1
                        ? { _id: ids[0], assetId: `${ids.length} assets`, name: actionSummary.bulkName }
                        : { _id: ids[0], assetId: firstSnap?.assetId, name: firstSnap?.name },
                employee,
                action: actionSummary.actionLabel,
                performedBy: req.user.employeeId || 'Asset Controller',
                details: actionSummary.detailsText,
                attachments: pdf,
                customIntro: actionSummary.customIntro
            });
        }
    } catch (e) {
    }
};

/** Handover-form PDF for Leave / EOL / loss request emails — requester (assignee) name + signature, not Asset Controller. */
const buildAssetActionApprovalHandoverAttachments = async (req, assets) => {
    const list = Array.isArray(assets) ? assets : [assets];
    const ids = list.map((a) => String(a._id)).filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (!ids.length) return [];

    const primary = list[0];
    const requester = req.user?.employeeObjectId
        ? await EmployeeBasic.findById(req.user.employeeObjectId)
            .select('firstName lastName employeeId signature department')
            .lean()
            .catch(() => null)
        : null;
    const assignerDisplay =
        `${requester?.firstName || ''} ${requester?.lastName || ''}`.trim() ||
        req.user?.name ||
        'Requester';

    if (primary.assignedToType === 'Company' && primary.assignedCompany) {
        const comp = await Company.findById(primary.assignedCompany).select('name companyId').lean();
        return buildAssignmentHandoverEmailAttachments(req, ids, {
            ...buildPendingRequestHandoverCtx({
                assigner: requester,
                assignerName: assignerDisplay,
                assigneeName: comp?.name || 'Company',
                employeeCode: comp?.companyId || '—',
            }),
            assigner: requester,
            filenameBase: `asset-action-request-${ids.length}-handover`,
        });
    }

    let assignee = primary.assignedTo;
    if (assignee && (!assignee.firstName || !assignee.department || !assignee.signature)) {
        assignee = await EmployeeBasic.findById(assignee._id || assignee)
            .select('firstName lastName employeeId department signature primaryReportee')
            .populate('primaryReportee', 'firstName lastName employeeId')
            .lean()
            .catch(() => assignee);
    } else if (!assignee?.firstName && primary.assignedTo) {
        assignee = await EmployeeBasic.findById(primary.assignedTo)
            .select('firstName lastName employeeId department signature primaryReportee')
            .populate('primaryReportee', 'firstName lastName employeeId')
            .lean()
            .catch(() => null);
    }

    return buildAssignmentHandoverEmailAttachments(req, ids, {
        ...buildPendingRequestHandoverCtx({
            assigner: requester,
            assignerName: assignerDisplay,
            assigneeName: assignee ? `${assignee.firstName || ''} ${assignee.lastName || ''}`.trim() || '—' : '—',
            employeeCode: assignee?.employeeId || '—',
            department: (assignee?.department && String(assignee.department).trim()) || '—',
            hodName: hodDisplayFromEmployee(assignee),
        }),
        assigner: requester,
        assignee,
        filenameBase: `asset-action-request-${ids.length}-handover`,
    });
};

const assigneeHasCompanyEmailOnRecord = (emp) =>
    !!(emp?.companyEmail && String(emp.companyEmail).trim().length > 0);

/**
 * Can the assignee Accept in ERP themselves?
 * Requires an Active User login with portal enabled — companyEmail alone is not enough
 * (employees without a User profile cannot get inbox tasks; primary reportee must).
 */
const assigneeCanSelfAcknowledgeAssignment = async (emp) => {
    if (!emp) return false;
    if (emp.enablePortalAccess === false) return false;
    const empId = emp.employeeId ? String(emp.employeeId).trim() : '';
    if (!empId) return false;
    const linkedUser = await User.findOne({ employeeId: empId, status: 'Active' })
        .select('enablePortalAccess')
        .lean()
        .catch(() => null);
    if (!linkedUser) return false;
    return linkedUser.enablePortalAccess !== false;
};

/** After L&D is finalized: mark Lost and clear live assignment (history retains prior assignees). */
const applyAssetLostFinalState = (asset) => {
    if (!asset) return;
    if (!asset.lostAt) asset.lostAt = new Date();
    asset.pendingAction = null;
    asset.pendingActionDetails = null;
    asset.actionRequiredBy = null;
    asset.lossDamageFineDraft = null;
    asset.status = 'Lost';
    asset.assignedTo = null;
    asset.assignedCompany = null;
    asset.assignedToType = null;
    asset.assignmentType = null;
    asset.assignedDate = null;
    asset.assignedDays = null;
    asset.temporaryEndDate = null;
    asset.temporaryReminderSentAt = null;
    asset.temporaryExpiredSentAt = null;
    asset.acceptanceStatus = null;
    asset.onLeaveActive = false;
    asset.onServiceActive = false;
};

/** Detach one accessory row from an asset into the unattached catalog. */
const detachAccessoryFromAssetToCatalog = async (asset, accIndex, req, { comment = '', catalogStatus = 'Unattached' } = {}) => {
    if (!asset?.accessories?.[accIndex]) return null;
    const accToMove = asset.accessories[accIndex].toObject?.() || asset.accessories[accIndex];
    asset.accessories.splice(accIndex, 1);

    let catalogId = accToMove.accessoryId;
    let catalogRow = null;
    if (catalogId) {
        catalogRow = await AssetAccessoryCatalog.findOne({
            recordType: 'catalog',
            accessoryCatalogId: catalogId
        });
    }

    if (catalogRow) {
        catalogRow.status = catalogStatus;
        catalogRow.isActive = catalogStatus === 'Unattached';
        catalogRow.assetItemId = null;
        catalogRow.assetIdRef = '';
        catalogRow.history.push({
            at: new Date(),
            action: 'unattached',
            message: comment || `Returned to catalog from asset ${asset.assetId} — ${asset.name}`,
            assetId: asset.assetId,
            assetName: asset.name,
            assetObjectId: asset._id,
        });
        await catalogRow.save();
    } else {
        catalogId = catalogId || (await generateAccessoryCatalogId());
        await AssetAccessoryCatalog.create({
            recordType: 'catalog',
            accessoryCatalogId: catalogId,
            name: accToMove.name,
            price: accToMove.amount || 0,
            description: accToMove.description || '',
            status: catalogStatus,
            isActive: catalogStatus === 'Unattached',
            history: [{
                at: new Date(),
                action: 'unattached',
                message: comment || `Returned to catalog from asset ${asset.assetId} — ${asset.name}`,
                assetId: asset.assetId,
                assetName: asset.name,
                assetObjectId: asset._id,
            }],
        });
    }

    await AssetHistory.create({
        assetId: asset._id,
        action: 'Accepted',
        performedBy: req.user.employeeObjectId || req.user._id,
        comments: `Accessory "${accToMove.name}" (${accToMove.accessoryId}) detached to catalog (${catalogId}). ${comment || ''}`.trim(),
        date: new Date(),
        details: { status: 'UnattachedToCatalog', accessoryId: accToMove.accessoryId, catalogId },
    });

    await removeAccessoryFromHistorySnapshots(asset._id, accToMove._id || accToMove.accessoryId);
    try {
        await markCatalogInstancesDetachedFromAsset(asset._id, [accToMove.accessoryId]);
    } catch {
        /* non-fatal */
    }

    return { accToMove, catalogId };
};

/**
 * On main-asset L&D finalize: accessories kept in the fine → stay on asset with status Lost.
 * Excluded accessories stay on the asset until manually detached via Unattach.
 */
const applyMainAssetLossDamageAccessoryDisposition = async (asset, fineData, req, fineId = null) => {
    if (!asset?.accessories?.length) return;

    const excluded = new Set((fineData?.excludedAccessoryIds || []).map(String));

    for (let i = 0; i < asset.accessories.length; i++) {
        const acc = asset.accessories[i];
        const oid = String(acc._id);
        const code = String(acc.accessoryId || '');
        const isExcluded = excluded.has(oid) || excluded.has(code);

        if (isExcluded) {
            continue;
        }

        // Accessories still on the asset and not removed from the fine are treated as lost.
        acc.status = 'Lost';
        if (!acc.lostAt) acc.lostAt = new Date();
        acc.pendingAction = null;
        acc.pendingActionDetails = null;

        try {
            await AssetAccessoryCatalog.updateMany(
                { recordType: 'instance', assetItemId: asset._id, assetAccessoryId: acc.accessoryId },
                { $set: { status: 'Lost' } },
            );
        } catch {
            /* non-fatal */
        }
    }

    asset.markModified('accessories');
};

/**
 * Employee assignment: assignee keeps `assignedTo`; accept task goes to assignee or primary reportee.
 * When assigner === designated acceptor (e.g. AC is also HOD / primary reportee) and assignee cannot
 * self-acknowledge, skip the redundant pending step — asset is directly Assigned to the employee.
 */
const resolveEmployeeAssignmentActors = async (employeeToAssign, assignerEmpObjectId) => {
    const assigneeHasCompanyEmail = assigneeHasCompanyEmailOnRecord(employeeToAssign);
    const assigneeCanSelfAcknowledge = await assigneeCanSelfAcknowledgeAssignment(employeeToAssign);
    let pendingActionActorId = employeeToAssign._id;
    let actionRecipientDoc = employeeToAssign;

    if (!assigneeCanSelfAcknowledge && employeeToAssign.primaryReportee) {
        pendingActionActorId =
            employeeToAssign.primaryReportee._id || employeeToAssign.primaryReportee;
        const pr = employeeToAssign.primaryReportee;
        if (pr && typeof pr === 'object' && (pr.employeeId || pr.firstName || pr._id)) {
            actionRecipientDoc = pr;
        }
    }

    const assignerId = assignerEmpObjectId?.toString?.() || String(assignerEmpObjectId || '');
    const actorId =
        pendingActionActorId?._id?.toString?.() ||
        pendingActionActorId?.toString?.() ||
        '';

    const autoAcceptOnAssign =
        !assigneeCanSelfAcknowledge && !!assignerId && !!actorId && assignerId === actorId;

    return {
        assigneeHasCompanyEmail,
        assigneeCanSelfAcknowledge,
        pendingActionActorId,
        actionRecipientDoc,
        autoAcceptOnAssign,
    };
};

/**
 * Re-route Pending "Asset Assignment" inbox tasks when the assignee has no ERP login
 * so the primary reportee receives the Accept task (and badge/inbox stay correct).
 */
const healMisroutedAssignmentInboxTasks = async () => {
    try {
        const pending = await DashboardAction.find({
            status: 'Pending',
            requestType: 'Asset Assignment',
        })
            .select('_id requestId assignedTo')
            .limit(100)
            .lean();
        if (!pending.length) return;

        for (const da of pending) {
            if (!da.requestId) continue;
            const asset = await AssetItem.findById(da.requestId)
                .select(
                    'status acceptanceStatus pendingAction actionRequiredBy assignedToType assignedTo assignedBy plateNumber typeId pendingActionDetails',
                )
                .populate({
                    path: 'assignedTo',
                    select: 'employeeId firstName lastName companyEmail enablePortalAccess primaryReportee',
                    populate: {
                        path: 'primaryReportee',
                        select: '_id firstName lastName employeeId',
                    },
                })
                .lean();
            if (!asset || !isAssetAssignmentAcknowledgmentPending(asset)) continue;
            if (asset.assignedToType !== 'Employee' || !asset.assignedTo) continue;
            // Skip fleet handover multi-stage rows (handled elsewhere).
            if (getVehicleHandoverFlow(asset)?.stage) continue;

            const resolved = await resolveEmployeeAssignmentActors(
                asset.assignedTo,
                asset.assignedBy,
            );
            if (resolved.autoAcceptOnAssign || !resolved.pendingActionActorId) continue;
            const expectedId =
                resolved.pendingActionActorId?._id?.toString?.() ||
                resolved.pendingActionActorId?.toString?.() ||
                '';
            if (!expectedId) continue;

            const currentActionAssignee =
                da.assignedTo?._id?.toString?.() || da.assignedTo?.toString?.() || '';
            const currentAr =
                asset.actionRequiredBy?._id?.toString?.() ||
                asset.actionRequiredBy?.toString?.() ||
                '';
            if (currentActionAssignee === expectedId && currentAr === expectedId) continue;

            const healed = await EmployeeBasic.findById(expectedId)
                .select('firstName lastName employeeId')
                .lean();
            await AssetItem.updateOne(
                { _id: asset._id },
                { $set: { actionRequiredBy: expectedId } },
            );
            await DashboardAction.updateOne(
                { _id: da._id, status: 'Pending' },
                {
                    $set: {
                        assignedTo: expectedId,
                        ...(healed?.employeeId ? { assignedToEmpId: healed.employeeId } : {}),
                    },
                },
            );
        }
    } catch {
        /* non-fatal */
    }
};

const notifyLeaveEosOwnerHod = async ({
    asset,
    actionType,
    requesterName,
    phase,
    approver = null,
    approved = null,
    reason = '',
    attachments = [],
}) => {
    try {
        const assigneeRef = asset?.assignedTo;
        if (!assigneeRef || asset?.assignedToType === 'Company') return;

        let owner = assigneeRef;
        if (typeof owner !== 'object' || !owner?.primaryReportee) {
            owner = await EmployeeBasic.findById(owner._id || owner)
                .select('firstName lastName employeeId primaryReportee')
                .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail')
                .lean();
        }
        if (!owner) return;

        await sendLeaveEosTransferOwnerHodEmail({
            asset,
            actionType,
            owner,
            requesterName,
            phase,
            approver,
            approved,
            reason,
            attachments,
        });
    } catch (err) {
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Permission helper: full access for assigned actors
// - Admin + Asset Controller: always allowed
// - Assignee: allowed
// - Assigner (asset.assignedBy): allowed with full permissions
// - If assignee has NO `companyEmail` OR no portal/login access: allow primaryReportee as delegate
// - Pending assignment: whoever is `actionRequiredBy` (assignee or reportee when no company email) may act
// ─────────────────────────────────────────────────────────────────────────────
const getActorPermissionFlagsForAsset = async (reqUser, asset) => {
    const currentEmpObjectId = reqUser?.employeeObjectId?.toString?.() || null;
    const isAdmin = isJwtSystemSuperUser(reqUser);
    const isAssetController = await isUserInFlowchart(reqUser, 'assetcontroller').catch(() => false);
    const isCompanyAsset = asset?.assignedToType === 'Company' && !!asset?.assignedCompany;
    const isCompanyCoordinator =
        isCompanyAsset && (await isUserCompanyAssetCoordinator(reqUser).catch(() => false));

    const toIdString = (v) => {
        if (!v) return null;
        if (typeof v === 'string') return v;
        if (v._id) return v._id.toString();
        if (v.toString) return v.toString();
        return null;
    };

    const assignedById = toIdString(asset?.assignedBy);
    const isAssigner = !!(currentEmpObjectId && assignedById && assignedById === currentEmpObjectId);

    let isAssignee = false;
    let isPrimaryReporteeDelegate = false;

    if (asset?.assignedToType === 'Employee' && asset?.assignedTo && currentEmpObjectId) {
        const assigneeId = toIdString(asset.assignedTo);
        isAssignee = !!(assigneeId && assigneeId === currentEmpObjectId);

        let assigneeDoc =
            (typeof asset.assignedTo === 'object' && (asset.assignedTo.employeeId || asset.assignedTo.companyEmail !== undefined || asset.assignedTo.primaryReportee))
                ? asset.assignedTo
                : await EmployeeBasic.findById(assigneeId)
                    .select('companyEmail primaryReportee employeeId')
                    .lean()
                    .catch(() => null);

        // If we didn't receive employeeId in the populated document, fetch it so we can check portal access safely.
        if (assigneeDoc && !assigneeDoc.employeeId) {
            assigneeDoc = await EmployeeBasic.findById(assigneeId)
                .select('companyEmail primaryReportee employeeId')
                .lean()
                .catch(() => assigneeDoc);
        }

        const assigneeHasCompanyEmail = !!(assigneeDoc?.companyEmail && String(assigneeDoc.companyEmail).trim().length > 0);
        const primaryReporteeId = toIdString(assigneeDoc?.primaryReportee);

        // Portal access check (ERP login-enabled user)
        let hasPortalAccess = null;
        const assigneeEmpId = assigneeDoc?.employeeId ? String(assigneeDoc.employeeId) : null;
        if (assigneeEmpId) {
            const linkedUser = await User.findOne({ employeeId: assigneeEmpId, status: 'Active' })
                .select('enablePortalAccess')
                .lean()
                .catch(() => null);
            hasPortalAccess = !!(linkedUser && linkedUser.enablePortalAccess);
        }

        isPrimaryReporteeDelegate = !!(
            primaryReporteeId &&
            primaryReporteeId === currentEmpObjectId &&
            (!assigneeHasCompanyEmail || hasPortalAccess === false)
        );
    }

    const actionRequiredById = toIdString(asset?.actionRequiredBy);
    const isPendingAssignmentActor = !!(
        asset?.assignedToType === 'Employee' &&
        String(asset?.acceptanceStatus || '') === 'Pending' &&
        (String(asset?.status || '') === 'Pending' || String(asset?.status || '') === 'Assigned') &&
        !asset?.pendingAction &&
        currentEmpObjectId &&
        actionRequiredById &&
        actionRequiredById === currentEmpObjectId
    );

    const canAct =
        isAdmin ||
        isAssetController ||
        isCompanyCoordinator ||
        isAssigner ||
        isAssignee ||
        isPrimaryReporteeDelegate ||
        isPendingAssignmentActor;
    return {
        canAct,
        isAdmin,
        isAssetController,
        isCompanyCoordinator,
        isAssigner,
        isAssignee,
        isPrimaryReporteeDelegate,
        isPendingAssignmentActor
    };
};

const actorMayManageOilServiceRequest = async (reqUser, asset) => actorMayManageOilService(reqUser, asset);

const isTireChangeServiceType = (serviceType) => String(serviceType || '').trim() === 'Tire Change';

const VEHICLE_SERVICE_TAB_REQUEST_TYPES = new Set([
    'Tire Change',
    'Mechanical Work',
    'Body Work',
    'Accident Repair',
]);

const isVehicleServiceTabRequestType = (serviceType) =>
    VEHICLE_SERVICE_TAB_REQUEST_TYPES.has(String(serviceType || '').trim());


export const getAssetItems = async (req, res) => {
    try {
        const { typeId } = req.params;
        const { status } = req.query;

        let query = { typeId: typeId };
        if (status && status.toLowerCase() !== 'all') {
            query.status = status;
        }

        query.$and = query.$and || [];
        query.$and.push(buildDraftVisibilityQuery(req.user));

        const pendingAccessoryCtx = await buildPendingAccessoryVisibilityCtx(req);

        const items = await AssetItem.find(query)
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId department primaryReportee reportingAuthority companyEmail enablePortalAccess',
                populate: [
                    { path: 'primaryReportee', select: 'firstName lastName' },
                    { path: 'reportingAuthority', select: 'firstName lastName' }
                ]
            })
            .populate('actionRequiredBy', 'employeeId')
            .populate('acceptedBy', 'firstName lastName signature')
            .sort({ assetId: 1 });

        const signedItems = await Promise.all(items.map(async (item) => {
            const itemObj = item.toObject();
            const canSeePending = computeCanSeePendingAddsForAsset(pendingAccessoryCtx, item);
            if (itemObj.accessories?.length) {
                itemObj.accessories = filterAccessoriesHidingPendingAdds(itemObj.accessories, canSeePending, itemObj.status);
            }
            if (itemObj.photo) {
                itemObj.photo = await getSignedFileUrl(itemObj.photo);
            }
            if (itemObj.imagePreview) {
                itemObj.imagePreview = await getSignedFileUrl(itemObj.imagePreview);
            }
            return itemObj;
        }));

        res.status(200).json(signedItems);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }

};

/**
 * Fleet dashboard for vehicle assets: reminders, status, charts (service cost, model years, usage proxy).
 * Pass `?scope=list` for a lightweight vehicle list payload (skips charts and heavy service history).
 * @route GET /api/AssetItem/vehicle-fleet-dashboard
 */
export const getVehicleFleetDashboard = async (req, res) => {
    try {
        const listOnly = String(req.query.scope || '').trim().toLowerCase() === 'list';
        const fallbackAssetController = await getDepartmentHOD('assetcontroller');
        const draftVis = buildDraftVisibilityQuery(req.user);
        const vehicleTypeDocs = await AssetType.find({
            isActive: true,
            name: { $regex: /vehicle|car|fleet|truck/i },
        })
            .select('_id')
            .lean();
        const vehicleTypeIds = vehicleTypeDocs.map((t) => t._id);
        // Exclude tools (VEGA-ASSET-*): shared AssetItem defaults used to match every row.
        const fleetScope = buildFleetVehicleMongoScope({ vehicleTypeIds });
        const fleetSelect = listOnly
            ? 'assetId name vehicleBrand plateEmirate plateNumber modelYear assetValue status registrationExpiryDate insuranceExpiryDate nextServiceDate oilChangeDate gearOilDueDate currentKilometer assignedTo assignedCompany acceptanceStatus pendingAction actionRequiredBy createdBy vehicleProfileActivationStatus vehicleDispositionStatus warrantyEnabled warrantyExpiryDate warrantyYears onServiceActive onLeaveActive typeId assignedDate pendingActionDetails updatedAt documents.type documents.expiryDate documents.issueDate documents.createdAt documents.status documents.documentStatus documents.description'
            : 'assetId name vehicleBrand plateEmirate plateNumber modelYear assetValue status registrationExpiryDate insuranceExpiryDate nextServiceDate oilChangeDate gearOilDueDate lastServiceDate currentKilometer assignedTo assignedCompany acceptanceStatus pendingAction services documents actionRequiredBy createdBy vehicleProfileActivationStatus vehicleDispositionStatus assignmentType temporaryEndDate warrantyEnabled warrantyExpiryDate warrantyYears accessories parkingExtendedDays parkingReminderSentAt parkingDurationCompleteSentAt onServiceActive onLeaveActive assignedDate pendingActionDetails updatedAt activeServiceWorkflow';
        const items = await AssetItem.find({ $and: [draftVis, fleetScope] })
            .populate('typeId', 'name')
            .populate('assignedTo', 'firstName lastName employeeId')
            .populate('assignedCompany', 'name nickName companyShortName companyName')
            .populate('actionRequiredBy', 'firstName lastName employeeId')
            .select(fleetSelect)
            .maxTimeMS(20000)
            .lean();

        const isVehicleAsset = (it) =>
            isFleetVehicleAssetFields({
                plateNumber: it.plateNumber,
                typeName: it.typeId?.name || '',
                asset: it,
            });

        const vehicles = items.filter(isVehicleAsset);

        const handoverAdminOfficer = listOnly
            ? await resolveAdminOfficerEmployee().catch(() => null)
            : null;

        const registrationExpiry = (v) => resolveRegistrationExpiryDate(v);

        const fleetRows = vehicles.map((v) => {
            const total = listOnly
                ? 0
                : (v.services || []).reduce((sum, s) => sum + Number(s.value || 0), 0);
            const workflowController = v.actionRequiredBy && typeof v.actionRequiredBy === 'object' ? v.actionRequiredBy : null;
            const resolvedController = workflowController || ((!v.assignedTo && fallbackAssetController) ? fallbackAssetController : null);
            const hasControllerObjectId = !!resolvedController?._id;
            const controllerPayload = resolvedController
                ? {
                    _id: hasControllerObjectId
                        ? resolvedController._id
                        : `flowchart_${resolvedController.category || 'assetcontroller'}`,
                    firstName:
                        resolvedController.firstName ||
                        resolvedController.employeeName?.split(' ')[0] ||
                        'Asset',
                    lastName:
                        resolvedController.lastName ||
                        resolvedController.employeeName?.split(' ').slice(1).join(' ') ||
                        'Controller',
                    employeeId: resolvedController.employeeId || '',
                }
                : null;
            const regExpResolved = registrationExpiry(v);
            let pendingActionDetails = v.pendingActionDetails || null;
            const handoverFlow = pendingActionDetails?.vehicleHandoverFlow;
            if (
                listOnly &&
                handoverFlow?.stage === 'target' &&
                String(v.acceptanceStatus || '').trim() === 'Pending' &&
                !String(handoverFlow.pendingActorName || '').trim()
            ) {
                const canSelf = handoverFlow.assigneeCanSelfAcknowledge === true;
                const pendingActorName = buildHandoverFlowPendingActorName(v.assignedTo, {
                    assigneeCanSelfAcknowledge: canSelf,
                    actorDoc: canSelf ? v.assignedTo : handoverAdminOfficer,
                });
                if (pendingActorName) {
                    pendingActionDetails = {
                        ...pendingActionDetails,
                        vehicleHandoverFlow: {
                            ...handoverFlow,
                            pendingActorName,
                        },
                    };
                }
            }
            return {
                _id: v._id,
                assetId: v.assetId,
                plateEmirate: v.plateEmirate || '',
                plateNumber: v.plateNumber,
                label: (v.plateNumber || v.assetId || 'Asset').toString().slice(0, 18),
                totalServiceCost: total,
                assetValue: Number(v.assetValue || 0),
                modelYear: v.modelYear || '',
                status: v.status,
                vehicleDispositionStatus: v.vehicleDispositionStatus || 'active',
                vehicleProfileActivationStatus: v.vehicleProfileActivationStatus || '',
                assignedTo: v.assignedTo,
                assignedCompany: v.assignedCompany,
                acceptanceStatus: v.acceptanceStatus || '',
                pendingAction: v.pendingAction || '',
                pendingActionDetails,
                assignedDate: v.assignedDate || null,
                updatedAt: v.updatedAt || null,
                actionRequiredBy: v.actionRequiredBy,
                onServiceActive: v.onServiceActive === true,
                onLeaveActive: v.onLeaveActive === true,
                assetController: controllerPayload,
                assetControllerId: controllerPayload?._id || null,
                registrationExpiryDate: regExpResolved,
                nextServiceDate: v.nextServiceDate || null,
                gearOilDueDate: v.gearOilDueDate || null,
                oilChangeDate: v.oilChangeDate || null,
                currentKilometer: v.currentKilometer
            };
        });

        if (listOnly) {
            return res.json({ vehicles: fleetRows });
        }

        const vehicleIds = vehicles.map((v) => v._id);

        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const soonEnd = new Date(now);
        soonEnd.setDate(soonEnd.getDate() + 30);

        const nextMaintenanceDate = (v) => {
            const dates = [v.nextServiceDate, v.gearOilDueDate].filter(Boolean).map((d) => new Date(d));
            if (!dates.length) return null;
            return new Date(Math.min(...dates.map((d) => d.getTime())));
        };

        let serviceDue = 0;
        let serviceDueSoon = 0;
        let regDue = 0;
        let regDueSoon = 0;
        let oilServiceDue = 0;
        let registrationExpiresWithin30 = 0;
        const oilServiceDueRows = [];
        const registrationExpiresWithin30Rows = [];

        const dayDiff = (dateVal) => {
            const t = new Date(dateVal);
            if (Number.isNaN(t.getTime())) return null;
            t.setHours(0, 0, 0, 0);
            return Math.round((t.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        };

        const plateOf = (v) =>
            [v.plateEmirate, v.plateNumber].filter(Boolean).join(' ').trim() || String(v.assetId || '').trim() || '—';

        const vehicleModalBase = (v) => ({
            vehicleId: String(v._id),
            assetId: v.assetId || '',
            plate: plateOf(v),
            vehicleName: String(v.name || v.vehicleBrand || '').trim(),
        });

        for (const v of vehicles) {
            const sd = nextMaintenanceDate(v);
            if (sd) {
                const t = new Date(sd);
                t.setHours(0, 0, 0, 0);
                if (t < now) serviceDue++;
                else if (t <= soonEnd) serviceDueSoon++;
            }

            const oilDueRaw = v.gearOilDueDate || v.nextServiceDate || null;
            if (oilDueRaw) {
                const oilDiff = dayDiff(oilDueRaw);
                if (oilDiff != null && oilDiff <= 0) {
                    oilServiceDue++;
                    oilServiceDueRows.push({
                        ...vehicleModalBase(v),
                        cardName: v.gearOilDueDate ? 'Gear Oil Service' : 'Oil / Next Service',
                        expiryDate: oilDueRaw,
                        daysRemaining: oilDiff,
                        focusCard: 'vehicleService',
                        tab: 'service',
                    });
                }
            }

            const rd = registrationExpiry(v);
            if (rd) {
                const t = new Date(rd);
                t.setHours(0, 0, 0, 0);
                if (t < now) regDue++;
                else if (t <= soonEnd) regDueSoon++;
                const regDiff = dayDiff(rd);
                if (regDiff != null && regDiff <= 30) {
                    registrationExpiresWithin30++;
                    registrationExpiresWithin30Rows.push({
                        ...vehicleModalBase(v),
                        cardName: 'Mulkia (Registration)',
                        expiryDate: rd,
                        daysRemaining: regDiff,
                        focusCard: 'vehicleRegistration',
                        tab: 'basic',
                    });
                }
            }
        }

        const docExpiryBuckets = {
            Expired: [],
            '10-30 Days': [],
            More: [],
        };
        for (const v of vehicles) {
            for (const doc of collectVehicleExpiryDocuments(v)) {
                if (String(doc.docType || '') === 'service') continue;
                const diff = dayDiff(doc.expiryDate);
                if (diff == null) continue;
                let key = 'More';
                if (diff < 0) key = 'Expired';
                else if (diff <= 30) key = '10-30 Days';
                docExpiryBuckets[key].push({
                    ...vehicleModalBase(v),
                    cardName: doc.label,
                    docType: doc.docType,
                    expiryDate: doc.expiryDate,
                    daysRemaining: diff,
                    focusCard: resolveVehicleExpiryFocusCard(doc.docType),
                    tab: resolveVehicleExpiryTab(doc.docType),
                });
            }
        }
        const sortExpiryRows = (rows) =>
            [...rows].sort((a, b) => {
                const an = Number(a?.daysRemaining);
                const bn = Number(b?.daysRemaining);
                if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
                return String(a?.plate || '').localeCompare(String(b?.plate || ''));
            });

        const documentExpiryChartData = [
            { name: 'Expired', value: docExpiryBuckets.Expired.length, docs: sortExpiryRows(docExpiryBuckets.Expired) },
            {
                name: '10-30 Days',
                value: docExpiryBuckets['10-30 Days'].length,
                docs: sortExpiryRows(docExpiryBuckets['10-30 Days']),
            },
            { name: 'More', value: docExpiryBuckets.More.length, docs: sortExpiryRows(docExpiryBuckets.More) },
        ];

        const stNorm = (s) => String(s || '').toLowerCase().trim();
        const empDisplayName = (emp) => formatEmployeeDisplayName(emp) || '';
        const companyDisplayName = (c) =>
            String(c?.nickName || c?.companyShortName || c?.companyName || c?.name || '').trim();
        const assignedUserOf = (v) => {
            const emp = empDisplayName(v.assignedTo);
            if (emp) return emp;
            const company = companyDisplayName(v.assignedCompany);
            if (company) return company;
            return 'Unassigned';
        };
        const calendarDaysSince = (dateVal) => {
            if (!dateVal) return null;
            const t = new Date(dateVal);
            if (Number.isNaN(t.getTime())) return null;
            t.setHours(0, 0, 0, 0);
            return Math.max(0, Math.round((now.getTime() - t.getTime()) / (1000 * 60 * 60 * 24)));
        };

        // Legacy Permanent assignments never stored assignedDate — fall back to latest Accepted/Assigned history.
        const assignedMissingDateIds = vehicles
            .filter((v) => stNorm(v.status) === 'assigned' && !v.assignedDate)
            .map((v) => v._id)
            .filter(Boolean);
        const assignedStartByAssetId = new Map();
        if (assignedMissingDateIds.length) {
            const historyStarts = await AssetHistory.aggregate([
                {
                    $match: {
                        assetId: { $in: assignedMissingDateIds },
                        action: { $in: ['Accepted', 'Assigned'] },
                    },
                },
                { $sort: { date: -1 } },
                { $group: { _id: '$assetId', startDate: { $first: '$date' } } },
            ]);
            for (const row of historyStarts) {
                if (row?._id && row.startDate) {
                    assignedStartByAssetId.set(String(row._id), row.startDate);
                }
            }
        }
        const resolveAssignedStartDate = (v) =>
            v.assignedDate || assignedStartByAssetId.get(String(v._id)) || null;

        const parseServiceRemark = (service) => {
            if (!service?.remark || typeof service.remark !== 'string') return {};
            try {
                const parsed = JSON.parse(service.remark);
                return parsed && typeof parsed === 'object' ? parsed : {};
            } catch {
                return {};
            }
        };
        const stagePendingLabel = (stage) => {
            const key = String(stage || '').toLowerCase().trim();
            const map = {
                requester: 'Requester',
                admin: 'Admin Officer',
                admin_officer: 'Admin Officer',
                adminofficer: 'Admin Officer',
                hr: 'HR',
                accounts: 'Accounts',
                asset_controller: 'Asset Controller',
                assetcontroller: 'Asset Controller',
                scheduled_service: 'Scheduled service',
                on_service: 'On service',
                workshop: 'Workshop',
                return_to_live: 'Return to live',
            };
            if (!key) return '';
            return map[key] || key.replace(/_/g, ' ');
        };
        const isPendingVehicleService = (asset, service) => {
            if (!service) return false;
            const remark = parseServiceRemark(service);
            const requestStatus = String(remark.requestStatus || '').toLowerCase();
            const serviceStatus = String(remark.serviceStatus || remark.accidentServiceStatus || '')
                .toLowerCase()
                .replace(/\s+/g, '_');
            if (String(remark.vehicleServiceCompleted || '').toLowerCase() === 'live') return false;
            if (serviceStatus === 'complete' || serviceStatus === 'completed') return false;

            const activeWf = asset?.activeServiceWorkflow || {};
            const activeMatch =
                activeWf?.serviceRecordId &&
                String(activeWf.serviceRecordId) === String(service._id || '');
            const stage = String(
                service?.workflowSnapshot?.stage ||
                    (activeMatch ? activeWf.stage : '') ||
                    remark.workflowStage ||
                    remark.stage ||
                    '',
            )
                .toLowerCase()
                .trim();
            if (stage === 'complete' || stage === 'rejected') return false;
            if (['draft', 'pending', 'submitted'].includes(requestStatus)) return true;
            if (activeMatch && stage) return true;
            if (stage && !['complete', 'rejected'].includes(stage)) return true;
            return false;
        };

        let assigned = 0;
        let unassigned = 0;
        let inService = 0;
        const assignedRows = [];
        const unassignedRows = [];
        const inServiceRows = [];
        const totalServiceRows = [];

        const pendingServiceActions = vehicleIds.length
            ? await DashboardAction.find({
                  requestId: { $in: vehicleIds },
                  requestType: 'Vehicle Service Request',
                  status: 'Pending',
              })
                  .populate('assignedTo', 'firstName lastName employeeId')
                  .select('requestId assignedTo extra3')
                  .lean()
                  .catch(() => [])
            : [];
        const pendingForByServiceKey = new Map();
        for (const row of pendingServiceActions) {
            let serviceRecordId = '';
            try {
                const meta =
                    typeof row.extra3 === 'object' && row.extra3
                        ? row.extra3
                        : JSON.parse(String(row.extra3 || '{}'));
                serviceRecordId = String(meta?.serviceRecordId || '').trim();
            } catch {
                serviceRecordId = '';
            }
            const key = `${String(row.requestId)}:${serviceRecordId || '*'}`;
            const name = empDisplayName(row.assignedTo);
            if (name) pendingForByServiceKey.set(key, name);
        }

        for (const v of vehicles) {
            const st = stNorm(v.status);
            const base = vehicleModalBase(v);
            const assignedUser = assignedUserOf(v);

            for (const service of v.services || []) {
                if (!isPendingVehicleService(v, service)) continue;
                const remark = parseServiceRemark(service);
                const serviceId = String(service._id || '');
                const activeWf = v.activeServiceWorkflow || {};
                const activeMatch =
                    activeWf?.serviceRecordId && String(activeWf.serviceRecordId) === serviceId;
                const stage = String(
                    service?.workflowSnapshot?.stage ||
                        (activeMatch ? activeWf.stage : '') ||
                        remark.workflowStage ||
                        remark.stage ||
                        '',
                ).trim();
                const startRaw =
                    remark.serviceStartDate ||
                    remark.scheduledServiceDate ||
                    activeWf?.scheduledServiceDate ||
                    service.date ||
                    null;
                const pendingFor =
                    pendingForByServiceKey.get(`${String(v._id)}:${serviceId}`) ||
                    pendingForByServiceKey.get(`${String(v._id)}:*`) ||
                    (activeMatch ? empDisplayName(v.actionRequiredBy) : '') ||
                    stagePendingLabel(stage) ||
                    '—';

                totalServiceRows.push({
                    ...base,
                    modalKind: 'pendingService',
                    cardName: service.serviceType || remark.serviceTypeLabel || 'Service',
                    serviceType: service.serviceType || remark.serviceTypeLabel || 'Service',
                    serviceId,
                    assignedUser,
                    pendingForWhom: pendingFor,
                    serviceStartDate: startRaw,
                    daysPending: calendarDaysSince(startRaw),
                    daysRemaining: calendarDaysSince(startRaw),
                    expiryDate: null,
                    focusCard: '',
                    tab: 'service',
                });
            }

            // Assigned / Unassigned: vehicle status only (match fleet list summary).
            if (st === 'assigned') {
                assigned++;
                const assignedStart = resolveAssignedStartDate(v);
                assignedRows.push({
                    ...base,
                    modalKind: 'assigned',
                    cardName: 'Assigned',
                    vehicleName: base.vehicleName || '—',
                    assignedUser,
                    daysAssigned: calendarDaysSince(assignedStart),
                    daysRemaining: calendarDaysSince(assignedStart),
                    expiryDate: null,
                    focusCard: '',
                    tab: 'basic',
                });
            }
            if (st === 'unassigned' || st === 'available') {
                unassigned++;
                unassignedRows.push({
                    ...base,
                    modalKind: 'unassigned',
                    cardName: 'Unassigned',
                    vehicleName: base.vehicleName || '—',
                    daysUnassigned: calendarDaysSince(v.updatedAt),
                    daysRemaining: calendarDaysSince(v.updatedAt),
                    expiryDate: null,
                    focusCard: '',
                    tab: 'basic',
                });
            }
            // In service: currently on service mode (not waiting / pending requests).
            if (st === 'service' || st === 'on service' || st === 'in service') {
                inService++;
                inServiceRows.push({
                    ...base,
                    cardName: 'In service',
                    daysRemaining: null,
                    expiryDate: null,
                    focusCard: '',
                    tab: 'service',
                });
            }
        }

        const totalServices = totalServiceRows.length;

        let handoverPending = 0;
        let handoverConfirmed = 0;
        for (const v of vehicles) {
            if (v.assignedTo && String(v.acceptanceStatus || '') === 'Pending') handoverPending++;
            if (v.assignedTo && String(v.acceptanceStatus || '') === 'Accepted') handoverConfirmed++;
        }

        let daPending = 0;
        let daApproved = 0;
        if (vehicleIds.length) {
            daPending = await DashboardAction.countDocuments({
                requestId: { $in: vehicleIds },
                status: 'Pending',
                requestType: { $in: ASSET_DASHBOARD_INBOX_TYPES }
            });
            daApproved = await DashboardAction.countDocuments({
                requestId: { $in: vehicleIds },
                status: 'Approved',
                requestType: { $in: ASSET_DASHBOARD_INBOX_TYPES }
            });
        }

        const monthTotals = {};
        for (const v of vehicles) {
            for (const s of v.services || []) {
                if (!s?.date) continue;
                const d = new Date(s.date);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                monthTotals[key] = (monthTotals[key] || 0) + Number(s.value || 0);
            }
        }
        const monthKeys = Object.keys(monthTotals).sort();
        const serviceCostByMonth = monthKeys.slice(-12).map((k) => ({ label: k, total: monthTotals[k] }));

        const yearCounts = {};
        for (const v of vehicles) {
            const y = (v.modelYear || 'Unknown').toString().trim() || 'Unknown';
            yearCounts[y] = (yearCounts[y] || 0) + 1;
        }
        const modelYearDistribution = Object.entries(yearCounts)
            .map(([year, count]) => ({ year, count }))
            .sort((a, b) => {
                const na = parseInt(a.year, 10);
                const nb = parseInt(b.year, 10);
                if (!Number.isNaN(na) && !Number.isNaN(nb)) return nb - na;
                if (a.year === 'Unknown') return 1;
                if (b.year === 'Unknown') return -1;
                return String(b.year).localeCompare(String(a.year));
            });

        const hasServiceInRange = (v, start, end) =>
            (v.services || []).some((s) => {
                if (!s?.date) return false;
                const t = new Date(s.date).getTime();
                return t >= start.getTime() && t <= end.getTime();
            });

        const countServicesInRange = (start, end) => {
            let c = 0;
            for (const v of vehicles) {
                for (const s of v.services || []) {
                    if (!s?.date) continue;
                    const t = new Date(s.date).getTime();
                    if (t >= start.getTime() && t <= end.getTime()) c++;
                }
            }
            return c;
        };

        const buildUsageSeries = (unit) => {
            const labels = [];
            const usage = [];
            const idle = [];
            if (unit === 'day') {
                for (let i = 6; i >= 0; i--) {
                    const start = new Date(now);
                    start.setDate(start.getDate() - i);
                    start.setHours(0, 0, 0, 0);
                    const end = new Date(start);
                    end.setHours(23, 59, 59, 999);
                    labels.push(`${start.getDate()}/${start.getMonth() + 1}`);
                    usage.push(countServicesInRange(start, end));
                    idle.push(vehicles.filter((v) => !hasServiceInRange(v, start, end)).length);
                }
            } else if (unit === 'week') {
                for (let i = 7; i >= 0; i--) {
                    const end = new Date(now);
                    end.setDate(end.getDate() - i * 7);
                    end.setHours(23, 59, 59, 999);
                    const start = new Date(end);
                    start.setDate(start.getDate() - 6);
                    start.setHours(0, 0, 0, 0);
                    labels.push(`W${8 - i}`);
                    usage.push(countServicesInRange(start, end));
                    idle.push(vehicles.filter((v) => !hasServiceInRange(v, start, end)).length);
                }
            } else {
                for (let i = 11; i >= 0; i--) {
                    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                    const start = new Date(d.getFullYear(), d.getMonth(), 1);
                    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
                    labels.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
                    usage.push(countServicesInRange(start, end));
                    idle.push(vehicles.filter((v) => !hasServiceInRange(v, start, end)).length);
                }
            }
            return { labels, usage, idle };
        };

        const fleetAnalytics = buildVehicleFleetAnalytics(vehicles);

        res.json({
            reminders: {
                service: { due: serviceDue, dueSoon: serviceDueSoon },
                registration: { due: regDue, dueSoon: regDueSoon },
                oilServiceDue,
                registrationExpiresWithin30,
                oilServiceDueRows: sortExpiryRows(oilServiceDueRows),
                registrationExpiresWithin30Rows: sortExpiryRows(registrationExpiresWithin30Rows),
            },
            vehicleStatus: {
                assigned,
                unassigned,
                inService,
                totalServices,
                assignedRows,
                unassignedRows,
                inServiceRows,
                totalServiceRows,
            },
            documentExpiryChartData,
            serviceRequest: { pending: daPending, confirmed: daApproved },
            handoverRequest: { pending: handoverPending, confirmed: handoverConfirmed },
            serviceCostByMonth,
            vehicles: fleetRows,
            modelYearDistribution,
            fleetAnalytics,
            usageByPeriod: {
                day: buildUsageSeries('day'),
                week: buildUsageSeries('week'),
                month: buildUsageSeries('month')
            },
            generatedAt: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to load vehicle fleet dashboard' });
    }
};

function mapAssetHistoryWorkflowActionToTimelineAction(wa) {
    if (wa === 'start') return 'created';
    return wa || 'approve';
}

function inferWorkflowStageFromHistoryEvents(eventsChrono) {
    if (!eventsChrono.length) return null;
    if (eventsChrono.some((e) => e.workflowAction === 'reject')) return 'rejected';
    const last = eventsChrono[eventsChrono.length - 1];
    if (!last) return null;
    if (last.workflowAction === 'hold') return 'pending_accounts';
    if (last.workflowAction === 'start') return 'pending_hr';
    if (last.workflowAction === 'approve') {
        if (last.stage === 'pending_management') return 'complete';
        if (last.stage === 'pending_admin') return 'scheduled_service';
        const next = {
            pending_hr: 'pending_accounts',
            pending_accounts: 'pending_admin',
            pending_admin: 'scheduled_service',
            scheduled_service: 'complete',
            pending_management: 'complete',
        };
        return next[last.stage] || 'complete';
    }
    if (last.stage) return last.stage;
    return null;
}

/** Map embedded snapshot history (action: created|approve|…) to infer stage when `stage` field missing. */
function inferStageFromEmbeddedHistory(hist) {
    if (!Array.isArray(hist) || !hist.length) return null;
    const ev = hist.map((h) => ({
        stage: h.stage,
        workflowAction: h.action === 'created' ? 'start' : h.action,
    }));
    return inferWorkflowStageFromHistoryEvents(ev) || null;
}

/** When services[].workflowSnapshot was never stored, rebuild from AssetHistory (details.serviceRecordId). */
function workflowSnapshotFromAssetHistoryDocs(historyDocs, serviceTypeLabelFallback) {
    if (!historyDocs?.length) return null;
    const sorted = [...historyDocs].sort((a, b) => new Date(a.date) - new Date(b.date));
    const timeline = sorted.map((d) => {
        const det = d.details || {};
        return {
            stage: det.stage,
            workflowAction: det.workflowAction,
            note: det.note || '',
            byName: det.byName || '',
            at: d.date,
        };
    });
    let stage = inferWorkflowStageFromHistoryEvents(
        timeline.map((t) => ({ stage: t.stage, workflowAction: t.workflowAction }))
    );
    if (!stage && timeline.length) {
        const hasApprove = timeline.some((t) => t.workflowAction === 'approve');
        stage = hasApprove ? 'complete' : 'pending_hr';
    }
    if (!stage) return null;
    const history = timeline.map((t) => ({
        stage: t.stage,
        action: mapAssetHistoryWorkflowActionToTimelineAction(t.workflowAction),
        note: t.note,
        byName: t.byName,
        at: t.at,
    }));
    const firstDet = sorted[0]?.details || {};
    return {
        stage,
        serviceTypeLabel: firstDet.serviceTypeLabel || serviceTypeLabelFallback || '',
        serviceRecordId: firstDet.serviceRecordId || null,
        history,
    };
}

/** Mixed `details.serviceRecordId` may be ObjectId, string, or populated shape. */
function rawServiceRecordIdFromHistoryDetails(details) {
    let sid = details?.serviceRecordId;
    if (sid != null && typeof sid === 'object' && !(sid instanceof mongoose.Types.ObjectId) && sid._id) {
        sid = sid._id;
    }
    return sid;
}

/** Stable map key for pairing AssetHistory rows to services[]. */
function workflowLogKey(assetId, serviceSubdocId) {
    const aid = String(assetId);
    let sid = '';
    if (serviceSubdocId != null && serviceSubdocId !== '') {
        const raw = String(serviceSubdocId);
        sid = mongoose.Types.ObjectId.isValid(raw) ? new mongoose.Types.ObjectId(raw).toString() : raw;
    }
    return `${aid}::${sid}`;
}

function serviceTypeLabelCompatibleWithRow(logLabel, rowServiceType) {
    const L = String(logLabel || '').trim();
    const T = String(rowServiceType || '').trim();
    if (!L || !T) return true;
    if (L === T) return true;
    const a = L.toLowerCase();
    const b = T.toLowerCase();
    return a.includes(b) || b.includes(a);
}

/**
 * Logs without details.serviceRecordId: assign each to the nearest service row by date
 * (same calendar day was too strict when workflow events and service.date differ).
 * Uses label match when possible; falls back to date-only so custom labels do not drop all logs.
 */
function assignOrphanLogsToServicesByNearestDate(assetId, services, orphans) {
    const out = new Map();
    if (!orphans?.length || !services?.length) return out;
    const aid = String(assetId);
    const sorted = [...services].sort((a, b) => {
        const da = a.date ? new Date(a.date).getTime() : 0;
        const db = b.date ? new Date(b.date).getTime() : 0;
        if (da !== db) return da - db;
        return String(a._id).localeCompare(String(b._id));
    });
    const maxDistMs = 400 * 24 * 60 * 60 * 1000;

    const pickNearest = (log, requireTypeMatch) => {
        let best = null;
        let bestDist = Infinity;
        const lt = new Date(log.date).getTime();
        const stLbl = String(log.details?.serviceTypeLabel || '').trim();
        for (const s of sorted) {
            const sType = String(s.serviceType || '').trim();
            if (requireTypeMatch && !serviceTypeLabelCompatibleWithRow(stLbl, sType)) continue;
            const sd = s.date ? new Date(s.date).getTime() : lt;
            const d = Math.abs(lt - sd);
            if (
                d < bestDist ||
                (d === bestDist && best && String(s._id).localeCompare(String(best._id)) < 0)
            ) {
                bestDist = d;
                best = s;
            }
        }
        if (!best || bestDist > maxDistMs) return null;
        return best;
    };

    for (const log of orphans) {
        let best = pickNearest(log, true);
        if (!best) best = pickNearest(log, false);
        if (!best) continue;
        const key = workflowLogKey(aid, best._id);
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(log);
    }
    for (const arr of out.values()) {
        arr.sort((a, b) => new Date(a.date) - new Date(b.date));
    }
    return out;
}

/**
 * Flat list of all service records across vehicle assets (for fleet dashboard table).
 * @route GET /api/AssetItem/vehicle-fleet-service-requests
 */
export const getVehicleFleetServiceRequests = async (req, res) => {
    try {
        const draftVis = buildDraftVisibilityQuery(req.user);
        const items = await AssetItem.find({ $and: [draftVis] })
            .populate('typeId', 'name')
            .select('assetId name plateEmirate plateNumber services typeId activeServiceWorkflow vehicleProfileActivationStatus')
            .lean();

        const isVehicleAsset = (it) =>
            isFleetVehicleAssetFields({
                plateNumber: it.plateNumber,
                typeName: it.typeId?.name || '',
                asset: it,
            });

        const vehicles = items.filter(isVehicleAsset);

        const assetIds = [];
        vehicles.forEach((vv) => {
            assetIds.push(vv._id);
        });
        const keyedWorkflowLogs = new Map();
        const unkeyedWorkflowLogsByAsset = new Map();
        if (assetIds.length) {
            const wfLogsAll = await AssetHistory.find({
                assetId: { $in: assetIds },
                'details.type': 'VehicleServiceWorkflow',
            })
                .select('assetId date details')
                .lean();
            for (const log of wfLogsAll) {
                const sid = rawServiceRecordIdFromHistoryDetails(log.details);
                const aid = String(log.assetId);
                if (sid != null && sid !== '') {
                    const k = workflowLogKey(aid, sid);
                    if (!keyedWorkflowLogs.has(k)) keyedWorkflowLogs.set(k, []);
                    keyedWorkflowLogs.get(k).push(log);
                } else {
                    if (!unkeyedWorkflowLogsByAsset.has(aid)) unkeyedWorkflowLogsByAsset.set(aid, []);
                    unkeyedWorkflowLogsByAsset.get(aid).push(log);
                }
            }
        }

        const orphanLogsByServiceKey = new Map();
        for (const v of vehicles) {
            const orphans = unkeyedWorkflowLogsByAsset.get(String(v._id)) || [];
            const part = assignOrphanLogsToServicesByNearestDate(v._id, v.services || [], orphans);
            for (const [k, logs] of part.entries()) {
                orphanLogsByServiceKey.set(k, logs);
            }
        }

        const vehicleLabel = (v) => {
            const plate = [v.plateEmirate, v.plateNumber].filter(Boolean).join(' ').trim();
            if (plate) return plate;
            return v.name || v.assetId || String(v._id);
        };

        const rows = [];
        for (const v of vehicles) {
            const vLabel = vehicleLabel(v);
            const wf = v.activeServiceWorkflow || {};
            const wfSid = wf.serviceRecordId;
            for (const s of v.services || []) {
                const serviceTypeLabel = String(s.serviceType || '').trim();
                if (serviceTypeLabel === 'Oil Service' || serviceTypeLabel === 'Car Wash') {
                    continue;
                }
                const [attachment, quotation2, quotation3, invoice] = await Promise.all([
                    s.attachment ? getSignedFileUrl(s.attachment) : Promise.resolve(null),
                    s.quotation2 ? getSignedFileUrl(s.quotation2) : Promise.resolve(null),
                    s.quotation3 ? getSignedFileUrl(s.quotation3) : Promise.resolve(null),
                    s.invoice ? getSignedFileUrl(s.invoice) : Promise.resolve(null),
                ]);
                const wfMatch = wfSid && String(wfSid) === String(s._id);
                const stored = s.workflowSnapshot;
                let workflowSnapshot = null;
                if (stored && (stored.stage || (Array.isArray(stored.history) && stored.history.length))) {
                    const sh = Array.isArray(stored.history) ? stored.history : [];
                    let stageVal = stored.stage;
                    if (!stageVal && sh.length) {
                        stageVal = inferStageFromEmbeddedHistory(sh) || 'complete';
                    }
                    workflowSnapshot = {
                        stage: stageVal,
                        serviceTypeLabel: stored.serviceTypeLabel || '',
                        serviceRecordId: stored.serviceRecordId || s._id,
                        history: sh.map((h) => ({
                            stage: h.stage,
                            action: h.action,
                            note: h.note || '',
                            byName: h.byName || '',
                            at: h.at,
                        })),
                    };
                } else if (wfMatch && wf.stage) {
                    const hist = Array.isArray(wf.history) ? wf.history : [];
                    workflowSnapshot = {
                        stage: wf.stage,
                        serviceTypeLabel: wf.serviceTypeLabel || '',
                        serviceRecordId: wf.serviceRecordId,
                        history: hist.map((h) => ({
                            stage: h.stage,
                            action: h.action,
                            note: h.note || '',
                            byName: h.byName || '',
                            at: h.at,
                        })),
                    };
                }
                if (!workflowSnapshot) {
                    const k = workflowLogKey(v._id, s._id);
                    let docs = keyedWorkflowLogs.get(k);
                    if (!docs?.length) {
                        docs = orphanLogsByServiceKey.get(k);
                    }
                    if (docs?.length) {
                        const rebuilt = workflowSnapshotFromAssetHistoryDocs(docs, s.serviceType);
                        if (rebuilt && (rebuilt.stage || (rebuilt.history && rebuilt.history.length))) {
                            const sh = Array.isArray(rebuilt.history) ? rebuilt.history : [];
                            workflowSnapshot = {
                                stage: rebuilt.stage || 'complete',
                                serviceTypeLabel: rebuilt.serviceTypeLabel || '',
                                serviceRecordId: rebuilt.serviceRecordId || s._id,
                                history: sh.map((h) => ({
                                    stage: h.stage,
                                    action: h.action,
                                    note: h.note || '',
                                    byName: h.byName || '',
                                    at: h.at,
                                })),
                            };
                        }
                    }
                }
                if (!workflowSnapshot && s._id) {
                    workflowSnapshot = {
                        stage: null,
                        history: [],
                        serviceRecordId: s._id,
                        serviceTypeLabel: s.serviceType || '',
                        trailIncomplete: true,
                    };
                }
                const rowWorkflowStage = workflowSnapshot?.stage ?? (wfMatch ? wf.stage || null : null);
                const rowWorkflowLabel =
                    workflowSnapshot?.serviceTypeLabel ?? (wfMatch ? wf.serviceTypeLabel || '' : '');
                const hasUsableTrail =
                    workflowSnapshot &&
                    !workflowSnapshot.trailIncomplete &&
                    (workflowSnapshot.stage || (Array.isArray(workflowSnapshot.history) && workflowSnapshot.history.length > 0));
                rows.push({
                    serviceId: s._id,
                    serviceType: s.serviceType,
                    date: s.date,
                    value: s.value,
                    description: s.description || '',
                    paidBy: s.paidBy || null,
                    requestedById: s.requestedBy || null,
                    currentKm: s.currentKm != null ? s.currentKm : null,
                    remark: s.remark || '',
                    requestStatus: (() => {
                        try {
                            const r = s.remark ? JSON.parse(s.remark) : null;
                            return String(r?.requestStatus || '').toLowerCase() === 'draft' ? 'draft' : 'submitted';
                        } catch {
                            return 'submitted';
                        }
                    })(),
                    vehicleId: v._id,
                    vehicleAssetId: v.assetId,
                    vehicleLabel: vLabel,
                    vehicleProfileActivationStatus: v.vehicleProfileActivationStatus || '',
                    attachment,
                    quotation2,
                    quotation3,
                    invoice,
                    workflowStage: rowWorkflowStage,
                    workflowServiceTypeLabel: rowWorkflowLabel,
                    workflowSnapshot,
                    vehicleHasDifferentActiveWorkflow:
                        !!(wf.stage && !['complete', 'rejected'].includes(wf.stage)) &&
                        !wfMatch &&
                        !hasUsableTrail &&
                        !workflowSnapshot?.trailIncomplete,
                });
            }
        }

        rows.sort((a, b) => {
            const ta = a.date ? new Date(a.date).getTime() : 0;
            const tb = b.date ? new Date(b.date).getTime() : 0;
            return tb - ta;
        });

        res.json({ items: rows, total: rows.length });
    } catch (error) {
        res.status(500).json({ message: 'Failed to load vehicle service records' });
    }
};

export const getAllAssignedAssets = async (req, res) => {
    try {
        const { companyId, status } = req.query;

        let query = {};

        const normalizedStatus = status?.toLowerCase();

        // Handle status filter
        if (status && normalizedStatus !== 'all') {
            query.status = status;
        } else {
            // Default: Show all except Draft
            query.status = { $ne: 'Draft' };
        }

        // Handle company filtering — company profile lists all non-draft company allocations
        if (companyId) {
            query.assignedCompany = companyId;
            query.assignedToType = 'Company';
        } else if (!status) {
            // ONLY apply restricted fallback if NO status is provided at all (initial load/default)
            // to keep it focused on items with some assignment or unassigned status
            query.$or = [
                { assignedTo: { $ne: null } },
                { assignedCompany: { $ne: null } },
                { status: { $in: ['Unassigned', 'Pending', 'Assigned', 'On Leave', 'Returned', 'Lost', 'Service', 'Maintenance', 'On Service', 'Waiting for Service'] } }
            ];
        }

        const draftVis = buildDraftVisibilityQuery(req.user);
        if (query.$or) {
            query = { $and: [query, draftVis] };
        } else {
            Object.assign(query, draftVis);
        }

        const pendingAccessoryCtx = await buildPendingAccessoryVisibilityCtx(req);

        const items = await AssetItem.find(query)
            .select('assetId name ownership assignedTo assignedToType assignedCompany accessories assetValue purchaseDate assignedDate status updatedAt typeId categoryId invoiceFile documents actionRequiredBy pendingAction acceptanceStatus')
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId company'
            })
            .populate('assignedCompany', 'name companyId nickName')
            .populate('actionRequiredBy', 'employeeId')
            .populate('typeId', 'name')
            .populate('categoryId', 'name')
            .sort({ name: 1 });

        const signedItems = await Promise.all(items.map(async (item) => {
            const itemObj = item.toObject();
            const canSeePending = computeCanSeePendingAddsForAsset(pendingAccessoryCtx, item);
            if (itemObj.accessories?.length) {
                itemObj.accessories = filterAccessoriesHidingPendingAdds(itemObj.accessories, canSeePending, itemObj.status);
            }
            if (itemObj.invoiceFile) {
                itemObj.invoiceFile = await getSignedFileUrl(itemObj.invoiceFile);
            }
            if (itemObj.documents && itemObj.documents.length > 0) {
                for (let doc of itemObj.documents) {
                    if (doc.attachment) {
                        doc.attachment = await getSignedFileUrl(doc.attachment);
                    }
                }
            }
            return itemObj;
        }));

        res.status(200).json(signedItems);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    List current user's assigned assets eligible for return (no pending action)
// @route   GET /api/AssetItem/assigned/me-for-return
// @access  Private
export const getMyAssignedAssetsForReturn = async (req, res) => {
    try {
        let currentEmpId = req.user?.employeeObjectId?.toString();
        if (!currentEmpId && req.user?.employeeId) {
            const empRow = await EmployeeBasic.findOne({
                employeeId: { $regex: new RegExp(`^${String(req.user.employeeId).replace(/\s+/g, '\\s*')}$`, 'i') }
            })
                .select('_id')
                .lean();
            if (empRow) currentEmpId = empRow._id.toString();
        }
        if (!currentEmpId) {
            return res.status(400).json({ message: 'Employee profile not linked to your account.' });
        }

        const items = await AssetItem.find({
            assignedTo: currentEmpId,
            status: 'Assigned',
            $or: [{ pendingAction: null }, { pendingAction: { $exists: false } }]
        })
            .select('assetId name typeId categoryId')
            .populate('typeId', 'name')
            .populate('categoryId', 'name')
            .sort({ name: 1 })
            .lean();

        res.status(200).json({ items });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};


export const getUnassignedAssetsForEmployee = async (req, res) => {
    try {
        const { employeeId } = req.params;
        const checkOnly = req.query.checkOnly === 'true';

        const assetController = await getDepartmentHOD('assetcontroller');

        const employee = await EmployeeBasic.findOne({
            employeeId: { $regex: new RegExp(`^${employeeId}$`, 'i') }
        }).select('_id employeeId');

        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const employeeObjectId = employee._id;

        // IMPORTANT:
        // This endpoint is used to show tabs when someone opens the PROFILE of employeeId.
        // So authorization must be based on the *profile employee* being an asset controller,
        // not on the currently logged-in viewer.
        const normEmp = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
        const isProfileAssetController = (() => {
            // Department fallback: if :employeeId matches the configured AC.
            try {
                if (assetController?._id && assetController._id.toString() === employeeObjectId.toString()) return true;
                if (assetController?.employeeId && normEmp(assetController.employeeId) === normEmp(employee.employeeId)) return true;
            } catch {
                // ignore
            }
            return false;
        })();

        let isAuthorized = isProfileAssetController;
        if (!isAuthorized) {
            // Flowchart: check whether the profile employee is in the assetcontroller flowchart.
            try {
                const profileUserForCheck = {
                    employeeObjectId,
                    employeeId: employee.employeeId
                };
                isAuthorized = await isUserInFlowchart(profileUserForCheck, 'assetcontroller');
            } catch (flowchartError) {
                if (checkOnly) {
                    return res.status(200).json({ isAuthorized: false });
                }
                return res.status(403).json({
                    message: 'Access denied. Only Asset Controllers can view unassigned assets.',
                    code: 'ASSET_CONTROLLER_REQUIRED',
                    error: 'Flowchart service unavailable'
                });
            }
        }

        if (!isAuthorized) {
            if (checkOnly) {
                return res.status(200).json({ isAuthorized: false });
            }
            return res.status(403).json({
                message: 'Access denied. Only Asset Controllers can view unassigned assets.',
                code: 'ASSET_CONTROLLER_REQUIRED',
                employeeId: employeeId
            });
        }

        if (checkOnly) {
            return res.status(200).json({ isAuthorized: true });
        }

        const items = await AssetItem.find({
            status: { $in: ['Unassigned', 'Returned'] },
        })
            .select('assetId name assetValue status purchaseDate invoiceFile typeId categoryId')
            .populate('typeId', 'name type')
            .populate('categoryId', 'name category')
            .sort({ assetId: 1 });

        const filteredItems = items.filter((item) => isAssignableFromPoolStatus(item.status));

        res.status(200).json({
            items: filteredItems,
            controllerStatus: 'Active'
        });
    } catch (error) {

        res.status(500).json({
            message: 'Server Error',
            error: error.message,
            stack: error.stack,
            name: error.name
        });
    }
};

export const getOnLeaveAssetsForEmployee = async (req, res) => {
    try {
        await processParkingAssets();
        const { employeeId } = req.params;

        const assetController = await getDepartmentHOD('assetcontroller');

        const employee = await EmployeeBasic.findOne({
            employeeId: { $regex: new RegExp(`^${employeeId}$`, 'i') }
        }).select('_id employeeId');

        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const employeeObjectId = employee._id;

        // IMPORTANT:
        // This endpoint is used to show Parking tabs when someone opens the PROFILE of :employeeId.
        // So authorization must be based on the *profile employee* being an asset controller,
        // not based on currently logged-in viewer.
        const normEmp = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
        const isProfileAssetController = (() => {
            try {
                if (assetController?._id && assetController._id.toString() === employeeObjectId.toString()) return true;
                if (assetController?.employeeId && normEmp(assetController.employeeId) === normEmp(employee.employeeId)) return true;
            } catch {
                // ignore
            }
            return false;
        })();

        let isAuthorized = isProfileAssetController;
        if (!isAuthorized) {
            // Check profile employee in the flowchart
            try {
                isAuthorized = await isUserInFlowchart(
                    { employeeObjectId, employeeId: employee.employeeId },
                    'assetcontroller'
                );
            } catch (flowchartError) {
                return res.status(403).json({
                    message: 'Access denied. Only Asset Controllers can view on-leave assets.',
                    code: 'ASSET_CONTROLLER_REQUIRED',
                    error: 'Flowchart service unavailable'
                });
            }
        }

        if (!isAuthorized) {
            return res.status(403).json({
                message: 'Access denied. Only Asset Controllers can view on-leave assets.',
                code: 'ASSET_CONTROLLER_REQUIRED',
                employeeId
            });
        }

        const items = await AssetItem.find(onLeaveActiveOnlyQueryFilter())
            .select('assetId name assetValue status onLeaveActive onServiceActive purchaseDate invoiceFile typeId categoryId assignedTo assignedToType assignedCompany assignedDate onLeaveStartDate onLeaveEndDate onLeaveDuration')
            .populate('typeId', 'name type')
            .populate('categoryId', 'name category')
            .populate('assignedTo', 'firstName lastName employeeId')
            .sort({ assetId: 1 });

        res.status(200).json({
            items: items,
            controllerStatus: 'Active'
        });
    } catch (error) {
        res.status(500).json({
            message: 'Server Error',
            error: error.message
        });
    }
};

/**
 * @desc    Run service expiry / overdue checks (email on last day, tasks when overdue)
 * @route   POST /api/AssetItem/on-service/run-overdue-check
 * @access  Asset Controller or Admin
 */
export const runAssetServiceOverdueCheck = async (req, res) => {
    try {
        const isAdmin = isJwtSystemSuperUser(req.user);
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');
        if (!isAdmin && !isAssetController) {
            return res.status(403).json({ message: 'Access denied.' });
        }
        const result = await processAssetServiceOverdue();
        return res.status(200).json({
            message: 'Service overdue check completed',
            ...result,
        });
    } catch (error) {
        return res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

/**
 * @desc    Get on-service assets for Asset Controller profile view
 * @route   GET /api/AssetItem/on-service/controller/:employeeId
 * @access  Private
 */
export const getOnServiceAssetsForEmployee = async (req, res) => {
    try {
        const { employeeId } = req.params;

        const employee = await EmployeeBasic.findOne({
            employeeId: { $regex: new RegExp(`^${employeeId}$`, 'i') }
        }).select('_id employeeId');

        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const employeeObjectId = employee._id;

        const currentUserEmpObjectId = req.user?.employeeObjectId?.toString();
        const currentUserEmpId = req.user?.employeeId;

        let isAuthorized = false;
        if (
            currentUserEmpObjectId &&
            currentUserEmpObjectId === employeeObjectId.toString()
        ) {
            isAuthorized = true;
        } else if (currentUserEmpId && currentUserEmpId.toLowerCase() === employeeId.toLowerCase()) {
            isAuthorized = true;
        } else {
            const isAdmin = isJwtSystemSuperUser(req.user);
            if (isAdmin) {
                isAuthorized = true;
            } else {
                try {
                    isAuthorized = await isUserActiveInFlowchart(
                        { employeeObjectId, employeeId: employee.employeeId },
                        'assetcontroller'
                    );
                } catch {
                    return res.status(403).json({
                        message: 'Access denied. Only Asset Controllers can view on-service assets.',
                        code: 'ASSET_CONTROLLER_REQUIRED'
                    });
                }
            }
        }

        if (!isAuthorized) {
            return res.status(403).json({
                message: 'Access denied. Only Asset Controllers can view on-service assets.',
                code: 'ASSET_CONTROLLER_REQUIRED',
                employeeId
            });
        }

        // Match HRM Tools Assets list (`GET /AssetType?scope=tools`): VEGA-ASSET rows only,
        // no fleet vehicles (plate / vehicle type), onServiceActive=true only.
        const onServiceQuery = {
            $and: [
                onServiceActiveOnlyQueryFilter(),
                { assetId: { $regex: /^VEGA-ASSET-/i } },
                {
                    $or: [
                        { plateNumber: { $exists: false } },
                        { plateNumber: null },
                        { plateNumber: '' },
                    ],
                },
            ],
        };
        const rawItems = await AssetItem.find(onServiceQuery)
            .select('assetId name assetValue status onLeaveActive onServiceActive purchaseDate invoiceFile plateNumber typeId categoryId assignedTo assignedDate services')
            .populate('typeId', 'name type')
            .populate('categoryId', 'name category')
            .populate('assignedTo', 'firstName lastName employeeId')
            .sort({ assetId: 1 })
            .lean();

        const terminalStatuses = new Set(['lost', 'rejected', 'end of life', 'endoflife']);
        const items = rawItems.filter((row) => {
            if (row.onServiceActive !== true) return false;
            const statusLow = String(row.status || '').trim().toLowerCase();
            if (terminalStatuses.has(statusLow)) return false;
            const typeName = row.typeId?.name || row.typeId?.type;
            const categoryName = row.categoryId?.name || row.categoryId?.category;
            if (isFleetVehicleAssetFields({ plateNumber: row.plateNumber, typeName })) {
                return false;
            }
            const tn = String(typeName || '').toLowerCase();
            const cat = String(categoryName || '').toLowerCase();
            if (
                tn.includes('van') ||
                tn.includes('pickup') ||
                cat.includes('vehicle') ||
                cat.includes('fleet')
            ) {
                return false;
            }
            return true;
        });

        res.status(200).json({
            items,
            controllerStatus: 'Active'
        });
    } catch (error) {
        res.status(500).json({
            message: 'Server Error',
            error: error.message
        });
    }
};

function parseServiceDurationDays(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (!value) return null;
    const m = value.match(/(\d+)\s*(day|week|month|year)s?/i);
    if (!m) {
        const direct = parseInt(value, 10);
        return Number.isInteger(direct) && direct > 0 ? direct : null;
    }
    const n = parseInt(m[1], 10);
    if (!Number.isInteger(n) || n <= 0) return null;
    const unit = m[2].toLowerCase();
    if (unit.startsWith('day')) return n;
    if (unit.startsWith('week')) return n * 7;
    if (unit.startsWith('month')) return n * 30;
    if (unit.startsWith('year')) return n * 365;
    return null;
}

/**
 * @desc    Handle On Service asset action (Return or Extend)
 * @route   PUT /api/AssetItem/:id/on-service-action
 * @access  Private
 */
export const handleOnServiceAction = async (req, res) => {
    try {
        const { id } = req.params;
        const { action, extensionDays, extensionReason } = req.body; // 'Return' | 'Extend'

        if (!['Return', 'Extend', 'Live'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action. Must be "Return", "Live", or "Extend"' });
        }

        const isAdmin = isJwtSystemSuperUser(req.user);
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');
        let actingEmpId = req.user?.employeeObjectId?.toString();
        if (!actingEmpId && req.user?.employeeId) {
            const me = await EmployeeBasic.findOne({
                employeeId: {
                    $regex: new RegExp(
                        `^${String(req.user.employeeId).replace(/\s+/g, '\\s*')}$`,
                        'i'
                    ),
                },
            })
                .select('_id')
                .lean()
                .catch(() => null);
            if (me?._id) actingEmpId = me._id.toString();
        }

        const item = await AssetItem.findById(id).populate('assignedTo');
        if (!item) return res.status(404).json({ message: 'Asset not found' });

        const isAssignedAsset = !!(item.assignedTo || item.assignedCompany);
        const isAssignedUser =
            !!item.assignedTo &&
            !!actingEmpId &&
            (item.assignedTo?._id || item.assignedTo).toString() === actingEmpId;

        if (action === 'Extend') {
            if (!isAdmin && !isAssetController) {
                return res.status(403).json({ message: 'Access denied. Only Asset Controller or Admin can extend service.' });
            }
        } else if (action === 'Live') {
            if (!isAssignedAsset) {
                if (!isAdmin && !isAssetController) {
                    return res.status(403).json({ message: 'Access denied. Only Asset Controller or Admin can mark an unassigned asset as Live.' });
                }
            } else if (!isAdmin && !isAssetController && !isAssignedUser) {
                return res.status(403).json({ message: 'Access denied. Only Asset Controller, Admin, or the assigned user can mark this asset as Live.' });
            }
        } else if (!isAdmin && !isAssetController) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller or Admin can perform this action.' });
        }

        if (!isServiceActive(item)) {
            return res.status(400).json({ message: 'Asset is not on service (onServiceActive is false).' });
        }

        const snapshotItem = await AssetItem.findById(item._id)
            .populate('categoryId typeId assignedTo assignedBy acceptedBy');
        const statusSnapshot = snapshotItem.toObject();
        const prevAssignedTo = item.assignedTo?._id || item.assignedTo;

        const currentService = item.services?.length ? item.services[item.services.length - 1] : null;
        if (!currentService) {
            return res.status(400).json({ message: 'No active service record found for this asset.' });
        }

        if (action === 'Extend') {
            const ext = parseInt(extensionDays, 10);
            if (!Number.isInteger(ext) || ext <= 0 || ext > 30) {
                return res.status(400).json({ message: 'Invalid extension days. Must be between 1 and 30.' });
            }
            const reason = String(extensionReason || '').trim();
            if (!reason) {
                return res.status(400).json({ message: 'Extension reason is required.' });
            }

            const baseExpiry = currentService.expiryDate ? new Date(currentService.expiryDate) : new Date();
            const newExpiry = new Date(baseExpiry);
            newExpiry.setDate(newExpiry.getDate() + ext);

            const previousDurationDays =
                parseServiceDurationDays(currentService.serviceDuration) ||
                Math.max(1, Math.ceil((baseExpiry.getTime() - new Date(currentService.date || new Date()).getTime()) / (1000 * 60 * 60 * 24)));
            const updatedTotalDays = previousDurationDays + ext;
            if (updatedTotalDays > MAX_ASSET_SERVICE_DAYS) {
                return res.status(400).json({
                    message: `Maximum total service duration is ${MAX_ASSET_SERVICE_DAYS} days (including extensions). Current: ${previousDurationDays} day(s).`,
                });
            }

            currentService.expiryDate = newExpiry;
            currentService.serviceDuration = `${updatedTotalDays} days`;
            currentService.reminderSentAt = null;
            currentService.durationCompleteSentAt = null;
            currentService.lastWarningSentAt = null;
            currentService.expiryDayEmailSentAt = null;
            currentService.serviceOverdueTaskAt = null;

            await completeAssetServiceOverdueTasks(item._id, req.user?.employeeObjectId);

            await AssetHistory.create({
                assetId: item._id,
                action: 'Extend',
                assignedTo: prevAssignedTo,
                performedBy: req.user.employeeObjectId,
                comments: `Service extended by ${ext} day(s). Total duration: ${updatedTotalDays} day(s). Expiry: ${newExpiry.toLocaleDateString('en-GB')}. Reason: ${reason}`,
                date: new Date(),
                details: buildServiceExtendHistoryDetails({
                    currentService,
                    extensionDays: ext,
                    extensionReason: reason,
                    previousExpiryDate: baseExpiry,
                    newExpiryDate: newExpiry,
                    previousDurationDays,
                    updatedTotalDays,
                    prevAssetStatus: item.status,
                }),
            });

            try {
                const initiator = await EmployeeBasic.findById(req.user.employeeObjectId)
                    .select('firstName lastName employeeId companyEmail workEmail primaryReportee')
                    .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail')
                    .lean();
                await notifyAssetServiceStakeholderEmails({
                    asset: item,
                    type: 'Extended',
                    details: {
                        serviceDuration: `${updatedTotalDays} days`,
                        extensionDays: ext,
                        currentExpiryDate: baseExpiry,
                        newExpiryDate: newExpiry,
                        extensionReason: reason,
                    },
                    initiator,
                    initiatorIsAssetController: isAssetController,
                });
            } catch (emailErr) {
            }
        } else if (action === 'Return' || action === 'Live') {
            if (action === 'Live') {
                applyOnDutyFromServiceState(item, currentService);
                await completeAssetServiceOverdueTasks(item._id, req.user?.employeeObjectId);
            } else {
                applyPostServiceOperationalState(item, currentService);
                if (currentService.durationCompleteSentAt == null) {
                    currentService.durationCompleteSentAt = new Date();
                }
            }

            const receiveDetails = buildServiceReceiveHistoryDetails({
                action: action === 'Live' ? 'live' : 'return',
                currentService,
                prevStatus: statusSnapshot?.status || item.status,
                nextStatus: item.status,
            });
            await AssetHistory.create({
                assetId: item._id,
                action: 'Service Receive',
                assignedTo: prevAssignedTo,
                performedBy: req.user.employeeObjectId,
                comments: action === 'Live'
                    ? `Marked Live on ${new Date().toLocaleDateString('en-GB')}. On service cleared; on leave unchanged. Service started ${currentService.date ? new Date(currentService.date).toLocaleDateString('en-GB') : '—'}; planned return ${currentService.expiryDate ? new Date(currentService.expiryDate).toLocaleDateString('en-GB') : '—'}.`
                    : 'Returned from service. On service cleared; on leave unchanged.',
                date: new Date(),
                details: receiveDetails,
            });
        }

        await item.save();

        if (action === 'Live') {
            try {
                const initiator = await EmployeeBasic.findById(req.user.employeeObjectId)
                    .select('firstName lastName employeeId companyEmail workEmail primaryReportee')
                    .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail')
                    .lean();
                await notifyAssetServiceStakeholderEmails({
                    asset: item,
                    type: 'Done',
                    details: {
                        serviceDuration: currentService?.serviceDuration || null,
                        description: 'Service Completed',
                    },
                    initiator,
                    initiatorIsAssetController: isAssetController,
                });
            } catch (emailErr) {
            }
        }

        await notifyAssignedEmployeeIfController(req, item, 'Edit Asset', 'Asset service status updated by Asset Controller.');
        await updateAssetTypeCounts(item.typeId);

        res.status(200).json({
            message:
                action === 'Extend'
                    ? 'Service duration extended successfully'
                    : action === 'Live'
                        ? 'Asset marked as Live successfully'
                        : 'Asset returned from service successfully',
            asset: item
        });
    } catch (error) {
        res.status(500).json({
            message: 'Server Error',
            error: error.message
        });
    }
};

/**
 * @desc    Bulk Handle On Service asset action (Return or Extend)
 * @route   PUT /api/AssetItem/bulk/on-service-action
 * @access  Private
 */
export const bulkHandleOnServiceAction = async (req, res) => {
    try {
        const { assetIds, action, extensionDays, extensionReason } = req.body;
        if (!Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ message: 'Please provide at least one asset ID' });
        }
        if (!['Return', 'Extend', 'Live'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action. Must be "Return", "Live", or "Extend"' });
        }

        const isAdmin = isJwtSystemSuperUser(req.user);
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');
        if (!isAdmin && !isAssetController) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller or Admin can perform this action.' });
        }

        const ext = action === 'Extend' ? parseInt(extensionDays, 10) : null;
        if (action === 'Extend' && (!Number.isInteger(ext) || ext <= 0 || ext > 30)) {
            return res.status(400).json({ message: 'Invalid extension days. Must be between 1 and 30.' });
        }
        const reason = action === 'Extend' ? String(extensionReason || '').trim() : '';
        if (action === 'Extend' && !reason) {
            return res.status(400).json({ message: 'Extension reason is required.' });
        }

        const items = await AssetItem.find({ _id: { $in: assetIds } }).populate('assignedTo');
        const results = { success: [], failed: [] };

        for (const item of items) {
            try {
                if (!isServiceActive(item)) {
                    results.failed.push({ id: item._id, message: `Asset is not on service (Current: onServiceActive=${!!item.onServiceActive}, status=${item.status})` });
                    continue;
                }

                const currentService = item.services?.length ? item.services[item.services.length - 1] : null;
                if (!currentService) {
                    results.failed.push({ id: item._id, message: 'No active service record found.' });
                    continue;
                }

                if (action === 'Extend') {
                    const baseExpiry = currentService.expiryDate ? new Date(currentService.expiryDate) : new Date();
                    const newExpiry = new Date(baseExpiry);
                    newExpiry.setDate(newExpiry.getDate() + ext);
                    const prevDays = parseServiceDurationDays(currentService.serviceDuration) || 0;
                    currentService.expiryDate = newExpiry;
                    currentService.serviceDuration = `${Math.max(1, prevDays) + ext} days`;
                    currentService.reminderSentAt = null;
                    currentService.durationCompleteSentAt = null;
                    currentService.lastWarningSentAt = null;
                    currentService.expiryDayEmailSentAt = null;
                    currentService.serviceOverdueTaskAt = null;
                    await completeAssetServiceOverdueTasks(item._id, req.user?.employeeObjectId);
                    const updatedTotalDays = Math.max(1, prevDays) + ext;
                    await AssetHistory.create({
                        assetId: item._id,
                        action: 'Extend',
                        assignedTo: item.assignedTo?._id || item.assignedTo,
                        performedBy: req.user.employeeObjectId,
                        comments: `Bulk extend: +${ext} day(s). Total ${updatedTotalDays} day(s). New expiry ${newExpiry.toLocaleDateString('en-GB')}. Reason: ${reason}`,
                        date: new Date(),
                        details: buildServiceExtendHistoryDetails({
                            currentService,
                            extensionDays: ext,
                            extensionReason: reason,
                            previousExpiryDate: baseExpiry,
                            newExpiryDate: newExpiry,
                            previousDurationDays: prevDays,
                            updatedTotalDays,
                            prevAssetStatus: item.status,
                            isBulk: true,
                        }),
                    });

                    try {
                        const initiator = await EmployeeBasic.findById(req.user.employeeObjectId)
                            .select('firstName lastName employeeId companyEmail workEmail primaryReportee')
                            .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail')
                            .lean();
                        await notifyAssetServiceStakeholderEmails({
                            asset: item,
                            type: 'Extended',
                            details: {
                                serviceDuration: currentService.serviceDuration,
                                extensionDays: ext,
                                currentExpiryDate: baseExpiry,
                                newExpiryDate: newExpiry,
                                extensionReason: reason,
                            },
                            initiator,
                            initiatorIsAssetController: isAssetController,
                        });
                    } catch (emailErr) {
                    }
                } else if (action === 'Return' || action === 'Live') {
                    const prevServiceStatus = item.status;
                    if (action === 'Live') {
                        applyOnDutyFromServiceState(item, currentService);
                        await completeAssetServiceOverdueTasks(item._id, req.user?.employeeObjectId);
                    } else {
                        const nextStatus = applyPostServiceOperationalState(item, currentService);
                        item.status = nextStatus;
                        if (currentService.durationCompleteSentAt == null) {
                            currentService.durationCompleteSentAt = new Date();
                        }
                    }
                    await AssetHistory.create({
                        assetId: item._id,
                        action: 'Service Receive',
                        assignedTo: item.assignedTo?._id || item.assignedTo,
                        performedBy: req.user.employeeObjectId,
                        comments: action === 'Live'
                            ? `Bulk Mark Live (${new Date().toLocaleDateString('en-GB')}) — on service cleared; on leave unchanged.`
                            : 'Bulk return from service — on service cleared; on leave unchanged.',
                        date: new Date(),
                        details: buildServiceReceiveHistoryDetails({
                            action: action === 'Live' ? 'live' : 'return',
                            currentService,
                            prevStatus: prevServiceStatus,
                            nextStatus: item.status,
                            isBulk: true,
                        }),
                    });
                }

                await item.save();
                await updateAssetTypeCounts(item.typeId);
                results.success.push(item._id);
            } catch (err) {
                results.failed.push({ id: item._id, message: err.message });
            }
        }

        res.status(200).json({
            message: `Processed ${items.length} assets: ${results.success.length} successful, ${results.failed.length} failed.`,
            results
        });
    } catch (error) {
        res.status(500).json({ message: 'Internal server error', error: error.message });
    }
};

/**
 * @desc    Handle On Leave asset action (Return or On Duty)
 * @route   PUT /api/AssetItem/:id/on-leave-action
 * @access  Private
 */
export const handleOnLeaveAction = async (req, res) => {
    try {
        const { id } = req.params;
        const { action, extensionReason } = req.body; // 'Return' or 'OnDuty'

        if (!['Return', 'OnDuty', 'Extend'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action. Must be "Return", "OnDuty", or "Extend"' });
        }

        // Check authorization - only Asset Controllers can perform this action
        const assetController = await getDepartmentHOD('assetcontroller');
        const isAdmin = isJwtSystemSuperUser(req.user);
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        if (!isAdmin && !isAssetController) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller or Admin can perform this action.' });
        }

        const item = await AssetItem.findById(id).populate('assignedTo');
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        if (!isLeaveActive(item)) {
            return res.status(400).json({ message: 'Asset is not on leave (onLeaveActive is false).' });
        }

        // Capture snapshot before mutation
        const snapshotItem = await AssetItem.findById(item._id)
            .populate('categoryId typeId assignedTo assignedBy acceptedBy');
        const statusSnapshot = snapshotItem.toObject();

        const prevAssignedTo = item.assignedTo?._id || item.assignedTo;

        if (action === 'Return') {
            clearParkingFlags(item);
            item.status = 'Unassigned';
            item.assignedTo = null;
            item.assignedBy = null;
            item.assignmentType = null;
            item.assignedDays = null;
            item.acceptanceStatus = null;
            item.actionRequiredBy = null;
            item.negotiationHistory = [];
            item.onLeaveStartDate = null;
            item.onLeaveEndDate = null;
            item.onLeaveDuration = null;
            item.parkingExtendedDays = 0;
            item.parkingReminderSentAt = null;
            item.parkingDurationCompleteSentAt = null;

            // Log History (parking fields cleared via clearParkingFlags above; explicit nulls for assignee clear)
            await AssetHistory.create({
                assetId: item._id,
                action: 'Returned',
                assignedTo: prevAssignedTo,
                performedBy: req.user.employeeObjectId,
                comments: `Asset returned from On Leave status by Asset Controller`,
                date: new Date(),
                details: statusSnapshot
            });
        } else if (action === 'OnDuty') {
            if (requiresOwnerOnDutyApproval(item)) {
                return res.status(400).json({
                    message:
                        'This asset is assigned to an employee. Owner confirmation is required before On Duty. Use the Parking On Duty action.',
                    requiresOwnerApproval: true,
                });
            }
            const dutyResult = applyOnDutyFromLeaveState(item);
            if (!dutyResult.ok) {
                return res.status(400).json({ message: 'Cannot set to On Duty for this asset.' });
            }

            await AssetHistory.create({
                assetId: item._id,
                action: 'Assigned',
                assignedTo: prevAssignedTo,
                performedBy: req.user.employeeObjectId,
                comments: `Asset returned from leave and set On Duty by Asset Controller${dutyResult.originalDuration ? `. Duration tracking started: ${dutyResult.originalDuration} day(s)` : ''}. On service status unchanged.`,
                date: new Date(),
                details: {
                    previousStatus: statusSnapshot.status,
                    duration: dutyResult.originalDuration,
                    onDutyStartDate: item.onLeaveStartDate,
                    onDutyEndDate: item.onLeaveEndDate,
                    onDutyPath: 'leave',
                },
            });
        } else if (action === 'Extend') {
            const extensionDays = parseInt(req.body.extensionDays);
            if (!Number.isInteger(extensionDays) || extensionDays <= 0) {
                return res.status(400).json({ message: 'Invalid extension days. Must be a positive number.' });
            }
            const usedExtensionDays = Number(item.parkingExtendedDays || 0);
            const projectedTotal = (item.onLeaveDuration || 0) + extensionDays;
            if (projectedTotal > MAX_ASSET_LEAVE_DAYS) {
                return res.status(400).json({
                    message: `Maximum total leave duration is ${MAX_ASSET_LEAVE_DAYS} days (including extensions). Current: ${item.onLeaveDuration || 0} day(s).`,
                });
            }
            const reason = String(extensionReason || '').trim();
            if (!reason) {
                return res.status(400).json({ message: 'Extension reason is required.' });
            }

            // Calculate new end date based on current end date (or today if missing)
            const currentEndDate = item.onLeaveEndDate || new Date();
            const newEndDate = new Date(currentEndDate);
            newEndDate.setDate(newEndDate.getDate() + extensionDays);

            item.onLeaveEndDate = newEndDate;
            item.onLeaveDuration = (item.onLeaveDuration || 0) + extensionDays;
            item.parkingExtendedDays = usedExtensionDays + extensionDays;
            item.parkingReminderSentAt = null;
            item.parkingDurationCompleteSentAt = null;

            // Log History
            await AssetHistory.create({
                assetId: item._id,
                action: 'Extend',
                assignedTo: prevAssignedTo,
                performedBy: req.user.employeeObjectId,
                comments: `Asset parking duration extended by ${extensionDays} day(s) by Asset Controller. New end date: ${newEndDate.toLocaleDateString()}. Reason: ${reason}`,
                date: new Date(),
                details: { ...statusSnapshot, extensionDays, extensionReason: reason, newEndDate }
            });

            const assignedEmployee = await EmployeeBasic.findById(prevAssignedTo)
                .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
                .lean()
                .catch(() => null);
            const hodEmployee = assignedEmployee?.primaryReportee || null;
            await sendParkingExtensionEmail({
                asset: item,
                assignedEmployee,
                hodEmployee,
                assetController,
                previousExpiryDate: currentEndDate,
                extensionDays,
                reason
            });
        }

        await item.save();

        if (['Return', 'OnDuty', 'Extend'].includes(action)) {
            await completeOperationalExpiryDashboardTasks(item._id, ['leave']);
        }

        if (['Return', 'OnDuty'].includes(action) && prevAssignedTo) {
            await refreshStaleOwnerOnDutyDashboardForOwner(prevAssignedTo).catch(() => null);
        }

        await notifyAssignedEmployeeIfController(req, item, 'Edit Asset', 'Asset details were edited by Asset Controller.');
        await updateAssetTypeCounts(item.typeId);

        res.status(200).json({
            message: action === 'Return'
                ? 'Asset returned successfully'
                : action === 'Extend'
                    ? 'Asset parking duration extended successfully'
                    : 'Asset set to On Duty successfully',
            asset: item
        });
    } catch (error) {
        res.status(500).json({
            message: 'Server Error',
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

/**
 * @desc    Bulk Handle On Leave asset action (Return or On Duty)
 * @route   PUT /api/AssetItem/bulk/on-leave-action
 * @access  Private
 */
export const bulkHandleOnLeaveAction = async (req, res) => {
    try {
        const { assetIds, action, extensionReason } = req.body;

        if (!Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ message: 'Please provide at least one asset ID' });
        }

        if (!['Return', 'OnDuty', 'Extend'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action. Must be "Return", "OnDuty", or "Extend"' });
        }
        const reason = action === 'Extend' ? String(extensionReason || '').trim() : '';
        if (action === 'Extend' && !reason) {
            return res.status(400).json({ message: 'Extension reason is required.' });
        }

        const isAdmin = isJwtSystemSuperUser(req.user);
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        if (!isAdmin && !isAssetController) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller or Admin can perform this action.' });
        }

        const items = await AssetItem.find({ _id: { $in: assetIds } }).populate('assignedTo');
        const results = { success: [], failed: [] };
        const ownersToRefreshOnDuty = new Set();

        for (const item of items) {
            try {
                if (!isLeaveActive(item)) {
                    results.failed.push({ id: item._id, message: `Asset is not on leave (onLeaveActive=false, status=${item.status})` });
                    continue;
                }

                const prevAssignedTo = item.assignedTo?._id || item.assignedTo;

                if (action === 'Return') {
                    clearParkingFlags(item);
                    item.status = 'Unassigned';
                    item.assignedTo = null;
                    item.assignedBy = null;
                    item.assignmentType = null;
                    item.assignedDays = null;
                    item.acceptanceStatus = null;
                    item.actionRequiredBy = null;
                    item.negotiationHistory = [];
                    item.onLeaveStartDate = null;
                    item.onLeaveEndDate = null;
                    item.onLeaveDuration = null;
                    item.parkingExtendedDays = 0;
                    item.parkingReminderSentAt = null;
                    item.parkingDurationCompleteSentAt = null;

                    await item.save();

                    await AssetHistory.create({
                        assetId: item._id,
                        action: 'Returned',
                        assignedTo: prevAssignedTo,
                        performedBy: req.user.employeeObjectId,
                        comments: `Asset returned from On Leave status by Asset Controller (Bulk)`,
                        date: new Date()
                    });
                    results.success.push(item._id);
                    if (prevAssignedTo) ownersToRefreshOnDuty.add(String(prevAssignedTo));
                } else if (action === 'OnDuty') {
                    if (requiresOwnerOnDutyApproval(item)) {
                        results.failed.push({
                            id: item._id,
                            message: 'Assigned employee assets require owner confirmation before On Duty.',
                        });
                        continue;
                    }
                    const dutyResult = applyOnDutyFromLeaveState(item);
                    if (!dutyResult.ok) {
                        results.failed.push({ id: item._id, message: 'Cannot set to On Duty for this asset.' });
                        continue;
                    }

                    await item.save();

                    await AssetHistory.create({
                        assetId: item._id,
                        action: 'Assigned',
                        assignedTo: prevAssignedTo,
                        performedBy: req.user.employeeObjectId,
                        comments: `Asset returned from leave and set On Duty by Asset Controller (Bulk)${dutyResult.originalDuration ? `. Duration tracking started: ${dutyResult.originalDuration} day(s)` : ''}. On service status unchanged.`,
                        date: new Date(),
                    });
                    results.success.push(item._id);
                    if (prevAssignedTo) ownersToRefreshOnDuty.add(String(prevAssignedTo));
                } else if (action === 'Extend') {
                    const extensionDays = parseInt(req.body.extensionDays, 10);
                    if (!Number.isInteger(extensionDays) || extensionDays <= 0 || extensionDays > 10) {
                        results.failed.push({ id: item._id, message: 'Invalid extension days (1-10 required).' });
                        continue;
                    }
                    const usedExtensionDays = Number(item.parkingExtendedDays || 0);
                    if (usedExtensionDays + extensionDays > 10) {
                        results.failed.push({ id: item._id, message: `Maximum total extension is 10 days. Already used ${usedExtensionDays} day(s).` });
                        continue;
                    }
                    const currentEndDate = item.onLeaveEndDate || new Date();
                    const newEndDate = new Date(currentEndDate);
                    newEndDate.setDate(newEndDate.getDate() + extensionDays);
                    item.onLeaveEndDate = newEndDate;
                    item.onLeaveDuration = (item.onLeaveDuration || 0) + extensionDays;
                    item.parkingExtendedDays = usedExtensionDays + extensionDays;
                    item.parkingReminderSentAt = null;
                    item.parkingDurationCompleteSentAt = null;
                    await item.save();
                    await AssetHistory.create({
                        assetId: item._id,
                        action: 'Extend',
                        assignedTo: prevAssignedTo,
                        performedBy: req.user.employeeObjectId,
                        comments: `Asset parking duration extended by ${extensionDays} day(s) by Asset Controller (Bulk). Reason: ${reason}`,
                        date: new Date()
                    });

                    const assignedEmployee = prevAssignedTo
                        ? await EmployeeBasic.findById(prevAssignedTo)
                            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                            .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
                            .lean()
                            .catch(() => null)
                        : null;
                    const hodEmployee = assignedEmployee?.primaryReportee || null;
                    const assetController = await getDepartmentHOD('assetcontroller');
                    await sendParkingExtensionEmail({
                        asset: item,
                        assignedEmployee,
                        hodEmployee,
                        assetController,
                        previousExpiryDate: currentEndDate,
                        extensionDays,
                        reason
                    });
                    results.success.push(item._id);
                }
            } catch (err) {
                results.failed.push({ id: item._id, message: err.message });
            }
        }

        if (['Return', 'OnDuty'].includes(action)) {
            for (const ownerId of ownersToRefreshOnDuty) {
                await refreshStaleOwnerOnDutyDashboardForOwner(ownerId).catch(() => null);
            }
        }

        res.status(200).json({
            message: `Processed ${items.length} assets: ${results.success.length} successful, ${results.failed.length} failed.`,
            results
        });
    } catch (error) {
        res.status(500).json({
            message: 'Internal server error',
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

/**
 * @desc    Whether company allocation is allowed (flowchart Assigned User or Admin must exist)
 * @route   GET /api/AssetItem/company-allocation/coordinator
 * @access  Private
 */
export const getCompanyAllocationCoordinatorStatus = async (req, res) => {
    try {
        const coordRaw = await getCompanyAssetCoordinator();
        const coordinator = coordRaw ? await resolveAssetControllerEmployee(coordRaw) : null;
        if (!coordinator?._id) {
            return res.status(200).json({
                canAllocateToCompany: false,
                message:
                    'No Assigned User or Admin in Flowchart. Configure one in Settings → Flowchart before allocating assets to a company.',
            });
        }
        const name = `${coordinator.firstName || ''} ${coordinator.lastName || ''}`.trim() || coordinator.employeeId || 'Coordinator';
        return res.status(200).json({
            canAllocateToCompany: true,
            coordinator: {
                _id: coordinator._id,
                employeeId: coordinator.employeeId,
                name,
            },
        });
    } catch (error) {
        return res.status(500).json({ message: 'Server Error' });
    }
};

/**
 * @desc    Get assets assigned to company for HR profile view
 * @route   GET /api/AssetItem/company-assets/hr/:employeeId
 * @access  Private
 */
export const getHRCompanyAssets = async (req, res) => {
    try {
        const { employeeId } = req.params;
        const employee = await EmployeeBasic.findOne({
            employeeId: { $regex: new RegExp(`^${employeeId}$`, 'i') }
        }).select('_id employeeId company');

        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const employeeObjectId = employee._id;

        // Company Assets tab must follow CURRENT flowchart responsibility only
        // (Assigned User/Admin Controller active entries), not legacy company.responsibilities.
        const isCompanyCoordinatorFlow = await isUserActiveCompanyAssetCoordinator(employeeObjectId, employeeId);
        const isHRFlow = await isUserActiveInFlowchart({ employeeObjectId, employeeId }, 'hr');

        if (!isCompanyCoordinatorFlow && !isHRFlow) {
            return res.status(200).json({ isHR: false, items: [], designatedCompanies: [] });
        }


        // Accepted company allocations only — pending items appear on asset detail / dashboard for coordinator accept.
        const query = {
            $and: [
                {
                    assignedToType: 'Company',
                    acceptanceStatus: 'Accepted',
                },
                buildDraftVisibilityQuery(req.user),
            ],
        };

        const items = await AssetItem.find(query)
            .populate('assignedCompany', 'name companyId nickName')
            .populate('typeId', 'name type')
            .populate('categoryId', 'name category')
            .populate({
                path: 'actionRequiredBy',
                model: 'EmployeeBasic',
                select: '_id employeeId firstName lastName'
            })
            .select('assetId name assetValue status purchaseDate assignedToType assignedCompany actionRequiredBy acceptanceStatus')
            .sort({ updatedAt: -1 });


        res.status(200).json({
            isHR: true,
            items,
            designatedCompanies: []
        });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Create a new asset item
// @route   POST /api/AssetItem
// @access  Private
export const createAssetItem = async (req, res) => {
    try {
        let { assetTypeId, name, photo, status, categoryId, assetValue, purchaseDate, warrantyYears, lastServiceDate, accessories, creationIntent } = req.body;

        if (!assetTypeId || !name) {
            return res.status(400).json({ message: 'Asset Type and Name are required' });
        }

        // Approval Logic: Check if creator is Asset Controller or Admin
        const assetControllerRaw = await getDepartmentHOD('assetcontroller');
        const assetController = assetControllerRaw ? await resolveAssetControllerEmployee(assetControllerRaw) : null;

        const creationResolved = await resolveNewAssetCreationStatus(req, {
            creationIntent,
            assetController
        });
        if (creationResolved.error) {
            return res.status(creationResolved.status || 400).json({ message: creationResolved.error });
        }
        const { initialStatus, actionRequiredBy } = creationResolved;

        const requesterDisplayName = await getAssetRequesterDisplayName(req);

        // Handle Photo Upload
        let photoS3Key = photo;
        if (photo && photo.startsWith('data:image')) {
            try {
                const uploadResult = await uploadDocumentToS3(photo, 'asset-photos');
                photoS3Key = uploadResult.publicId;
            } catch (error) {
            }
        }

        // Fetch the starting numeric part for IDs
        const prefix = 'VEGA-ASSET-';
        const regex = new RegExp(`^${prefix}\\d+$`);
        const lastItem = await AssetItem.findOne({
            assetId: { $regex: regex }
        }).sort({ assetId: -1 });

        let startingNum = 1;
        if (lastItem && lastItem.assetId) {
            const numStr = lastItem.assetId.substring(prefix.length);
            const numericPart = parseInt(numStr, 10);
            if (!isNaN(numericPart)) startingNum = numericPart + 1;
        }

        const newItemId = `${prefix}${String(startingNum).padStart(3, '0')}`;

        // Helper to generate accessory suffix (A, B, C...)
        const generateAccessoryId = (assetId, index) => {
            const charCode = 65 + (index % 26);
            const suffixNum = Math.floor(index / 26) > 0 ? String(Math.floor(index / 26)) : '';
            return `${assetId}${String.fromCharCode(charCode)}${suffixNum}`;
        };

        const formattedAccessories = (accessories || []).map((acc, accIdx) => ({
            ...acc,
            amount: acc?.amount != null && acc.amount !== '' ? Number(acc.amount) : 0,
            description: acc?.description ? String(acc.description).trim() : '',
            accessoryId: generateAccessoryId(newItemId, accIdx)
        }));

        const newItem = await AssetItem.create({
            typeId: assetTypeId,
            categoryId: categoryId || null,
            assetId: newItemId,
            name,
            photo: photoS3Key,
            imagePreview: photoS3Key,
            assetValue: assetValue || 0,
            purchaseDate: purchaseDate || null,
            warrantyYears: warrantyYears || 0,
            status: initialStatus,
            lastServiceDate: lastServiceDate || null,
            accessories: formattedAccessories,
            actionRequiredBy: actionRequiredBy,
            createdBy: req.user._id
        });

        try {
            await syncAllAccessoryInstancesForAsset(newItem);
        } catch (syncErr) {
        }

        // Record Initial History (append-only; full sentence for the activity timeline)
        try {
            const whenStr = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
            const userStory = `${requesterDisplayName} added this asset on ${whenStr}. It was saved with status: ${initialStatus}.`;
            await AssetHistory.create({
                assetId: newItem._id,
                action: 'Created',
                performedBy: req.user.employeeObjectId,
                comments: userStory,
                details: { userStory, status: initialStatus, assetCode: newItemId }
            });
        } catch (histErr) {
        }

        // Create Dashboard Action for Asset Controller when a submission requires approval (save-only Draft has no actionRequiredBy)
        if (actionRequiredBy) {
            try {
                await DashboardAction.findOneAndUpdate(
                    { requestId: newItem._id, requestType: 'Asset Approval', status: 'Pending' },
                    {
                        assignedTo: actionRequiredBy,
                        assignedToEmpId: assetController.employeeId,
                        requestId: newItem._id,
                        requestType: 'Asset Approval',
                        subjectEmployeeId: req.user.employeeId,
                        subjectName: requesterDisplayName,
                        requestedByName: requesterDisplayName,
                        extra1: `${newItem.assetId} — ${newItem.name}`,
                        extra2: `Asset creation — requested by ${requesterDisplayName}`,
                        status: 'Pending'
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );
            } catch (err) {
            }
        }

        // Update counts on AssetType
        await updateAssetTypeCounts(assetTypeId);

        // Send email to Asset Controller when a submission requires approval (not save-only Draft)
        if (actionRequiredBy && assetController) {
            let creationAttachments = [];
            try {
                const requester = req.user.employeeObjectId
                    ? await EmployeeBasic.findById(req.user.employeeObjectId)
                        .select('firstName lastName signature employeeId department')
                        .lean()
                    : null;
                creationAttachments = await buildCreationRequestHandoverAttachments(
                    req,
                    [newItem._id.toString()],
                    { assigner: requester, assignerName: requesterDisplayName },
                );
            } catch (pdfErr) {
            }
            await sendAssetCreationApprovalEmail({
                asset: newItem,
                recipient: assetController,
                creatorName: requesterDisplayName,
                attachments: creationAttachments
            });
        }

        const isJwtAdmin = isJwtSystemSuperUser(req.user);
        const isSysAdmin = await isUserAdministrator(req.user?.id);
        if (initialStatus === 'Unassigned' && (isJwtAdmin || isSysAdmin) && assetController?._id) {
            try {
                await sendAssetCreatedByAdminInfoEmail({
                    asset: newItem,
                    recipient: assetController,
                    creatorName: requesterDisplayName,
                });
            } catch (adminInfoErr) {
            }
        }

        res.status(201).json(newItem);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

async function runPostAssetCreationApprovalWork(req, work) {
    const item = await AssetItem.findById(work.itemId);
    if (!item) return;

    await notifyAssignedEmployeeIfController(
        req,
        item,
        work.isReassignment ? 'Reassign Asset' : 'Assign Asset',
        work.isReassignment
            ? 'Asset was reassigned by Asset Controller.'
            : 'Asset assignment was updated by Asset Controller.'
    );

    try {
        const snapshotItem = await AssetItem.findById(item._id).populate('categoryId typeId createdBy');
        const appr = work.performedBy
            ? await EmployeeBasic.findById(work.performedBy).select('firstName lastName').lean()
            : null;
        const apprName = appr ? `${appr.firstName || ''} ${appr.lastName || ''}`.trim() : 'The approver';
        const whenStr = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        const userStory =
            work.actionNorm === 'Approve'
                ? `${apprName} approved this asset on ${whenStr}. It is ready to assign.`
                : `${apprName} did not approve this asset on ${whenStr}. It was returned to Draft so the creator can edit and resubmit.`;

        await AssetHistory.create({
            assetId: item._id,
            action: work.actionNorm === 'Approve' ? 'Accepted' : 'Rejected',
            performedBy: work.performedBy,
            comments: userStory,
            details: {
                ...snapshotItem.toObject(),
                approvalAction: work.actionNorm,
                userStory,
            },
        });
    } catch (histErr) {
    }

    if (work.actionNorm === 'Reject' && work.createdBy) {
        await notifyAssetCreationRejectedToCreator({
            asset: item,
            createdByUserId: work.createdBy,
            reviewerDisplayName: work.reviewerDisplayName,
            actionedBy: work.performedBy || work.userId,
            rejectReason: work.rejectReason,
            approverRole: work.approverRole,
        });
    }

    if (work.actionNorm === 'Approve' && work.createdBy) {
        try {
            const creatorEmp = await resolveAssetCreatorEmployee(work.createdBy);
            if (creatorEmp) {
                await sendAssetCreationDecisionEmail({
                    asset: item,
                    recipient: creatorEmp,
                    approverRole: work.approverRole,
                    creatorName: work.reviewerDisplayName,
                });
            }
        } catch (emailErr) {
        }
    }
}

// @desc    Respond to asset creation approval (Approve/Reject)
// @route   PUT /api/AssetItem/:id/approve-creation
// @access  Private (Asset Controller or Admin)
export const respondToAssetCreation = async (req, res) => {
    try {
        const { id } = req.params;
        const rawAction = req.body?.action;
        const action = String(rawAction || '').trim();
        const actionNorm = action.charAt(0).toUpperCase() + action.slice(1).toLowerCase();

        if (!['Approve', 'Reject'].includes(actionNorm)) {
            return res.status(400).json({ message: 'Invalid action. Use Approve or Reject.' });
        }

        const item = await AssetItem.findById(id);
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const awaitingCreation =
            item.status === 'Submitted for Approval' ||
            item.status === 'Pending' ||
            (item.status === 'Draft' && item.actionRequiredBy);

        if (!awaitingCreation) {
            return res.status(400).json({ message: 'Asset is not awaiting creation approval.' });
        }

        const isJwtAdmin = isJwtSystemSuperUser(req.user);
        const isSysAdmin = await isUserAdministrator(req.user?.id);

        const normEmp = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
        let isDesignatedApprover = false;
        if (item.actionRequiredBy) {
            const aid = item.actionRequiredBy.toString();
            if (req.user?.employeeObjectId && aid === req.user.employeeObjectId.toString()) {
                isDesignatedApprover = true;
            } else if (req.user?.employeeId) {
                const appr = await EmployeeBasic.findById(item.actionRequiredBy).select('employeeId').lean();
                if (appr?.employeeId && normEmp(appr.employeeId) === normEmp(req.user.employeeId)) {
                    isDesignatedApprover = true;
                }
            }
        }

        let isDeptAssetControllerFallback = false;
        if (!item.actionRequiredBy && item.status === 'Draft') {
            const assetController = await getDepartmentHOD('assetcontroller');
            if (assetController?._id && req.user?.employeeObjectId) {
                if (assetController._id.toString() === req.user.employeeObjectId.toString()) {
                    isDeptAssetControllerFallback = true;
                }
            }
            if (
                !isDeptAssetControllerFallback &&
                assetController?.employeeId &&
                req.user?.employeeId
            ) {
                if (normEmp(assetController.employeeId) === normEmp(req.user.employeeId)) {
                    isDeptAssetControllerFallback = true;
                }
            }
        }

        const creatorId = item.createdBy?.toString?.() || null;
        const isCreator =
            creatorId &&
            (creatorId === req.user?._id?.toString() || creatorId === req.user?.id?.toString());

        // Designated approver, department asset controller (draft with no actionRequiredBy), or admin — not the submitter
        if (
            !isJwtAdmin &&
            !isSysAdmin &&
            !isDesignatedApprover &&
            !isDeptAssetControllerFallback
        ) {
            return res.status(403).json({ message: 'Only the designated approver or an administrator can approve this asset.' });
        }
        if (isCreator && !isDesignatedApprover && !isJwtAdmin && !isSysAdmin) {
            return res.status(403).json({ message: 'You cannot approve or reject an asset you submitted for approval.' });
        }

        const fleetVehicle = isFleetVehicleAssetFields({ plateNumber: item.plateNumber });
        const reviewerDisplayName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            (fleetVehicle ? 'HR' : 'Asset Controller');
        const approverRole = isJwtAdmin || isSysAdmin ? 'admin' : fleetVehicle ? 'hr' : 'assetcontroller';

        if (actionNorm === 'Approve') {
            item.status = 'Unassigned';
            item.actionRequiredBy = null;
            item.creationReturnedToDraftAt = null;
            if (isFleetVehicleAssetFields({ plateNumber: item.plateNumber, typeName: item.typeId?.name })) {
                item.vehicleProfileActivationStatus = 'inactive';
            }
        } else {
            item.status = 'Draft';
            item.actionRequiredBy = null;
            item.pendingAction = null;
            item.pendingActionDetails = null;
            item.creationReturnedToDraftAt = new Date();
        }

        // This endpoint is "asset creation approval" (draft/pending). However, the asset
        // record may already carry assignment intent (reassign vs initial assign). We use
        // presence of assigned targets to decide notification wording.
        const isReassignment = !!(item.assignedTo || item.assignedCompany);

        await item.save();

        try {
            await DashboardAction.findOneAndUpdate(
                { requestId: item._id, requestType: 'Asset Approval', status: 'Pending' },
                {
                    status: actionNorm === 'Approve' ? 'Approved' : 'Rejected',
                    actionedDate: new Date(),
                    actionedBy: req.user?.employeeObjectId || req.user?._id,
                    comment:
                        actionNorm === 'Reject'
                            ? String(req.body?.reason || req.body?.comment || '').trim()
                            : ''
                }
            );
        } catch (err) {
        }

        const postWork = {
            itemId: item._id,
            assetId: item.assetId,
            actionNorm,
            isReassignment,
            createdBy: item.createdBy,
            reviewerDisplayName,
            approverRole,
            rejectReason: String(req.body?.reason || req.body?.comment || '').trim(),
            performedBy: req.user?.employeeObjectId,
            userId: req.user?._id,
        };
        if (actionNorm === 'Reject') {
            try {
                await runPostAssetCreationApprovalWork(req, postWork);
            } catch (err) {
            }
        } else {
            setImmediate(() => {
                runPostAssetCreationApprovalWork(req, postWork).catch(() => null);
            });
        }

        const refreshed = await AssetItem.findById(item._id)
            .populate('typeId')
            .populate('categoryId')
            .populate('actionRequiredBy', 'firstName lastName employeeId')
            .populate('createdBy', '_id id employeeId firstName lastName');
        res.status(200).json(refreshed || item);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Bulk respond to asset creation approval (Approve / Reject / Draft)
// @route   PUT /api/AssetItem/bulk/approve-creation
// @access  Private (Asset Controller or Admin)
// Draft = return unchecked rows to creator as Draft; Reject = same Draft return + creator notifications.
export const bulkRespondToAssetCreation = async (req, res) => {
    try {
        const { assetIds, action: rawBulkAction } = req.body;
        const rawBulkStr = String(rawBulkAction || '').trim();
        const bulkLo = rawBulkStr.toLowerCase();
        const bulkActionNorm =
            rawBulkStr === 'Approve' || bulkLo === 'approve'
                ? 'Approve'
                : rawBulkStr === 'Reject' || bulkLo === 'reject'
                    ? 'Reject'
                    : rawBulkStr === 'Draft' || bulkLo === 'draft'
                        ? 'Draft'
                        : null;
        if (!Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ message: 'assetIds is required.' });
        }
        if (!bulkActionNorm) {
            return res.status(400).json({ message: 'Invalid action. Use Approve, Reject, or Draft.' });
        }

        const isJwtAdmin = isJwtSystemSuperUser(req.user);
        const isSysAdmin = await isUserAdministrator(req.user?.id);
        const isAdmin = isJwtAdmin || isSysAdmin;

        const normEmp = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
        const currentEmpId = req.user?.employeeObjectId?.toString?.() || null;
        const currentEmpCode = req.user?.employeeId || null;
        const assetController = await getDepartmentHOD('assetcontroller');
        const isDeptAssetControllerFallback =
            !!(
                assetController &&
                (
                    (assetController?._id && currentEmpId && assetController._id.toString() === currentEmpId) ||
                    (assetController?.employeeId && currentEmpCode && normEmp(assetController.employeeId) === normEmp(currentEmpCode))
                )
            );

        if (!isAdmin && !isDeptAssetControllerFallback) {
            return res.status(403).json({ message: 'Only Asset Controller or Admin can approve bulk creation.' });
        }

        const uniqueIds = [...new Set(assetIds.map(String).filter(Boolean))];
        const items = await AssetItem.find({ _id: { $in: uniqueIds } });
        const byId = new Map(items.map((it) => [it._id.toString(), it]));

        const approvedIds = [];
        const rejectedIds = [];
        const returnedToDraftIds = [];
        const skipped = [];
        const reviewerDisplayName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            'Asset Controller';
        const approverRole = isAdmin ? 'admin' : 'assetcontroller';
        const rejectReason = String(req.body?.reason || req.body?.comment || '').trim();

        for (const id of uniqueIds) {
            const item = byId.get(id);
            if (!item) {
                skipped.push({ id, reason: 'Not found' });
                continue;
            }
            const canBulkApprove =
                item.status === 'Submitted for Approval' ||
                item.status === 'Pending' ||
                (item.status === 'Draft' && item.actionRequiredBy);
            if (!canBulkApprove) {
                skipped.push({ id, reason: `Status is ${item.status}` });
                continue;
            }

            if (!isAdmin && item.actionRequiredBy) {
                let isDesignatedApprover = false;
                const aid = item.actionRequiredBy.toString();
                if (currentEmpId && aid === currentEmpId) {
                    isDesignatedApprover = true;
                } else if (currentEmpCode) {
                    const appr = await EmployeeBasic.findById(item.actionRequiredBy).select('employeeId').lean();
                    if (appr?.employeeId && normEmp(appr.employeeId) === normEmp(currentEmpCode)) {
                        isDesignatedApprover = true;
                    }
                }
                if (!isDesignatedApprover) {
                    skipped.push({ id, reason: 'Not designated approver' });
                    continue;
                }
            }

            if (bulkActionNorm === 'Approve') {
                item.status = 'Unassigned';
                item.creationReturnedToDraftAt = null;
            } else {
                item.status = 'Draft';
                item.creationReturnedToDraftAt =
                    bulkActionNorm === 'Reject' ? new Date() : null;
            }
            item.actionRequiredBy = null;
            if (bulkActionNorm === 'Reject' || bulkActionNorm === 'Draft') {
                item.pendingAction = null;
                item.pendingActionDetails = null;
            }
            await item.save();

            await DashboardAction.findOneAndUpdate(
                { requestId: item._id, requestType: 'Asset Approval', status: 'Pending' },
                {
                    status: bulkActionNorm === 'Approve' ? 'Approved' : 'Rejected',
                    actionedDate: new Date(),
                    actionedBy: req.user?.employeeObjectId || req.user?._id,
                    comment: bulkActionNorm === 'Reject' ? rejectReason : ''
                }
            );

            if (bulkActionNorm === 'Reject' && item.createdBy) {
                await notifyAssetCreationRejectedToCreator({
                    asset: item,
                    createdByUserId: item.createdBy,
                    reviewerDisplayName,
                    actionedBy: req.user?.employeeObjectId || req.user?._id,
                    rejectReason,
                    approverRole
                });
            }

            if (bulkActionNorm === 'Approve') {
                await AssetHistory.create({
                    assetId: item._id,
                    action: 'Accepted',
                    performedBy: req.user.employeeObjectId || req.user._id,
                    comments: 'Bulk asset creation approved by Asset Controller/Admin.',
                    details: { approvalAction: 'Approve', mode: 'BulkCreationApproval' },
                    date: new Date()
                });
                approvedIds.push(item._id.toString());
            } else if (bulkActionNorm === 'Draft') {
                await AssetHistory.create({
                    assetId: item._id,
                    action: 'Update',
                    performedBy: req.user.employeeObjectId || req.user._id,
                    comments: 'Bulk asset creation: not selected for approval — returned to Draft so the creator can edit and resubmit.',
                    details: { approvalAction: 'Draft', mode: 'BulkCreationApproval' },
                    date: new Date()
                });
                returnedToDraftIds.push(item._id.toString());
            } else {
                await AssetHistory.create({
                    assetId: item._id,
                    action: 'Rejected',
                    performedBy: req.user.employeeObjectId || req.user._id,
                    comments:
                        'Bulk asset creation not approved — returned to Draft so the creator can edit and resubmit.',
                    details: { approvalAction: 'Reject', mode: 'BulkCreationApproval' },
                    date: new Date()
                });
                rejectedIds.push(item._id.toString());
            }
        }

        const message =
            bulkActionNorm === 'Approve'
                ? 'Bulk creation approval completed.'
                : bulkActionNorm === 'Draft'
                    ? 'Bulk creation: assets returned to draft.'
                    : 'Bulk creation not approved. Creators were notified to edit and resubmit.';

        res.status(200).json({
            message,
            approvedCount: approvedIds.length,
            rejectedCount: rejectedIds.length,
            returnedToDraftCount: returnedToDraftIds.length,
            skippedCount: skipped.length,
            approvedIds,
            rejectedIds,
            returnedToDraftIds,
            skipped
        });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Fetch bulk asset details for creation approval modal
// @route   GET /api/AssetItem/bulk/details?ids=a,b,c
// @access  Private
export const getBulkAssetDetails = async (req, res) => {
    try {
        const idsParam = req.query.ids;
        if (!idsParam) return res.status(400).json({ message: 'ids query param is required.' });
        const ids = String(idsParam)
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean);
        if (ids.length === 0) return res.status(400).json({ message: 'No valid IDs provided.' });

        const pendingAccessoryCtx = await buildPendingAccessoryVisibilityCtx(req);

        const [isAdminBd, isAcBd, deptAcBd] = await Promise.all([
            isUserAdministrator(req.user?.id),
            isUserInFlowchart(req.user, 'assetcontroller').catch(() => false),
            getDepartmentHOD('assetcontroller'),
        ]);
        const isPortalAdminBd =
            isJwtSystemSuperUser(req.user);
        const currentEmpBd = req.user?.employeeObjectId?.toString?.() || null;
        const isDeptAcBd = !!(deptAcBd?._id && currentEmpBd && deptAcBd._id.toString() === currentEmpBd);
        const normIdBulk = (ref) => {
            if (ref == null) return '';
            if (typeof ref === 'object' && ref._id != null) return String(ref._id);
            return String(ref);
        };
        const viewerStrBd = normIdBulk(req.user?._id) || normIdBulk(req.user?.id);

        const assets = await AssetItem.find({ _id: { $in: ids } })
            .select('assetId name status pendingAction accessories actionRequiredBy createdBy assignedTo')
            .populate('actionRequiredBy', 'firstName lastName employeeId')
            .populate('assignedTo', 'employeeId')
            .lean();
        const byId = new Map(assets.map((a) => [a._id.toString(), a]));
        const notFoundStub = (id) => ({
            _id: id,
            assetId: '—',
            name: 'Asset not found',
            status: null,
            pendingAction: null,
            accessories: []
        });
        const items = ids.map((id) => {
            const a = byId.get(String(id));
            if (!a) return notFoundStub(id);
            if (String(a.status || '').trim() === 'Draft') {
                const createdByNorm = normIdBulk(a.createdBy);
                const isDraftCreator = !!(viewerStrBd && createdByNorm && viewerStrBd === createdByNorm);
                const allowDraftView =
                    isDraftCreator || isPortalAdminBd || isAdminBd || isAcBd || isDeptAcBd;
                if (!allowDraftView) return notFoundStub(id);
            }
            const canSeePending = computeCanSeePendingAddsForAsset(pendingAccessoryCtx, a);
            return {
                ...a,
                accessories: filterAccessoriesHidingPendingAdds(a.accessories || [], canSeePending, a.status)
            };
        });
        res.status(200).json({ items });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Full asset rows for print/PDF inventory (category, type, accessories)
// @route   GET /api/AssetItem/bulk/print-inventory?ids=a,b,c
// @access  Private
export const getBulkAssetInventoryForPrint = async (req, res) => {
    try {
        const idsParam = req.query.ids;
        if (!idsParam) return res.status(400).json({ message: 'ids query param is required.' });
        const ids = String(idsParam)
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean);
        if (ids.length === 0) return res.status(400).json({ message: 'No valid IDs provided.' });

        const pendingAccessoryCtx = await buildPendingAccessoryVisibilityCtx(req);

        const assets = await AssetItem.find({ _id: { $in: ids } })
            .select('assetId name status accessories createdBy assignedTo actionRequiredBy')
            .populate('categoryId', 'name')
            .populate('typeId', 'name')
            .populate('assignedTo', 'employeeId')
            .populate('actionRequiredBy', 'employeeId')
            .lean();

        const order = new Map(ids.map((v, i) => [v, i]));
        assets.sort((a, b) => (order.get(a._id.toString()) ?? 0) - (order.get(b._id.toString()) ?? 0));

        const viewerIdPrint = req.user?._id?.toString() || req.user?.id?.toString();
        const items = assets.map((a) => {
            if (String(a.status || '').trim() === 'Draft') {
                const cid = a.createdBy?.toString?.();
                if (!cid || cid !== viewerIdPrint) {
                    return {
                        _id: a._id,
                        assetId: '—',
                        name: '—',
                        status: null,
                        categoryName: '—',
                        typeName: '—',
                        accessories: []
                    };
                }
            }
            const canSeePending = computeCanSeePendingAddsForAsset(pendingAccessoryCtx, a);
            const accList = filterAccessoriesHidingPendingAdds(a.accessories || [], canSeePending, a.status);
            return {
                _id: a._id,
                assetId: a.assetId,
                name: a.name,
                status: a.status,
                categoryName: a.categoryId?.name || '—',
                typeName: a.typeId?.name || '—',
                accessories: accList.map((acc) => ({
                    name: acc.name || '—',
                    status: acc.status || '—'
                }))
            };
        });

        res.status(200).json({ items });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Update an existing asset item
// @route   PUT /api/AssetItem/:id
// @access  Private
export const updateAssetItem = async (req, res) => {
    try {
        const { id } = req.params;
        let { name, photo, status, categoryId, assetValue, purchaseDate, warrantyYears, lastServiceDate, onServiceActive, onLeaveActive } = req.body;

        const isJwtAdmin = isJwtSystemSuperUser(req.user);
        const isSysAdmin = await isUserAdministrator(req.user?.id);
        const isAdmin = isJwtAdmin || isSysAdmin;
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        const item = await AssetItem.findById(id);
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Check if current user is the creator
        const currentUserId = req.user._id?.toString() || req.user.id?.toString();
        const isCreator = item.createdBy?.toString() === currentUserId;
        const isDraft = item.status === 'Draft';
        const isRejectedCreation = item.status === 'Rejected';
        const isSubmittedForApproval = item.status === 'Submitted for Approval';

        // Strict edit permission:
        // 1) Submitted for approval -> creator cannot edit (even if they are Asset Controller); AC/Admin (non-creator) or system admin can edit
        // 2) Draft -> only creator can edit
        // 3) Rejected (creation declined) -> creator or Asset Controller/Admin can edit
        // 4) Unassigned (non-draft) -> only Asset Controller/Admin can edit
        // 5) Assigned/other statuses -> only Asset Controller/Admin can edit
        if (isSubmittedForApproval) {
            if (isCreator && !isAdmin) {
                return res.status(403).json({
                    message: 'This asset is awaiting approval. The creator cannot edit until it is approved or rejected.'
                });
            }
            if (!isAdmin && !isAssetController) {
                return res.status(403).json({
                    message: 'This asset is awaiting approval. Only Asset Controller or Admin can edit.'
                });
            }
        } else if (isDraft) {
            if (!isCreator) {
                return res.status(403).json({ message: "Only the asset creator can edit draft assets." });
            }
        } else if (isRejectedCreation) {
            if (!isCreator && !isAdmin && !isAssetController) {
                return res.status(403).json({
                    message: 'Only the asset creator, Asset Controller, or Admin can edit a rejected asset.'
                });
            }
        } else {
            if (!isAdmin && !isAssetController) {
                return res.status(403).json({ message: "Only Asset Controller or Admin can edit non-draft assets." });
            }
        }

        if (name) item.name = name;
        if (categoryId !== undefined) item.categoryId = categoryId || null;
        if (assetValue !== undefined) item.assetValue = assetValue || 0;
        if (purchaseDate !== undefined) item.purchaseDate = purchaseDate || null;
        if (warrantyYears !== undefined) item.warrantyYears = warrantyYears || 0;
        const creatorCannotSetStatusViaPut =
            isCreator && !isAdmin && !isAssetController && (isDraft || isRejectedCreation);
        if (status && !creatorCannotSetStatusViaPut) {
            item.status = status;
        }
        if (lastServiceDate !== undefined) item.lastServiceDate = lastServiceDate || null;

        if (onServiceActive !== undefined && (isAdmin || isAssetController)) {
            item.onServiceActive = onServiceActive === true || onServiceActive === 'yes';
        }
        if (onLeaveActive !== undefined && (isAdmin || isAssetController)) {
            item.onLeaveActive = onLeaveActive === true || onLeaveActive === 'yes';
        }

        // Handle Photo Upload if changed
        if (photo && photo.startsWith('data:image')) {
            try {
                const uploadResult = await uploadDocumentToS3(photo, 'asset-photos');
                item.photo = uploadResult.publicId;
                item.imagePreview = uploadResult.publicId;
            } catch (error) {
            }
        } else if (photo === null) {
            // they removed the photo? maybe not support deleting this way.
        }

        await item.save();
        await notifyAssignedEmployeeIfController(req, item, 'Return Asset', 'Asset return was processed by Asset Controller.');

        // Create history log
        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: item._id,
                action: 'Update',
                performedBy: req.user.employeeObjectId || req.user._id,
                comments: 'Asset details updated.',
                details: item.toObject()
            });
        } catch (historyErr) {
        }

        res.status(200).json(item);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get single asset item details
// @route   GET /api/AssetItem/detail/:id
// @access  Private
export const getAssetItemDetail = async (req, res) => {
    try {
        const { id } = req.params;
        const item = await AssetItem.findById(id)
            .populate('assignedCompany')
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId profilePicture companyEmail workEmail department dateOfJoining reportingAuthority primaryReportee signature enablePortalAccess',
                populate: [
                    {
                        path: 'reportingAuthority',
                        select: 'firstName lastName'
                    },
                    {
                        path: 'primaryReportee',
                        select: 'firstName lastName employeeId signature',
                    },
                ]
            })
            .populate({
                path: 'assignedBy',
                select: 'firstName lastName employeeId signature'
            })
            .populate('acceptedBy', 'firstName lastName signature')
            .populate({
                path: 'createdBy',
                select: '_id id employeeId firstName lastName'
            })
            .populate('typeId', 'name imagePreview')
            .populate('actionRequiredBy', 'firstName lastName employeeId')
            .populate('categoryId', 'name imagePreview');

        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        if (healStaleParkingFields(item)) {
            await item.save();
        }

        // Populate sometimes leaves a bare ObjectId; load EmployeeBasic so UI + canApprove match correctly
        if (item.actionRequiredBy) {
            const arRaw = item.actionRequiredBy;
            const hasApproverFields = arRaw.firstName || arRaw.lastName || arRaw.employeeId;
            if (!hasApproverFields) {
                const rid = arRaw._id || arRaw;
                const arEmp = await EmployeeBasic.findById(rid).select('firstName lastName employeeId').lean();
                if (arEmp) {
                    item.actionRequiredBy = arEmp;
                }
            }
        }

        // If a creation approval is in flight, ensure actionRequiredBy + DashboardAction route to the
        // CURRENT role holder (HR for fleet, AC for tools). Heals stale routing after a flowchart swap.
        let currentCreationApprover = null;
        try {
            currentCreationApprover = await syncStaleAssetCreationApprover(item);
        } catch (syncErr) {
        }

        // Heal assignment rows where creation-approver sync previously overwrote assignee routing.
        if (
            isAssetAssignmentAcknowledgmentPending(item) &&
            item.assignedToType === 'Employee' &&
            item.assignedTo &&
            !item.pendingAction
        ) {
            try {
                const assigneeDoc =
                    typeof item.assignedTo === 'object' && item.assignedTo.employeeId
                        ? item.assignedTo
                        : await EmployeeBasic.findById(item.assignedTo._id || item.assignedTo)
                            .select(
                                'employeeId firstName lastName companyEmail primaryReportee enablePortalAccess',
                            )
                            .populate({
                                path: 'primaryReportee',
                                select: '_id firstName lastName employeeId companyEmail',
                            })
                            .lean();
                const assignerRef = item.assignedBy?._id || item.assignedBy;
                const handoverFlowHeal = getVehicleHandoverFlow(item);
                const fleetHeal = isFleetVehicleAssetFields({
                    plateNumber: item.plateNumber,
                    typeName: item.typeId?.name,
                });

                let expectedId = null;
                if (fleetHeal && handoverFlowHeal?.stage) {
                    if (handoverFlowHeal.stage === 'target') {
                        const fleetActor = await resolveFleetHandoverFirstActor(assigneeDoc);
                        expectedId =
                            fleetActor.actorId?._id?.toString?.() ||
                            fleetActor.actorId?.toString?.() ||
                            null;
                    } else if (
                        handoverFlowHeal.stage === 'hod' ||
                        handoverFlowHeal.stage === 'hr' ||
                        handoverFlowHeal.stage === 'management'
                    ) {
                        const hrEmp = await getResolvedFleetHrEmployee();
                        expectedId = hrEmp?._id?.toString?.() || null;
                        if (handoverFlowHeal.stage === 'hod') {
                            await AssetItem.updateOne(
                                { _id: item._id },
                                {
                                    $set: {
                                        'pendingActionDetails.vehicleHandoverFlow.stage': 'hr',
                                    },
                                },
                            );
                            handoverFlowHeal.stage = 'hr';
                        }
                    }
                } else {
                    const resolved = await resolveEmployeeAssignmentActors(assigneeDoc, assignerRef);
                    if (!resolved.autoAcceptOnAssign && resolved.pendingActionActorId) {
                        expectedId =
                            resolved.pendingActionActorId?._id?.toString?.() ||
                            resolved.pendingActionActorId?.toString?.() ||
                            null;
                    }
                }

                if (expectedId) {
                    const currentId =
                        item.actionRequiredBy?._id?.toString?.() ||
                        item.actionRequiredBy?.toString?.() ||
                        null;
                    if (currentId !== expectedId) {
                        await AssetItem.updateOne(
                            { _id: item._id },
                            { $set: { actionRequiredBy: expectedId } },
                        );
                        const healed = await EmployeeBasic.findById(expectedId)
                            .select('firstName lastName employeeId')
                            .lean();
                        if (healed) item.actionRequiredBy = healed;
                        await DashboardAction.findOneAndUpdate(
                            {
                                requestId: item._id,
                                requestType: 'Asset Assignment',
                                status: 'Pending',
                                ...(fleetHeal && handoverFlowHeal?.historyId
                                    ? {
                                          extra3: {
                                              $regex: '"handoverViewerRole"\\s*:\\s*"actor"',
                                              $options: 'i',
                                          },
                                      }
                                    : {}),
                            },
                            {
                                assignedTo: expectedId,
                                assignedToEmpId: healed?.employeeId,
                                ...(fleetHeal && handoverFlowHeal?.historyId
                                    ? {
                                          extra3: buildHandoverDashboardExtra3(
                                              item._id,
                                              handoverFlowHeal.historyId,
                                              { viewerRole: 'actor' },
                                          ),
                                          extra2:
                                              handoverFlowHeal.stage === 'hr' ||
                                              handoverFlowHeal.stage === 'management'
                                                  ? 'HR Approval'
                                                  : 'Vehicle Handover',
                                      }
                                    : {}),
                            },
                        );
                        if (fleetHeal && handoverFlowHeal?.historyId && assignerRef) {
                            const assignerDoc =
                                typeof item.assignedBy === 'object' && item.assignedBy?.employeeId
                                    ? item.assignedBy
                                    : await EmployeeBasic.findById(assignerRef)
                                          .select('firstName lastName employeeId')
                                          .lean();
                            if (assignerDoc?._id) {
                                const subjName = assigneeDoc
                                    ? `${assigneeDoc.firstName || ''} ${assigneeDoc.lastName || ''}`.trim()
                                    : '';
                                await upsertHandoverAssignerDashboardAction({
                                    asset: item,
                                    assigner: assignerDoc,
                                    historyId: handoverFlowHeal.historyId,
                                    subjectName: subjName,
                                    subjectEmpId: assigneeDoc?.employeeId || '',
                                }).catch(() => null);
                                const adminOfficer = await resolveAdminOfficerEmployee();
                                if (adminOfficer?._id) {
                                    await upsertHandoverAdminOfficerDashboardAction({
                                        asset: item,
                                        adminOfficer,
                                        historyId: handoverFlowHeal.historyId,
                                        subjectName: subjName,
                                        subjectEmpId: assigneeDoc?.employeeId || '',
                                    }).catch(() => null);
                                }
                            }
                        }
                    }
                }
            } catch (healErr) {
            }
        }

        if (
            isAssetAssignmentAcknowledgmentPending(item) &&
            item.assignedToType === 'Employee' &&
            isFleetVehicleAssetFields({ plateNumber: item.plateNumber, typeName: item.typeId?.name }) &&
            !getVehicleHandoverFlow(item) &&
            !isVehicleInspectionWorkflowActive(item)
        ) {
            try {
                const latestAssigned = await AssetHistory.findOne({
                    assetId: item._id,
                    action: 'Assigned',
                    'details.handoverKind': { $ne: VEHICLE_INSPECTION_HANDOVER_KIND },
                    'details.firstInspection': { $ne: true },
                })
                    .sort({ createdAt: -1 })
                    .select('_id')
                    .lean();

                if (latestAssigned?._id) {
                    const historyId = latestAssigned._id.toString();
                    const assigneeForFlow =
                        typeof item.assignedTo === 'object' && item.assignedTo?.employeeId
                            ? item.assignedTo
                            : await EmployeeBasic.findById(item.assignedTo?._id || item.assignedTo)
                                .select(
                                    'employeeId firstName lastName companyEmail workEmail personalEmail email enablePortalAccess primaryReportee',
                                )
                                .lean();
                    const fleetActor = assigneeForFlow
                        ? await resolveFleetHandoverFirstActor(assigneeForFlow)
                        : null;
                    const requestedAt = await resolveHandoverEscalationRequestedAt(historyId);

                    item.pendingActionDetails = {
                        ...(item.pendingActionDetails || {}),
                        vehicleHandoverFlow: {
                            stage: 'target',
                            historyId,
                            assigneeCanSelfAcknowledge: fleetActor?.assigneeCanSelfAcknowledge ?? false,
                            pendingActorName: buildHandoverFlowPendingActorName(assigneeForFlow, fleetActor),
                            escalation: buildInitialHandoverEscalationMeta(requestedAt),
                        },
                    };
                    await item.save();
                }
            } catch (flowHealErr) {
                /* non-fatal */
            }
        }

        const handoverFlowForEscalation = getVehicleHandoverFlow(item);
        if (
            handoverFlowForEscalation?.stage === 'target' &&
            handoverFlowForEscalation?.historyId &&
            !handoverFlowForEscalation?.escalation?.requestedAt &&
            isFleetVehicleAssetFields({ plateNumber: item.plateNumber, typeName: item.typeId?.name }) &&
            item.assignedToType === 'Employee' &&
            String(item.acceptanceStatus || '').trim() === 'Pending'
        ) {
            try {
                const requestedAt = await resolveHandoverEscalationRequestedAt(
                    handoverFlowForEscalation.historyId,
                );
                await AssetItem.updateOne(
                    { _id: item._id },
                    {
                        $set: {
                            'pendingActionDetails.vehicleHandoverFlow.escalation':
                                buildInitialHandoverEscalationMeta(requestedAt),
                        },
                    },
                );
                item.pendingActionDetails = {
                    ...(item.pendingActionDetails || {}),
                    vehicleHandoverFlow: {
                        ...handoverFlowForEscalation,
                        escalation: buildInitialHandoverEscalationMeta(requestedAt),
                    },
                };
            } catch (escalationHealErr) {
                /* non-fatal */
            }
        }

        if (handoverFlowForEscalation?.historyId) {
            try {
                await seedPreviousHandoverReportsOnHistory({
                    historyId: handoverFlowForEscalation.historyId,
                    assetId: item._id,
                });
            } catch (seedHealErr) {
                /* non-fatal */
            }
        }

        // acceptedBy (e.g. HR who acknowledged company allocation): ensure names + signature for handover form
        if (item.acceptedBy) {
            const abRaw = item.acceptedBy;
            const hasName = abRaw.firstName || abRaw.lastName;
            if (!hasName) {
                const rid = abRaw._id || abRaw;
                const abEmp = await EmployeeBasic.findById(rid).select('firstName lastName employeeId signature').lean();
                if (abEmp) {
                    item.acceptedBy = abEmp;
                }
            }
        }

        // Visibility: system admin (env username) / portal Admin+ROOT / Flowchart asset controller / dept AC HOD /
        // creator / assignee / person who must act (draft approval, accept assignment, etc.)
        const [isAdmin, isAssetController, assetController] = await Promise.all([
            isUserAdministrator(req.user?.id),
            isUserInFlowchart(req.user, 'assetcontroller'),
            getDepartmentHOD('assetcontroller'),
        ]);
        const isPortalAdmin =
            isJwtSystemSuperUser(req.user);
        const normUserRefId = (ref) => {
            if (ref == null) return '';
            if (typeof ref === 'object' && ref._id != null) return String(ref._id);
            return String(ref);
        };
        const viewerUserStr = normUserRefId(req.user?._id) || normUserRefId(req.user?.id);
        const createdByStr = normUserRefId(item.createdBy);
        const isCreator = !!(viewerUserStr && createdByStr && viewerUserStr === createdByStr);

        const currentEmpId = req.user?.employeeObjectId?.toString();
        const normEmpView = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
        let currentEmployeeIdNorm = normEmpView(req.user?.employeeId);
        // If employeeObjectId exists but employeeId string is missing, resolve it
        if (!currentEmployeeIdNorm && currentEmpId) {
            const curEmp = await EmployeeBasic.findById(currentEmpId).select('employeeId').lean().catch(() => null);
            if (curEmp?.employeeId) currentEmployeeIdNorm = normEmpView(curEmp.employeeId);
        }

        const assigneeRef = item.assignedTo;
        const assigneeEmpObjectId = assigneeRef
            ? assigneeRef._id
                ? assigneeRef._id.toString()
                : assigneeRef.toString()
            : null;
        // Assigned user visibility:
        // - primary match by EmployeeBasic ObjectId (fast)
        // - fallback match by employeeId string (handles missing/partial populate + spacing differences)
        let isAssignedToUser = !!(assigneeEmpObjectId && currentEmpId && assigneeEmpObjectId === currentEmpId);

        let assigneeEmployeeIdNorm = null;
        if (typeof assigneeRef === 'object' && assigneeRef?.employeeId) {
            assigneeEmployeeIdNorm = normEmpView(assigneeRef.employeeId);
        } else if (assigneeEmpObjectId) {
            const assigneeEmp = await EmployeeBasic.findById(assigneeEmpObjectId).select('employeeId').lean().catch(() => null);
            if (assigneeEmp?.employeeId) assigneeEmployeeIdNorm = normEmpView(assigneeEmp.employeeId);
        }

        if (!isAssignedToUser && assigneeEmployeeIdNorm && currentEmployeeIdNorm) {
            isAssignedToUser = assigneeEmployeeIdNorm === currentEmployeeIdNorm;
        }

        let isActionRequiredByUser = false;
        // actionRequiredBy: match by EmployeeBasic ObjectId and/or employeeId string
        if (item.actionRequiredBy && currentEmpId) {
            const arId = item.actionRequiredBy._id?.toString() || item.actionRequiredBy.toString();
            if (arId === currentEmpId) isActionRequiredByUser = true;
        }
        if (!isActionRequiredByUser && item.actionRequiredBy && currentEmployeeIdNorm) {
            const arRef = item.actionRequiredBy;
            let arEmployeeIdNorm = null;
            if (typeof arRef === 'object' && arRef?.employeeId) {
                arEmployeeIdNorm = normEmpView(arRef.employeeId);
            } else {
                const arObjId = arRef?._id?.toString?.() || arRef?.toString?.() || null;
                if (arObjId) {
                    const arEmp = await EmployeeBasic.findById(arObjId).select('employeeId').lean().catch(() => null);
                    if (arEmp?.employeeId) arEmployeeIdNorm = normEmpView(arEmp.employeeId);
                }
            }
            if (arEmployeeIdNorm && arEmployeeIdNorm === currentEmployeeIdNorm) {
                isActionRequiredByUser = true;
            }
        }

        const isDeptAssetController =
            assetController?._id &&
            currentEmpId &&
            assetController._id.toString() === currentEmpId;

        // Draft (e.g. after creation reject): creator, admins, and Asset Controller roles may view the record.
        const statusTrimmed = String(item.status || '').trim();
        if (statusTrimmed === 'Draft') {
            const canViewDraft =
                isCreator ||
                isPortalAdmin ||
                isAdmin ||
                isAssetController ||
                isDeptAssetController;
            if (!canViewDraft) {
                return res.status(404).json({ message: 'Asset not found' });
            }
        }

        migrateLegacyOperationalFlags(item);
        if (item.isModified()) {
            await item.save();
        }

        // Repair accessories left as Attached after L&D was finalized before disposition logic shipped.
        if (String(item.status || '').trim().toLowerCase() === 'lost' && item.accessories?.length) {
            let repairNeeded = false;
            for (const acc of item.accessories) {
                const accSt = String(acc.status || '').trim().toLowerCase();
                if (!accSt || accSt === 'attached') {
                    acc.status = 'Lost';
                    repairNeeded = true;
                    try {
                        await AssetAccessoryCatalog.updateMany(
                            { recordType: 'instance', assetItemId: item._id, assetAccessoryId: acc.accessoryId },
                            { $set: { status: 'Lost' } },
                        );
                    } catch {
                        /* non-fatal */
                    }
                }
            }
            if (repairNeeded) {
                item.markModified('accessories');
                await item.save();
            }
        }

        const itemObj = item.toObject();

        const canSeePendingAccessoryAdds =
            isAdmin ||
            isPortalAdmin ||
            isAssetController ||
            isDeptAssetController ||
            isAssignedToUser ||
            isActionRequiredByUser;

        if (itemObj.accessories?.length) {
            itemObj.accessories = filterAccessoriesHidingPendingAdds(
                itemObj.accessories,
                canSeePendingAccessoryAdds,
                itemObj.status
            );
        }

        const signKey = (key) => (key ? getSignedFileUrl(key) : Promise.resolve(key));

        const signMortgageAttachment = async (val) => {
            if (val == null || val === '') return val;
            if (typeof val === 'string') {
                const trimmed = val.trim();
                if (!trimmed || trimmed.startsWith('data:')) return val;
                if (trimmed.length > 80 && !trimmed.includes('/') && !trimmed.startsWith('http')) {
                    return val;
                }
                return signKey(trimmed);
            }
            if (typeof val === 'object' && !Array.isArray(val)) {
                if (val.data && !val.publicId && !val.url) return val;
                if (val.file != null) {
                    return { ...val, file: await signMortgageAttachment(val.file) };
                }
                const ref = val.publicId || val.url;
                if (ref) {
                    const signed = await signKey(String(ref));
                    return { ...val, url: signed };
                }
            }
            return val;
        };

        const signRemarkImages = async (arr) => {
            if (!Array.isArray(arr)) return arr;
            return Promise.all(
                arr.map(async (img) => {
                    if (!img) return img;
                    if (typeof img === 'string') return signKey(img);
                    if (typeof img === 'object') {
                        const rawUrl = img.url || img.publicId || '';
                        if (!rawUrl) return img;
                        return { ...img, url: await signKey(rawUrl) };
                    }
                    return img;
                }),
            );
        };

        const signOneService = async (service) => {
            const fileKeys = [
                'invoice',
                'serviceCompletionReport',
                'shopInvoice',
                'attachment',
                'quotation2',
                'quotation3',
            ];
            await Promise.all(
                fileKeys.map(async (field) => {
                    if (service[field]) service[field] = await signKey(service[field]);
                }),
            );

            if (service.remark && typeof service.remark === 'string') {
                try {
                    const remarkObj = JSON.parse(service.remark);
                    if (remarkObj && typeof remarkObj === 'object') {
                        if (Array.isArray(remarkObj.accidentImages)) {
                            remarkObj.accidentImages = await signRemarkImages(remarkObj.accidentImages);
                        }
                        if (Array.isArray(remarkObj.bodyWorkImages)) {
                            remarkObj.bodyWorkImages = await signRemarkImages(remarkObj.bodyWorkImages);
                        }
                        if (Array.isArray(remarkObj.newConditionImages)) {
                            remarkObj.newConditionImages = await signRemarkImages(remarkObj.newConditionImages);
                        }
                        service.remark = JSON.stringify(remarkObj);
                    }
                } catch (_e) {
                    /* keep original remark */
                }
            }

            if (Array.isArray(service?.workflowSnapshot?.history)) {
                await Promise.all(
                    service.workflowSnapshot.history.map(async (h) => {
                        if (h?.bySignatureUrl) h.bySignatureUrl = await signKey(h.bySignatureUrl);
                    }),
                );
            }
        };

        const deferHeavyServiceSigning =
            String(req.query.deferServiceSigning || '').toLowerCase() === '1' ||
            String(req.query.deferServiceSigning || '').toLowerCase() === 'true';

        const deferLightDetail =
            String(req.query.light || '').toLowerCase() === '1' ||
            String(req.query.light || '').toLowerCase() === 'true';

        const headerSignTasks = [
            itemObj.typeId?.imagePreview
                ? signKey(itemObj.typeId.imagePreview).then((u) => { itemObj.typeId.imagePreview = u; })
                : null,
            itemObj.categoryId?.imagePreview
                ? signKey(itemObj.categoryId.imagePreview).then((u) => { itemObj.categoryId.imagePreview = u; })
                : null,
            itemObj.imagePreview ? signKey(itemObj.imagePreview).then((u) => { itemObj.imagePreview = u; }) : null,
            itemObj.photo ? signKey(itemObj.photo).then((u) => { itemObj.photo = u; }) : null,
        ];

        const nonServiceAttachmentSignTasks = [
            itemObj.invoiceFile ? signKey(itemObj.invoiceFile).then((u) => { itemObj.invoiceFile = u; }) : null,
            itemObj.warrantyAttachment
                ? signKey(itemObj.warrantyAttachment).then((u) => { itemObj.warrantyAttachment = u; })
                : null,
            itemObj.accidentReportAttachment
                ? signKey(itemObj.accidentReportAttachment).then((u) => { itemObj.accidentReportAttachment = u; })
                : null,
            ...headerSignTasks,
            itemObj.assignedBy?.signature?.url
                ? signKey(itemObj.assignedBy.signature.url).then((u) => { itemObj.assignedBy.signature.url = u; })
                : null,
            itemObj.assignedTo?.signature?.url
                ? signKey(itemObj.assignedTo.signature.url).then((u) => { itemObj.assignedTo.signature.url = u; })
                : null,
            itemObj.assignedTo?.primaryReportee?.signature?.url
                ? signKey(itemObj.assignedTo.primaryReportee.signature.url).then((u) => {
                      itemObj.assignedTo.primaryReportee.signature.url = u;
                  })
                : null,
            itemObj.acceptedBy?.signature?.url
                ? signKey(itemObj.acceptedBy.signature.url).then((u) => { itemObj.acceptedBy.signature.url = u; })
                : null,
            ...(itemObj.accessories || []).map((acc) =>
                acc.attachment ? signKey(acc.attachment).then((u) => { acc.attachment = u; }) : null,
            ),
            ...(itemObj.documents || []).map((doc) =>
                doc.attachment ? signKey(doc.attachment).then((u) => { doc.attachment = u; }) : null,
            ),
            ...(itemObj.images || []).map((img) =>
                img.url ? signKey(img.url).then((u) => { img.url = u; }) : null,
            ),
            itemObj.mortgageSecurityCheckAttachment
                ? signMortgageAttachment(itemObj.mortgageSecurityCheckAttachment).then((u) => {
                    itemObj.mortgageSecurityCheckAttachment = u;
                })
                : null,
            itemObj.mortgageScheduleListAttachment
                ? signMortgageAttachment(itemObj.mortgageScheduleListAttachment).then((u) => {
                    itemObj.mortgageScheduleListAttachment = u;
                })
                : null,
            itemObj.mortgageBankDocument
                ? signMortgageAttachment(itemObj.mortgageBankDocument).then((u) => {
                    itemObj.mortgageBankDocument = u;
                })
                : null,
            ...(Array.isArray(itemObj.mortgageExtraAttachments)
                ? itemObj.mortgageExtraAttachments.map((row) =>
                    row?.file
                        ? signMortgageAttachment(row.file).then((u) => {
                            row.file = u;
                        })
                        : null,
                )
                : []),
            ...(Array.isArray(itemObj?.activeServiceWorkflow?.history)
                ? itemObj.activeServiceWorkflow.history.map((h) =>
                    h?.bySignatureUrl
                        ? signKey(h.bySignatureUrl).then((u) => { h.bySignatureUrl = u; })
                        : null,
                )
                : []),
        ];

        const vehicleAccessoriesListSignTask =
            Array.isArray(itemObj.vehicleAccessoriesListEntries) &&
            itemObj.vehicleAccessoriesListEntries.length
                ? signVehicleAccessoriesListEntries(itemObj.vehicleAccessoriesListEntries, signKey).then(
                      (signed) => {
                          itemObj.vehicleAccessoriesListEntries = signed;
                      },
                  )
                : null;

        let signTasks;
        if (deferLightDetail) {
            itemObj.deferredAttachmentSigning = true;
            signTasks = [...headerSignTasks, vehicleAccessoriesListSignTask];
        } else if (deferHeavyServiceSigning) {
            itemObj.deferredAttachmentSigning = true;
            signTasks = [...nonServiceAttachmentSignTasks, vehicleAccessoriesListSignTask];
        } else {
            signTasks = [...nonServiceAttachmentSignTasks, vehicleAccessoriesListSignTask];
            if (itemObj.services?.length) {
                signTasks.push(...itemObj.services.map((s) => signOneService(s)));
            }
        }

        await Promise.all(signTasks.filter(Boolean));

        // Reuse assetController from visibility check above
        if (assetController) {
            itemObj.assetController = {
                _id: assetController._id,
                firstName: assetController.firstName,
                lastName: assetController.lastName,
                employeeId: assetController.employeeId,
                companyEmail: assetController.companyEmail
            };
            itemObj.assetControllerId = assetController._id;
        } else {
            itemObj.assetController = null;
            itemObj.assetControllerId = null;
        }

        // Role-based creation approver (current flowchart holder) — used for the banner so the UI shows
        // HR for fleet vehicles and Asset Controller for tools, regardless of stored actionRequiredBy.
        try {
            const approverPerson = currentCreationApprover
                || (await resolveAssetCreationApproverEmployee({
                    plateNumber: item.plateNumber,
                    typeName: item?.typeId?.name || '',
                }));
            if (approverPerson?._id) {
                itemObj.creationApprover = {
                    _id: approverPerson._id,
                    firstName: approverPerson.firstName,
                    lastName: approverPerson.lastName,
                    employeeId: approverPerson.employeeId,
                    companyEmail: approverPerson.companyEmail,
                };
            } else {
                itemObj.creationApprover = null;
            }
            itemObj.creationApproverRole = creationApproverRoleLabel({
                plateNumber: item.plateNumber,
                typeName: item?.typeId?.name || '',
            });
        } catch (apprErr) {
            itemObj.creationApprover = null;
            itemObj.creationApproverRole = null;
        }

        // Special handling for Abbas Raza case:
        // If assetController exists in Flowchart but no EmployeeBasic record, still show the info
        if (assetController && !assetController._id) {
            itemObj.assetController = {
                _id: `flowchart_${assetController.category}`, // Use special ID for frontend matching
                firstName: assetController.employeeName?.split(' ')[0] || 'Unknown',
                lastName: assetController.employeeName?.split(' ').slice(1).join(' ') || '',
                employeeId: assetController.employeeId,
                companyEmail: assetController.email
            };
            itemObj.assetControllerId = `flowchart_${assetController.category}`;
        }

        // Authoritative UI flag (same rules as PUT approve-creation) — avoids client-only isAssetController drift
        const isAssignmentAcknowledgmentOnly =
            item.acceptanceStatus === 'Pending' &&
            !item.pendingAction &&
            (item.status === 'Pending' || item.status === 'Assigned') &&
            // For employee assignments, `assignedTo` exists.
            // For company allocations, `assignedCompany` exists.
            (item.assignedTo || item.assignedCompany);

        const isAwaitingCreationApproval =
            item.status === 'Submitted for Approval' ||
            (item.status === 'Draft' && item.actionRequiredBy) ||
            (item.actionRequiredBy != null &&
                item.status === 'Pending' &&
                !isAssignmentAcknowledgmentOnly);

        // Flowchart check can miss valid approvers; creation flow stores the real approver on actionRequiredBy
        const normEmp = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
        const actionById =
            item.actionRequiredBy?._id?.toString?.() ||
            item.actionRequiredBy?.toString?.() ||
            null;
        const reqEmpObj = req.user?.employeeObjectId?.toString?.() || null;
        const matchesActionByObjectId = !!(actionById && reqEmpObj && actionById === reqEmpObj);
        const arEmployeeId = item.actionRequiredBy?.employeeId;
        const reqUserEmployeeId = req.user?.employeeId;
        const matchesActionByEmployeeId = !!(
            arEmployeeId &&
            reqUserEmployeeId &&
            normEmp(arEmployeeId) === normEmp(reqUserEmployeeId)
        );
        const isDesignatedCreationApprover = matchesActionByObjectId || matchesActionByEmployeeId;

        // Save-only drafts (no actionRequiredBy) may be approved by department AC before submit.
        let canApproveAsDeptAssetController = false;
        if (!item.actionRequiredBy && item.status === 'Draft') {
            canApproveAsDeptAssetController = !!isDeptAssetController;
        }

        // Designated approver, dept AC for save-only drafts, or admin. When the creator is also the
        // designated approver (sole Asset Controller), they may approve their own submission.
        itemObj.canApproveAssetCreation = !!(
            isAwaitingCreationApproval &&
            (isAdmin ||
                isPortalAdmin ||
                isDesignatedCreationApprover ||
                canApproveAsDeptAssetController) &&
            (!isCreator || isDesignatedCreationApprover || isAdmin || isPortalAdmin)
        );

        const wfStage = itemObj.activeServiceWorkflow?.stage;
        itemObj.canRespondToServiceWorkflow = await userMayRespondVehicleServiceWorkflow(req.user, wfStage);
        if (wfStage && !['complete', 'rejected'].includes(wfStage)) {
            itemObj.activeServiceWorkflow = {
                ...itemObj.activeServiceWorkflow,
                currentAssignee: await getWorkflowAssigneePayloadForStage(wfStage)
            };
        }

        try {
            for (const s of itemObj.services || []) {
                if (String(s.serviceType || '').trim() !== 'Oil Service') continue;
                let remark = {};
                try {
                    remark = typeof s.remark === 'string' ? JSON.parse(s.remark) : (s.remark || {});
                } catch {
                    remark = {};
                }
                if (String(remark.vehicleServiceCompleted || '').toLowerCase() === 'live') {
                    await closeOilServicePendingDashboardActions(item._id, s._id, {
                        comment: 'Oil service completed',
                    });
                }
            }
            await healStaleOilServicePendingDashboardActions({ assetIds: [item._id] });
            const freshForOilActivation = await AssetItem.findById(item._id).select(
                'services activeServiceWorkflow onServiceActive status',
            );
            if (freshForOilActivation) {
                await activateOilServiceOnStartDate(freshForOilActivation, { byName: 'System' });
                const freshForShopActivation = await AssetItem.findById(item._id).select(
                    'services activeServiceWorkflow onServiceActive status assignedTo plateEmirate plateNumber assetId',
                );
                if (freshForShopActivation) {
                    const shopWf = freshForShopActivation.activeServiceWorkflow || {};
                    const shopType = String(shopWf.serviceTypeLabel || '').trim();
                    if (
                        shopType === 'Tire Change' ||
                        shopType === 'Mechanical Work' ||
                        shopType === 'Body Work' ||
                        shopType === 'Accident Repair'
                    ) {
                        const linkPath =
                            shopType === 'Tire Change'
                                ? `/HRM/Asset/Vehicle/details/${item._id}/tire-change/${shopWf.serviceRecordId}`
                                : shopType === 'Mechanical Work'
                                  ? `/HRM/Asset/Vehicle/details/${item._id}/mechanical-work/${shopWf.serviceRecordId}`
                                  : shopType === 'Body Work'
                                    ? `/HRM/Asset/Vehicle/details/${item._id}/body-work/${shopWf.serviceRecordId}`
                                    : `/HRM/Asset/Vehicle/details/${item._id}/accident-repair/${shopWf.serviceRecordId}`;
                        const dashboardMeta = JSON.stringify({
                            vehicleId: String(item._id),
                            serviceRecordId: String(shopWf.serviceRecordId || ''),
                            serviceType: shopType,
                            detailsPath: linkPath,
                        });
                        await activateShopServiceOnStartDate(freshForShopActivation, {
                            serviceTypeLabel: shopType,
                            linkPath,
                            dashboardMeta,
                            byName: 'System',
                            notify: true,
                        });
                    }
                }
                const freshForOilDue = await AssetItem.findById(item._id).select(
                    'assetId plateNumber plateEmirate services activeServiceWorkflow currentKilometer nextServiceDate assignedTo vehicleProfileActivationStatus typeId',
                ).populate('typeId', 'name');
                if (freshForOilDue) {
                    await maybeAutoCreateOilServiceDue(freshForOilDue);
                }
                const activated = await AssetItem.findById(item._id).select(
                    'services activeServiceWorkflow onServiceActive status',
                ).lean();
                if (activated) {
                    itemObj.services = activated.services;
                    itemObj.activeServiceWorkflow = activated.activeServiceWorkflow;
                    itemObj.onServiceActive = activated.onServiceActive;
                    itemObj.status = activated.status;
                }
            }
        } catch (healErr) {
            /* non-fatal */
        }

        res.status(200).json(itemObj);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Assign an asset item to an employee
// @route   PUT /api/AssetItem/:id/assign
// @access  Private
export const assignAssetItem = async (req, res) => {
    try {
        const { id } = req.params;
        const { assignedTo, assignedToType, assignmentType, assignedDays, assignmentReason: assignmentReasonRaw } =
            req.body;
        const assignmentReason = String(assignmentReasonRaw || req.body.reason || '').trim();

        if (!assignedTo || !assignmentType) {
            return res.status(400).json({ message: 'Target and assignment type are required' });
        }

        const item = await AssetItem.findById(id)
            .populate('assignedTo', 'firstName lastName employeeId companyEmail workEmail')
            .populate('assignedCompany', 'name email companyId')
            .populate('typeId', 'name');
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const fleetVehicle = isFleetVehicleAssetFields({
            plateNumber: item.plateNumber,
            typeName: item.typeId?.name,
        });

        if (fleetVehicle && !isFleetVehicleProfileActive(item)) {
            return res.status(400).json({ message: FLEET_PROFILE_INACTIVE_ASSIGNMENT_MSG });
        }

        if (fleetVehicle && isVehicleInspectionWorkflowActive(item)) {
            return res.status(400).json({
                message:
                    'Complete and approve the vehicle inspection handover before assigning or reassigning this vehicle.',
            });
        }

        // Check if this is a reassignment (asset was previously assigned, or assignee acknowledgment is still open)
        const isReassignment =
            (item.status === 'Assigned' || isAssetAssignmentAcknowledgmentPending(item)) &&
            (item.assignedTo || item.assignedCompany);
        const isParkingReassignment = false;

        if (isLeaveActive(item)) {
            return res.status(400).json({ message: ON_LEAVE_TRANSFER_BLOCKED_MESSAGE });
        }

        const isServiceReassignment =
            isServiceActive(item) && item.assignedToType === 'Employee' && !!item.assignedTo;
        const preserveServiceOnReassign = isServiceReassignment;
        let previousAssignee = null;
        let previousAssigneeType = null;
        let newAssignee = null;
        let newAssigneeType = assignedToType;

        // Store previous assignee info before updating
        if (isReassignment) {
            if (item.assignedToType === 'Company' && item.assignedCompany) {
                previousAssignee = item.assignedCompany;
                previousAssigneeType = 'Company';
            } else if (item.assignedToType === 'Employee' && item.assignedTo) {
                previousAssignee = item.assignedTo;
                previousAssigneeType = 'Employee';
            }
        }

        if (isServiceReassignment) {
            const preserveOnLeave = item.onLeaveActive === true;
            const oldAssignedToId = (item.assignedTo?._id || item.assignedTo)?.toString?.() || null;
            item.pendingActionDetails = {
                ...(item.pendingActionDetails || {}),
                serviceReassignContext: {
                    isServiceReassign: true,
                    preservedOnService: true,
                    preservedOnLeave: preserveOnLeave,
                    oldAssignedTo: oldAssignedToId,
                    oldAssignedBy: (item.assignedBy?._id || item.assignedBy)?.toString?.() || null,
                    oldAssignmentType: item.assignmentType || null,
                    oldAssignedDays: item.assignedDays ?? null,
                    oldAssignedDate: item.assignedDate || null,
                    oldTemporaryEndDate: item.temporaryEndDate || null,
                    oldTemporaryReminderSentAt: item.temporaryReminderSentAt || null,
                    oldTemporaryExpiredSentAt: item.temporaryExpiredSentAt || null,
                }
            };
        }

        if (isParkingReassignment) {
            const oldAssignedToId = (item.assignedTo?._id || item.assignedTo)?.toString?.() || null;
            item.pendingActionDetails = {
                ...(item.pendingActionDetails || {}),
                parkingReassignContext: {
                    isParkingReassign: true,
                    parkingSnapshot: snapshotParkingFields(item),
                    oldAssignedTo: oldAssignedToId,
                    oldAssignedBy: (item.assignedBy?._id || item.assignedBy)?.toString?.() || null,
                    oldAssignmentType: item.assignmentType || null,
                    oldAssignedDays: item.assignedDays ?? null,
                    oldAssignedDate: item.assignedDate || null,
                    oldTemporaryEndDate: item.temporaryEndDate || null,
                    oldTemporaryReminderSentAt: item.temporaryReminderSentAt || null,
                    oldTemporaryExpiredSentAt: item.temporaryExpiredSentAt || null,
                }
            };
        }

        const actingEmpObjectId = req.user.employeeObjectId?.toString?.() || null;

        const assetControllerHod = await getDepartmentHOD('assetcontroller');
        const assetControllerEmp = assetControllerHod
            ? await resolveAssetControllerEmployee(assetControllerHod)
            : null;

        let canAssign = false;
        let assigneeReassignRequest = false;
        if (fleetVehicle) {
            canAssign = await userCanAssignFleetVehicleAssets(req);
            const assigneeId = (item.assignedTo?._id || item.assignedTo)?.toString?.() || null;
            const isAssigneeActor =
                !!actingEmpObjectId && !!assigneeId && actingEmpObjectId === assigneeId;
            if (!canAssign && isReassignment && isAssigneeActor) {
                assigneeReassignRequest = true;
                canAssign = true;
            }
        } else {
            canAssign = await userCanAssignAssets(req, assetControllerEmp);
        }
        if (!canAssign) {
            return res.status(403).json({
                message: fleetVehicle
                    ? 'Only the flowchart Admin Officer can assign fleet vehicles.'
                    : 'Only Asset Controller or Administrator can assign assets.',
            });
        }

        if (assigneeReassignRequest) {
            const hrEmp = await getResolvedFleetHrEmployee();
            if (!hrEmp?._id) {
                return res.status(400).json({ message: 'No HR assignee configured in the flowchart.' });
            }
            if (item.pendingAction) {
                return res.status(400).json({
                    message: `This vehicle already has a pending "${item.pendingAction}" request.`,
                });
            }
            if (!actingEmpObjectId) {
                return res.status(403).json({ message: 'You are not linked to an employee profile.' });
            }
            const assigner = await EmployeeBasic.findById(actingEmpObjectId);
            if (!assigner?.signature?.url) {
                return res.status(403).json({
                    message: "Can't request reassign: Your signature has not been added to your profile.",
                });
            }
            if (assignedToType !== 'Employee' || !assignedTo) {
                return res.status(400).json({ message: 'Fleet reassign requests must target an employee.' });
            }
            if (!assignmentReason) {
                return res.status(400).json({ message: 'Assignment reason is required for vehicle reassignment.' });
            }

            item.pendingAction = 'Reassign Asset';
            item.pendingActionDetails = {
                reassignmentPayload: {
                    assignedTo,
                    assignedToType: 'Employee',
                    assignmentType,
                    assignedDays: assignedDays ?? null,
                    assignmentReason,
                },
                requestedBy: actingEmpObjectId,
                requestedAt: new Date(),
            };
            item.actionRequiredBy = hrEmp._id;
            item.status = 'Pending';
            await item.save();

            const requesterName =
                `${assigner.firstName || ''} ${assigner.lastName || ''}`.trim() || 'Employee';
            await DashboardAction.create({
                assignedTo: hrEmp._id,
                assignedToEmpId: hrEmp.employeeId,
                requestId: item._id,
                requestType: 'Asset Reassign',
                status: 'Pending',
                subjectEmployeeId: item.assignedTo?.employeeId || 'UNASSIGNED',
                subjectName: requesterName,
                requestedByName: requesterName,
                extra1: `${item.assetId} — ${item.name || ''}`,
                extra2: 'Reassign Asset',
            });

            try {
                await sendAssetActionApprovalEmail(
                    item,
                    'Reassign Asset',
                    hrEmp,
                    { name: requesterName },
                    '',
                    [],
                );
            } catch (e) {
                /* non-fatal */
            }

            await AssetHistory.create({
                assetId: item._id,
                action: 'Comment',
                performedBy: actingEmpObjectId,
                comments: assignmentReason || 'Fleet vehicle reassign request submitted for HR approval.',
                date: new Date(),
                details: { assignmentReason },
            });

            const updatedItem = await AssetItem.findById(id)
                .populate('assignedCompany')
                .populate({
                    path: 'assignedTo',
                    select: 'firstName lastName employeeId profilePicture companyEmail workEmail department dateOfJoining reportingAuthority primaryReportee enablePortalAccess',
                    populate: [
                        { path: 'reportingAuthority', select: 'firstName lastName' },
                        { path: 'primaryReportee', select: 'firstName lastName' },
                    ],
                })
                .populate({ path: 'assignedBy', select: 'firstName lastName employeeId signature' })
                .populate('typeId', 'name imagePreview')
                .populate('categoryId', 'name imagePreview');

            return res.status(200).json({
                message: 'Reassign request sent to HR for approval',
                asset: updatedItem,
            });
        }

        if (fleetVehicle && assignedToType === 'Employee' && !assignmentReason) {
            return res.status(400).json({ message: 'Assignment reason is required for vehicle handover.' });
        }

        // New assignments from the pool must start from Unassigned or Returned.
        if (
            !isReassignment &&
            !isServiceReassignment &&
            !isParkingReassignment &&
            !isAssignableFromPoolStatus(item.status)
        ) {
            return res.status(400).json({
                message: `Asset ${item.assetId || item._id} cannot be assigned from "${item.status}" status. Only Unassigned or Returned assets can be assigned from the pool.`,
            });
        }

        const wasAssignedFromPool =
            !isReassignment &&
            !isServiceReassignment &&
            !isParkingReassignment &&
            isAssignableFromPoolStatus(item.status);

        prepareAssetItemForPoolAssignment(item);

        if (!actingEmpObjectId) {
            return res.status(403).json({ message: "You are not linked to an employee profile." });
        }

        const assigner = await EmployeeBasic.findById(actingEmpObjectId);
        if (!assigner || !assigner.signature || !assigner.signature.url) {
            return res.status(403).json({ message: "Cant assign: Your signature has not been added to your profile." });
        }

        let actionRequiredBy = null;
        let actionRecipient = null;
        let subjectName = "";
        let subjectEmpId = "";
        let employeeToAssign = null;
        let fleetHandoverActor = null;
        let fleetHandoverHistoryId = null;
        let fleetAssignerActor = null;
        let fleetPreviousAssigneeEmp = null;
        let fleetAdminOfficerEmp = null;

        if (assignedToType === 'Company') {
            // Assigning to a Company
            const targetCompany = await Company.findById(assignedTo);
            if (!targetCompany) return res.status(404).json({ message: "Target company not found" });

            const companyCoordinatorRaw = await getCompanyAssetCoordinator();
            const companyCoordinator = companyCoordinatorRaw
                ? await resolveAssetControllerEmployee(companyCoordinatorRaw)
                : null;
            const coordinatorEmail = companyCoordinator ? pickEffectiveEmail(companyCoordinator) : null;

            if (!companyCoordinator?._id || !coordinatorEmail) {
                return res.status(400).json({
                    message:
                        'No Assigned User or Admin in Flowchart. Configure one in Settings → Flowchart before allocating to a company.',
                });
            }

            item.assignedToType = 'Company';
            item.assignedCompany = targetCompany._id;
            item.assignedTo = null;
            item.status = 'Pending';
            item.acceptanceStatus = 'Pending';
            item.actionRequiredBy = companyCoordinator._id;
            actionRequiredBy = companyCoordinator._id;

            actionRecipient = companyCoordinator;
            subjectName = targetCompany.name;
            subjectEmpId = targetCompany.companyId;
            newAssignee = targetCompany;

        } else {
            // Assigning to an Employee (Default)
            employeeToAssign = await EmployeeBasic.findById(assignedTo).select(
                'employeeId firstName lastName companyEmail workEmail personalEmail email primaryReportee department signature enablePortalAccess'
            ).populate({
                path: 'primaryReportee',
                select: '_id firstName lastName employeeId companyEmail workEmail',
            });
            if (!employeeToAssign) return res.status(404).json({ message: "Target employee not found" });

            if (fleetVehicle) {
                const hasLicense = await employeeHasDrivingLicense(employeeToAssign.employeeId);
                if (!hasLicense) {
                    return res.status(400).json({
                        message:
                            'The assigned employee must have a driving license on their profile before vehicle assignment.',
                    });
                }
            }

            item.assignedToType = 'Employee';
            item.assignedTo = assignedTo;
            item.assignedCompany = null;

            let resolvedActors;
            if (fleetVehicle) {
                fleetHandoverActor = await resolveFleetHandoverFirstActor(employeeToAssign);
                if (!fleetHandoverActor.actorId) {
                    return res.status(400).json({
                        message: 'Admin Officer is not configured in the flowchart for vehicle handover approval.',
                    });
                }
                let previousAssigneeEmp = null;
                if (isReassignment && previousAssigneeType === 'Employee' && previousAssignee) {
                    previousAssigneeEmp = await EmployeeBasic.findById(
                        previousAssignee._id || previousAssignee,
                    )
                        .select(
                            'firstName lastName employeeId companyEmail enablePortalAccess primaryReportee',
                        )
                        .lean();
                }
                fleetPreviousAssigneeEmp = previousAssigneeEmp;
                const adminOfficerForAssigner =
                    fleetHandoverActor.actorDoc || (await resolveAdminOfficerEmployee());
                fleetAdminOfficerEmp = adminOfficerForAssigner;
                fleetAssignerActor = await resolveFleetHandoverAssignerActor({
                    assigner,
                    previousAssignee: previousAssigneeEmp,
                    wasFromPool: wasAssignedFromPool,
                    adminOfficer: adminOfficerForAssigner,
                });
                const standardActors = await resolveEmployeeAssignmentActors(
                    employeeToAssign,
                    actingEmpObjectId,
                );
                resolvedActors = {
                    ...standardActors,
                    pendingActionActorId: fleetHandoverActor.actorId,
                    actionRecipientDoc: fleetHandoverActor.actorDoc,
                    autoAcceptOnAssign:
                        standardActors.autoAcceptOnAssign &&
                        fleetHandoverActor.assigneeCanSelfAcknowledge,
                };
            } else {
                resolvedActors = await resolveEmployeeAssignmentActors(
                    employeeToAssign,
                    actingEmpObjectId,
                );
            }
            let actionRecipientDoc = resolvedActors.actionRecipientDoc;

            if (
                !resolvedActors.assigneeCanSelfAcknowledge &&
                employeeToAssign.primaryReportee &&
                (!actionRecipientDoc?.employeeId ||
                    String(actionRecipientDoc._id || actionRecipientDoc) !==
                    String(resolvedActors.pendingActionActorId))
            ) {
                actionRecipientDoc = await EmployeeBasic.findById(resolvedActors.pendingActionActorId)
                    .select(
                        'employeeId firstName lastName companyEmail workEmail personalEmail email primaryReportee department',
                    )
                    .populate({
                        path: 'primaryReportee',
                        select: '_id firstName lastName employeeId companyEmail workEmail',
                    });
            }

            if (resolvedActors.autoAcceptOnAssign) {
                if (!employeeToAssign.signature?.url) {
                    return res.status(403).json({
                        message:
                            'Cannot assign: The employee must have a digital signature on their profile before direct assignment.',
                    });
                }
                applyAcceptedAssignmentState(item, employeeToAssign._id, {
                    preserveService: preserveServiceOnReassign,
                    preserveParking: isParkingReassignment,
                });
                if (isParkingReassignment) {
                    const snap = item.pendingActionDetails?.parkingReassignContext?.parkingSnapshot;
                    restoreParkingFields(item, snap);
                    item.onLeaveActive = true;
                }
                if (isServiceReassignment && item.pendingActionDetails?.serviceReassignContext?.preservedOnLeave) {
                    item.onLeaveActive = true;
                }
                actionRequiredBy = null;
            } else {
                item.acceptanceStatus = 'Pending';
                item.actionRequiredBy = resolvedActors.pendingActionActorId;
                actionRequiredBy = resolvedActors.pendingActionActorId;
                if (isServiceReassignment) {
                    item.onServiceActive = true;
                    if (item.pendingActionDetails?.serviceReassignContext?.preservedOnLeave) {
                        item.onLeaveActive = true;
                    }
                    item.status = 'Pending';
                } else if (isParkingReassignment) {
                    item.onLeaveActive = true;
                    item.status = 'Pending';
                } else {
                    item.status = 'Pending';
                }
            }

            actionRecipient = actionRecipientDoc;
            subjectName = `${employeeToAssign.firstName} ${employeeToAssign.lastName}`;
            subjectEmpId = employeeToAssign.employeeId;
            newAssignee = employeeToAssign;
        }

        item.assignedBy = req.user.employeeObjectId;
        if (!isParkingReassignment && !isServiceReassignment) {
            item.assignmentType = assignmentType;
            if (assignmentType === 'Temporary') {
                const parsedDays = Number(assignedDays);
                if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 60) {
                    return res.status(400).json({ message: 'Temporary duration must be an integer between 1 and 60 days.' });
                }
                item.assignedDays = parsedDays;
                item.assignedDate = null;
                item.temporaryEndDate = null;
                item.temporaryReminderSentAt = null;
                item.temporaryExpiredSentAt = null;
            } else {
                item.assignedDays = null;
                item.assignedDate = null;
                item.temporaryEndDate = null;
                item.temporaryReminderSentAt = null;
                item.temporaryExpiredSentAt = null;
            }
        } else if (isParkingReassignment) {
            item.onLeaveActive = true;
        }

        item.negotiationHistory = [];

        await item.save();

        if (
            fleetVehicle &&
            assignedToType === 'Employee' &&
            item.acceptanceStatus === 'Pending' &&
            actionRequiredBy
        ) {
            const historyRecord = await AssetHistory.create({
                assetId: item._id,
                action: 'Assigned',
                assignedToType: item.assignedToType,
                assignedTo: item.assignedTo,
                assignedCompany: item.assignedCompany,
                performedBy: req.user.employeeObjectId,
                comments: assignmentReason,
                details: {
                    assetId: item.assetId,
                    name: item.name,
                    status: item.status,
                    assignedToType: item.assignedToType,
                    assignedTo: item.assignedTo,
                    assignedBy: item.assignedBy,
                    assignmentReason,
                    assignmentType: item.assignmentType,
                    assignedDays: item.assignedDays ?? null,
                },
            });
            fleetHandoverHistoryId = historyRecord._id.toString();
            try {
                await seedPreviousHandoverReportsOnHistory({
                    historyId: fleetHandoverHistoryId,
                    assetId: item._id,
                });
            } catch (seedErr) {
                /* non-fatal */
            }
            item.pendingActionDetails = {
                ...(item.pendingActionDetails || {}),
                assignmentReason,
                vehicleHandoverFlow: {
                    stage: 'target',
                    historyId: fleetHandoverHistoryId,
                    assigneeCanSelfAcknowledge: fleetHandoverActor?.assigneeCanSelfAcknowledge ?? false,
                    pendingActorName: buildHandoverFlowPendingActorName(employeeToAssign, fleetHandoverActor),
                    escalation: buildInitialHandoverEscalationMeta(),
                },
            };
            await item.save();
        }

        const leanAssignResponse = {
            _id: item._id,
            assetId: item.assetId,
            name: item.name,
            status: item.status,
            assignmentType: item.assignmentType,
            assignedDays: item.assignedDays,
            assignedToType: item.assignedToType,
            assignedTo: item.assignedTo,
            assignedBy: item.assignedBy,
            assignedCompany: item.assignedCompany,
            acceptanceStatus: item.acceptanceStatus,
            actionRequiredBy: item.actionRequiredBy,
            pendingActionDetails: item.pendingActionDetails,
        };

        res.status(200).json(leanAssignResponse);

        void (async () => {
            let assignmentHistoryRecordId = null;
            let assignmentHistoryPdfKey = null;
            try {
                if (actionRequiredBy) {
                    try {
                        const dashboardPatch = {
                            assignedTo: actionRequiredBy,
                            assignedToEmpId: actionRecipient?.employeeId,
                            requestId: item._id,
                            requestType: 'Asset Assignment',
                            subjectEmployeeId: subjectEmpId,
                            subjectName: subjectName,
                            requestedByName: `${assigner?.firstName || "System"} ${assigner?.lastName || ""} `.trim(),
                            extra1: `${item.assetId} — ${item.name}`,
                            extra2: fleetVehicle && fleetHandoverHistoryId ? 'Vehicle Handover' : item.assignmentType,
                            status: 'Pending',
                        };
                        if (fleetVehicle && fleetHandoverHistoryId) {
                            dashboardPatch.extra3 = buildHandoverDashboardExtra3(item._id, fleetHandoverHistoryId, {
                                viewerRole: 'actor',
                            });
                        }
                        await DashboardAction.findOneAndUpdate(
                            {
                                requestId: item._id,
                                requestType: 'Asset Assignment',
                                status: 'Pending',
                                ...(fleetVehicle && fleetHandoverHistoryId
                                    ? { extra3: { $regex: '"handoverViewerRole"\\s*:\\s*"actor"', $options: 'i' } }
                                    : {}),
                            },
                            dashboardPatch,
                            { upsert: true, new: true, setDefaultsOnInsert: true },
                        );
                        await healDuplicatePendingAssignmentDashboardRows(item._id).catch(() => null);
                        if (fleetVehicle && fleetHandoverHistoryId && assigner?._id) {
                            await upsertHandoverAssignerDashboardAction({
                                asset: item,
                                assigner,
                                historyId: fleetHandoverHistoryId,
                                subjectName,
                                subjectEmpId,
                            }).catch(() => null);
                            const adminOfficer = fleetAdminOfficerEmp || (await resolveAdminOfficerEmployee());
                            if (adminOfficer?._id) {
                                await upsertHandoverAdminOfficerDashboardAction({
                                    asset: item,
                                    adminOfficer,
                                    historyId: fleetHandoverHistoryId,
                                    subjectName,
                                    subjectEmpId,
                                    stageLabel: 'Vehicle Handover — admin review required',
                                }).catch(() => null);
                            }
                            if (employeeToAssign?._id) {
                                const actorId = String(actionRequiredBy?._id || actionRequiredBy || '');
                                const assigneeId = String(employeeToAssign._id);
                                if (!actorId || assigneeId !== actorId) {
                                    await upsertHandoverTargetAssigneeDashboardAction({
                                        asset: item,
                                        assignee: employeeToAssign,
                                        historyId: fleetHandoverHistoryId,
                                        subjectName,
                                        subjectEmpId,
                                        assigner,
                                    }).catch(() => null);
                                }
                            }
                        }
                    } catch (err) {
                        /* non-fatal */
                    }
                }

                if (fleetVehicle && fleetHandoverHistoryId) {
                    try {
                        const workflowMeta = buildInitialHandoverWorkflowMeta({
                            assigneeCanSelfAcknowledge: fleetHandoverActor?.assigneeCanSelfAcknowledge ?? false,
                            assigner,
                            assignee: employeeToAssign,
                            firstActorDoc: fleetHandoverActor?.actorDoc,
                            assignerActorDoc: fleetAssignerActor?.actorDoc || assigner,
                            wasAssignedFromPool,
                            previousAssignee: fleetPreviousAssigneeEmp,
                            assignDate: new Date(),
                        });
                        await persistHandoverWorkflowMeta(fleetHandoverHistoryId, workflowMeta);

                        const snapshotForHistory = await AssetItem.findById(item._id)
                            .populate('categoryId typeId acceptedBy accessories assignedCompany')
                            .populate({
                                path: 'assignedTo',
                                select: 'firstName lastName employeeId department signature primaryReportee',
                                populate: [{ path: 'primaryReportee', select: 'firstName lastName employeeId' }],
                            })
                            .populate({ path: 'assignedBy', select: 'firstName lastName employeeId signature' });
                        if (snapshotForHistory) {
                            const existingHistory = await AssetHistory.findById(fleetHandoverHistoryId)
                                .select('details')
                                .lean();
                            const { handoverByDisplay, handoverToDisplay } = buildFleetHandoverDisplayLabels({
                                workflowMeta,
                                assigner,
                                assignee: employeeToAssign,
                                previousAssignee: fleetPreviousAssigneeEmp,
                                adminOfficer: fleetAdminOfficerEmp,
                            });
                            await AssetHistory.findByIdAndUpdate(fleetHandoverHistoryId, {
                                comments: assignmentReason || undefined,
                                details: {
                                    ...snapshotForHistory.toObject(),
                                    assignmentReason,
                                    assignmentType: item.assignmentType,
                                    assignedDays: item.assignedDays ?? null,
                                    ...(existingHistory?.details?.vehicleHandoverWorkflow
                                        ? {
                                              vehicleHandoverWorkflow:
                                                  existingHistory.details.vehicleHandoverWorkflow,
                                          }
                                        : {}),
                                    handoverLifecycleStatus: HANDOVER_LIFECYCLE.PENDING,
                                    handoverByDisplay,
                                    handoverToDisplay,
                                },
                            });
                        }
                    } catch (err) {
                        /* non-fatal */
                    }
                }

                if (!fleetHandoverHistoryId) {
                    try {
                        const snapshotItem = await AssetItem.findById(item._id)
                            .populate('categoryId typeId acceptedBy accessories assignedCompany')
                            .populate({
                                path: 'assignedTo',
                                select: 'firstName lastName employeeId department signature primaryReportee',
                                populate: [{ path: 'primaryReportee', select: 'firstName lastName employeeId' }],
                            })
                            .populate({ path: 'assignedBy', select: 'firstName lastName employeeId signature' });

                        const historyRecord = await AssetHistory.create({
                            assetId: item._id,
                            action: 'Assigned',
                            assignedToType: item.assignedToType,
                            assignedTo: item.assignedTo,
                            assignedCompany: item.assignedCompany,
                            performedBy: req.user.employeeObjectId,
                            comments: isParkingReassignment
                                ? 'Parking transfer: asset reassigned to new holder. On Leave remains active; parking duration unchanged.'
                                : isServiceReassignment
                                    ? 'On-service transfer: asset reassigned; onServiceActive preserved.'
                                    : undefined,
                            details: snapshotItem?.toObject?.() || {},
                        });
                        assignmentHistoryRecordId = historyRecord._id;
                    } catch (err) {
                        /* non-fatal */
                    }
                }

                await updateAssetTypeCounts(item.typeId).catch(() => null);
                if (isReassignment && previousAssignee && newAssignee) {
                    let reassignPdf = [];
                    try {
                        reassignPdf = await buildApprovedActionHandoverAttachments(
                            req,
                            item,
                            'reassignment-handover',
                        );
                    } catch (e) {
                        /* non-fatal */
                    }
                    await sendAssetReassignmentEmail({
                        asset: item,
                        previousAssignee,
                        newAssignee,
                        previousAssigneeType,
                        newAssigneeType,
                        attachments: reassignPdf,
                    });
                }

                const itemForEmail = await AssetItem.findById(item._id).populate('categoryId', 'name');
                let assignAttachments = [];

                try {
                    const hodFromReportee =
                        assignedToType === 'Company' ? null : actionRecipient?.primaryReportee;
                    const hodDisplay =
                        hodFromReportee && typeof hodFromReportee === 'object'
                            ? `${hodFromReportee.firstName || ''} ${hodFromReportee.lastName || ''}`.trim() ||
                            hodFromReportee.employeeId ||
                            '—'
                            : '—';
                    const deptDisplay =
                        assignedToType === 'Company'
                            ? '—'
                            : (actionRecipient?.department && String(actionRecipient.department).trim()) || '—';
                    const codeDisplay =
                        assignedToType === 'Company' ? subjectEmpId : actionRecipient?.employeeId || '—';

                    const handoverPdfCtx =
                        item.acceptanceStatus === 'Accepted'
                            ? buildFullySignedHandoverCtx({
                                assigner,
                                assignee: employeeToAssign,
                                assigneeName: subjectName,
                                employeeCode: codeDisplay,
                                department: deptDisplay,
                                hodName: hodDisplay,
                            })
                            : buildPendingRequestHandoverCtx({
                                assigner,
                                assigneeName: subjectName,
                                employeeCode: codeDisplay,
                                department: deptDisplay,
                                hodName: hodDisplay,
                            });
                    assignAttachments = await buildAssignmentHandoverEmailAttachments(req, [item._id.toString()], {
                        ...handoverPdfCtx,
                        assigner,
                        assignee: assignedToType === 'Employee' ? employeeToAssign : null,
                        filenameBase: `assignment-handover-${item.assetId || item._id}`,
                    });
                    const pdfBuf = assignAttachments[0]?.content;
                    if (pdfBuf?.length) {
                        assignmentHistoryPdfKey = await persistHandoverPdfBufferToHistory(
                            pdfBuf,
                            `assignment-${item.assetId || item._id}.pdf`,
                        );
                    }
                } catch (pdfErr) {
                    /* non-fatal */
                }

                const isDirectEmployeeAssign =
                    assignedToType === 'Employee' && item.acceptanceStatus === 'Accepted';

                if (isDirectEmployeeAssign) {
                    await sendAssetAssignmentEmail({
                        asset: itemForEmail || item,
                        employee: employeeToAssign,
                        recipient: employeeToAssign,
                        attachments: assignAttachments,
                    }).catch(() => null);

                    const assetController = fleetVehicle
                        ? await getResolvedFleetHrEmployee()
                        : await getDepartmentHOD('assetcontroller').catch(() => null);
                    if (assetController) {
                        await sendAssetControllerDirectAssignmentRecordEmail({
                            assetControllerEmployee: assetController,
                            assigneeEmployee: employeeToAssign,
                            assignerEmployee: assigner,
                            attachments: assignAttachments,
                            assetSummaryLines: [
                                `${itemForEmail?.assetId || item.assetId} — ${itemForEmail?.name || item.name}`,
                            ],
                        }).catch(() => null);
                    }
                } else {
                    await sendAssetAssignmentEmail({
                        asset: itemForEmail || item,
                        employee:
                            assignedToType === 'Company'
                                ? { firstName: subjectName, lastName: '', isCompany: true }
                                : employeeToAssign,
                        recipient: actionRecipient,
                        attachments: assignAttachments,
                        pendingAssignment: true,
                        detailsPath:
                            fleetVehicle && fleetHandoverHistoryId
                                ? buildHandoverAssignDetailsUrl(item._id, fleetHandoverHistoryId)
                                : null,
                        stageLabel: fleetVehicle ? 'Target User / Admin Officer' : null,
                    });

                    const assigneeId = employeeToAssign?._id?.toString?.();
                    const recipientId = actionRecipient?._id?.toString?.();
                    if (assignedToType === 'Employee' && assigneeId && recipientId && assigneeId !== recipientId) {
                        await sendAssetAssignmentEmail({
                            asset: itemForEmail || item,
                            employee: employeeToAssign,
                            recipient: employeeToAssign,
                            attachments: assignAttachments,
                            pendingAssignment: true,
                            detailsPath:
                                fleetVehicle && fleetHandoverHistoryId
                                    ? buildHandoverAssignDetailsUrl(item._id, fleetHandoverHistoryId)
                                    : null,
                            stageLabel: fleetVehicle ? 'Vehicle Handover — assigned to you' : null,
                        }).catch(() => null);
                    }

                    if (fleetVehicle && fleetHandoverHistoryId) {
                        const adminOfficer = fleetAdminOfficerEmp || (await resolveAdminOfficerEmployee().catch(() => null));
                        const adminId = adminOfficer?._id?.toString?.();
                        if (adminOfficer?._id && adminId !== recipientId) {
                            await notifyHandoverStageEmail({
                                asset: itemForEmail || item,
                                employee: employeeToAssign,
                                recipient: adminOfficer,
                                stageLabel: 'Admin Officer — vehicle handover review',
                                historyId: fleetHandoverHistoryId,
                            }).catch(() => null);
                        }
                    }
                }

                if (isReassignment && newAssignee) {
                    const skipIds = [actionRecipient?._id, employeeToAssign?._id].filter(Boolean).map(String);
                    const coordinatorForTransfer =
                        assignedToType === 'Company' ? await getCompanyAssetCoordinator().catch(() => null) : null;
                    await sendAssetTransferHandoverEmails({
                        req,
                        asset: itemForEmail || item,
                        assetIds: [item._id.toString()],
                        targetEmployee: assignedToType === 'Company' ? null : employeeToAssign,
                        targetCompany: assignedToType === 'Company' ? newAssignee : null,
                        assignedToType,
                        senderEmployeeId: req.user.employeeObjectId,
                        companyCoordinator: coordinatorForTransfer,
                        skipRecipientIds: skipIds,
                    }).catch(() => null);
                }

                const pdfHistoryId = fleetHandoverHistoryId || assignmentHistoryRecordId;
                if (assignmentHistoryPdfKey && pdfHistoryId) {
                    await AssetHistory.findByIdAndUpdate(pdfHistoryId, {
                        file: assignmentHistoryPdfKey,
                    }).catch(() => null);
                }
            } catch (postAssignErr) {
                console.error('Post-assignment notifications failed:', postAssignErr);
            }
        })();
    } catch (error) {
        console.error('assignAssetItem error:', error);
        res.status(500).json({ message: error?.message || 'Server Error' });
    }
};

// @desc    Bulk assign asset items to an employee
// @route   PUT /api/AssetItem/bulk/assign
// @access  Private
export const bulkAssignAssetItems = async (req, res) => {
    try {
        const { assetIds, assignedTo, assignmentType, assignedDays } = req.body;

        const assetController = await getDepartmentHOD('assetcontroller');
        if (!assetController) {
            return res.status(403).json({
                message: "Bulk assignment denied: No Asset Controller has been assigned in the organization flow. Please assign an Asset Controller in Settings > Flowchart before performing this operation."
            });
        }

        const assetControllerEmp = await resolveAssetControllerEmployee(assetController);
        const canAssign = await userCanAssignAssets(req, assetControllerEmp);
        if (!canAssign) {
            return res.status(403).json({ message: 'Only Asset Controller or Administrator can assign assets.' });
        }

        if (!assetIds || !Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ message: 'No assets selected' });
        }
        if (!assignedTo || !assignmentType) {
            return res.status(400).json({ message: 'Employee and assignment type are required' });
        }

        // Check if assigner (current user) has a signature
        if (!req.user.employeeObjectId) {
            return res.status(403).json({ message: "You are not linked to an employee profile." });
        }

        const assigner = await EmployeeBasic.findById(req.user.employeeObjectId);
        if (!assigner || !assigner.signature || !assigner.signature.url) {
            return res.status(403).json({ message: "cant you cant assign u r signator not added" });
        }

        const employeeToAssign = await EmployeeBasic.findById(assignedTo).select(
            'employeeId companyEmail workEmail personalEmail email primaryReportee firstName lastName department signature enablePortalAccess'
        ).populate({ path: 'primaryReportee', select: '_id firstName lastName employeeId companyEmail workEmail' });
        if (!employeeToAssign) {
            return res.status(404).json({ message: 'Target employee not found' });
        }

        const resolvedActors = await resolveEmployeeAssignmentActors(
            employeeToAssign,
            req.user.employeeObjectId,
        );
        const pendingActionActorId = resolvedActors.pendingActionActorId;
        const autoAcceptOnAssign = resolvedActors.autoAcceptOnAssign;

        if (autoAcceptOnAssign && !employeeToAssign.signature?.url) {
            return res.status(403).json({
                message:
                    'Cannot assign: The employee must have a digital signature on their profile before direct assignment.',
            });
        }

        const empName = `${employeeToAssign?.firstName || ''} ${employeeToAssign?.lastName || ''}`.trim() || 'Unknown Employee';

        const updateData = {
            assignedTo,
            assignedToType: 'Employee',
            assignedCompany: null,
            assignedBy: req.user.employeeObjectId,
            assignmentType,
            assignedDays: null,
            assignedDate: null,
            temporaryEndDate: null,
            temporaryReminderSentAt: null,
            temporaryExpiredSentAt: null,
            ownership: empName,
            negotiationHistory: []
        };

        if (assignmentType === 'Temporary') {
            const parsedDays = Number(assignedDays);
            if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 60) {
                return res.status(400).json({ message: 'Temporary duration must be an integer between 1 and 60 days.' });
            }
            updateData.assignedDays = parsedDays;
        }

        if (autoAcceptOnAssign) {
            const start = new Date();
            Object.assign(updateData, {
                status: 'Assigned',
                acceptanceStatus: 'Accepted',
                actionRequiredBy: null,
                acceptedBy: assignedTo,
                assignedDate: start,
            });
            if (assignmentType === 'Temporary' && updateData.assignedDays) {
                const end = new Date(start);
                end.setDate(end.getDate() + updateData.assignedDays);
                updateData.temporaryEndDate = end;
            }
        } else {
            Object.assign(updateData, {
                status: 'Pending',
                acceptanceStatus: 'Pending',
                actionRequiredBy: pendingActionActorId,
            });
            if (assignmentType === 'Temporary') {
                updateData.assignedDate = null;
                updateData.temporaryEndDate = null;
            }
        }

        const actionRequiredBy = autoAcceptOnAssign ? null : pendingActionActorId;

        const existingItems = await AssetItem.find({ _id: { $in: assetIds } }).select('status assetId');
        if (existingItems.length !== assetIds.length) {
            return res.status(400).json({ message: 'One or more assets were not found.' });
        }
        const notAssignable = existingItems.filter((doc) => !isAssignableFromPoolStatus(doc.status));
        if (notAssignable.length > 0) {
            const ids = notAssignable.map((d) => `${d.assetId || d._id} (${d.status})`).join(', ');
            return res.status(400).json({
                message: `Bulk assign is only allowed for Unassigned or Returned assets. Not assignable: ${ids}`,
            });
        }

        const bulkAssignmentGroupId = new mongoose.Types.ObjectId();
        const assetIdStrings = assetIds.map((id) => String(id));

        let bulkAssignmentAttachments = [];
        let bulkAssignmentHandoverS3Key = null;

        try {
            const hodFromReportee = employeeToAssign.primaryReportee;
            const hodDisplay =
                hodFromReportee && typeof hodFromReportee === 'object'
                    ? `${hodFromReportee.firstName || ''} ${hodFromReportee.lastName || ''}`.trim() ||
                    hodFromReportee.employeeId ||
                    '—'
                    : '—';
            const bulkHandoverPdfCtx = autoAcceptOnAssign
                ? buildFullySignedHandoverCtx({
                    assigner,
                    assignee: employeeToAssign,
                    assigneeName: empName,
                    employeeCode: employeeToAssign.employeeId || '—',
                    department: (employeeToAssign.department && String(employeeToAssign.department).trim()) || '—',
                    hodName: hodDisplay,
                })
                : buildPendingRequestHandoverCtx({
                    assigner,
                    assigneeName: empName,
                    employeeCode: employeeToAssign.employeeId || '—',
                    department: (employeeToAssign.department && String(employeeToAssign.department).trim()) || '—',
                    hodName: hodDisplay,
                });
            bulkAssignmentAttachments = await buildAssignmentHandoverEmailAttachments(
                req,
                assetIdStrings,
                {
                    ...bulkHandoverPdfCtx,
                    assigner,
                    assignee: employeeToAssign,
                    filenameBase: 'bulk-assignment-handover',
                },
            );
            if (!bulkAssignmentAttachments?.length) {
                bulkAssignmentAttachments = await requireBulkAssignmentHandoverPdfAttachment(
                    req,
                    assetIdStrings,
                    await finalizeHandoverPdfCtx(bulkHandoverPdfCtx, {
                        assigner,
                        assignee: employeeToAssign,
                    }),
                    'bulk-assignment-handover',
                );
            }
            if (bulkAssignmentAttachments[0]?.content) {
                bulkAssignmentHandoverS3Key = await persistHandoverPdfBufferToHistory(
                    bulkAssignmentAttachments[0].content,
                    `bulk-assignment-${bulkAssignmentGroupId}.pdf`,
                );
            }
        } catch (pdfErr) {
            return res.status(503).json({
                message:
                    pdfErr?.message ||
                    'Could not generate the assignment handover PDF. Assignment was not saved. Try again or contact support.',
            });
        }

        for (const aid of assetIds) {
            let revertToEmployeeId = null;
            let revertToDisplayName = null;
            const lastAssign = await AssetHistory.findOne({
                assetId: aid,
                action: { $in: ['Assigned', 'Accepted'] }
            })
                .sort({ date: -1 })
                .select('assignedTo')
                .lean();
            if (
                lastAssign?.assignedTo &&
                String(lastAssign.assignedTo) !== String(assignedTo)
            ) {
                revertToEmployeeId = lastAssign.assignedTo;
                const prevEmp = await EmployeeBasic.findById(revertToEmployeeId)
                    .select('firstName lastName')
                    .lean();
                if (prevEmp) {
                    revertToDisplayName = `${prevEmp.firstName || ''} ${prevEmp.lastName || ''}`.trim();
                }
            }

            const setPayload = {
                ...updateData,
                pendingActionDetails: {
                    bulkAssignment: {
                        groupId: bulkAssignmentGroupId.toString(),
                        assetIds: assetIdStrings,
                        revertToEmployeeId,
                        revertToDisplayName,
                    },
                },
            };

            await AssetItem.updateOne(
                { _id: aid },
                { $set: setPayload },
            );
        }

        // One dashboard / inbox row for the whole bulk batch — skip when auto-accepted on assign
        if (actionRequiredBy) {
            try {
                const dashboardActor = await EmployeeBasic.findById(pendingActionActorId).select(
                    'employeeId firstName lastName',
                );
                const subjectEmp = await EmployeeBasic.findById(assignedTo).select('employeeId firstName lastName');
                const assets = await AssetItem.find({ _id: { $in: assetIds } }).select('assetId name assignmentType');

                if (assetIds.length > 1) {
                    await supersedeOverlappingPendingBulkAssignmentRows(
                        assetIdStrings,
                        req.user.employeeObjectId,
                    );
                    await DashboardAction.create({
                        assignedTo: actionRequiredBy,
                        assignedToEmpId: dashboardActor?.employeeId,
                        requestId: assetIds[0],
                        requestType: 'Asset',
                        subjectEmployeeId: subjectEmp?.employeeId,
                        subjectName: `${subjectEmp?.firstName || ''} ${subjectEmp?.lastName || ''}`.trim(),
                        requestedByName: `${assigner?.firstName || 'System'} ${assigner?.lastName || ''}`.trim(),
                        extra1: `Bulk assignment (${assetIds.length} assets)`,
                        extra2: assignmentType,
                        extra3: JSON.stringify({
                            isBulkAssignment: true,
                            bulkAssignmentGroupId: bulkAssignmentGroupId.toString(),
                            bulkAssetIds: assetIdStrings,
                        }),
                        status: 'Pending',
                    });
                } else if (assets.length === 1) {
                    const one = assets[0];
                    await DashboardAction.create({
                        assignedTo: actionRequiredBy,
                        assignedToEmpId: dashboardActor?.employeeId,
                        requestId: one._id,
                        requestType: 'Asset',
                        subjectEmployeeId: subjectEmp?.employeeId,
                        subjectName: `${subjectEmp?.firstName || ''} ${subjectEmp?.lastName || ''}`.trim(),
                        requestedByName: `${assigner?.firstName || 'System'} ${assigner?.lastName || ''}`.trim(),
                        extra1: `${one.assetId} - ${one.name} `,
                        extra2: one.assignmentType,
                        status: 'Pending',
                    });
                }
            } catch (err) {
            }
        }

        // Log history for each asset with Snapshot
        const populatedAssets = await AssetItem.find({ _id: { $in: assetIds } })
            .populate('categoryId typeId acceptedBy accessories')
            .populate({
                path: 'assignedTo',
                populate: [
                    { path: 'primaryReportee', select: 'firstName lastName employeeId' },
                    { path: 'reportingAuthority', select: 'firstName lastName employeeId' }
                ]
            })
            .populate({ path: 'assignedBy', select: 'firstName lastName employeeId signature' });

        const historyEntries = populatedAssets.map(asset => ({
            assetId: asset._id,
            action: 'Assigned',
            assignedTo,
            performedBy: req.user.employeeObjectId,
            date: new Date(),
            details: asset.toObject(),
            ...(bulkAssignmentHandoverS3Key ? { file: bulkAssignmentHandoverS3Key } : {}),
        }));
        await AssetHistory.insertMany(historyEntries);

        // Update counts for all unique typeIds affected
        const items = await AssetItem.find({ _id: { $in: assetIds } }).select('typeId');
        const uniqueTypeIds = [...new Set(items.map(i => i.typeId.toString()))];

        for (const typeId of uniqueTypeIds) {
            await updateAssetTypeCounts(typeId);
        }

        // Assignment email (pending request vs AC direct-assign with both signatures)
        try {
            const assetsForEmail = await AssetItem.find({ _id: { $in: assetIds } })
                .populate('categoryId', 'name')
                .lean();
            const orderMap = new Map(assetIds.map((id, i) => [String(id), i]));
            assetsForEmail.sort((a, b) => (orderMap.get(String(a._id)) ?? 0) - (orderMap.get(String(b._id)) ?? 0));

            const firstAsset = await AssetItem.findById(assetIds[0]).populate('categoryId');
            const assetSummaryLines = assetsForEmail.map(
                (a) => `${a.assetId} — ${a.name}`,
            );

            if (employeeToAssign && firstAsset) {
                if (autoAcceptOnAssign) {
                    await sendAssetAssignmentEmail({
                        asset: firstAsset,
                        assets: assetsForEmail,
                        employee: employeeToAssign,
                        recipient: employeeToAssign,
                        isBulk: true,
                        assetCount: assetIds.length,
                        attachments: bulkAssignmentAttachments,
                        bulkAssignmentGroupId: bulkAssignmentGroupId.toString(),
                    });

                    if (assetController) {
                        await sendAssetControllerDirectAssignmentRecordEmail({
                            assetControllerEmployee: assetController,
                            assigneeEmployee: employeeToAssign,
                            assignerEmployee: assigner,
                            attachments: bulkAssignmentAttachments,
                            isBulk: true,
                            assetCount: assetIds.length,
                            assetSummaryLines,
                        });
                    }
                } else {
                    const emailRecipient = await EmployeeBasic.findById(pendingActionActorId).select(
                        'employeeId firstName lastName companyEmail workEmail personalEmail email primaryReportee',
                    ).populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail');
                    await sendAssetAssignmentEmail({
                        asset: firstAsset,
                        assets: assetsForEmail,
                        employee: employeeToAssign,
                        recipient: emailRecipient || employeeToAssign,
                        isBulk: true,
                        assetCount: assetIds.length,
                        attachments: bulkAssignmentAttachments,
                        bulkAssignmentGroupId: bulkAssignmentGroupId.toString(),
                        pendingAssignment: true,
                    });

                    const assigneeId = employeeToAssign?._id?.toString?.();
                    const recipientId = emailRecipient?._id?.toString?.();
                    if (assigneeId && recipientId && assigneeId !== recipientId) {
                        await sendAssetAssignmentEmail({
                            asset: firstAsset,
                            assets: assetsForEmail,
                            employee: employeeToAssign,
                            recipient: employeeToAssign,
                            isBulk: true,
                            assetCount: assetIds.length,
                            attachments: bulkAssignmentAttachments,
                            bulkAssignmentGroupId: bulkAssignmentGroupId.toString(),
                            pendingAssignment: true,
                        }).catch(() => null);
                    }
                }
            }
        } catch (emailErr) {
        }

        res.status(200).json({
            message: `${assetIds.length} assets assigned successfully`,
            bulkAssignmentGroupId: bulkAssignmentGroupId.toString()
        });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Bulk assign asset items to a company (one inbox notification for the batch)
// @route   PUT /api/AssetItem/bulk/assign-company
// @access  Private
export const bulkAssignAssetItemsToCompany = async (req, res) => {
    try {
        const { assetIds, assignedTo, assignmentType, assignedDays } = req.body;

        const assetController = await getDepartmentHOD('assetcontroller');
        if (!assetController) {
            return res.status(403).json({
                message:
                    'Bulk assignment denied: No Asset Controller has been assigned in the organization flow. Please assign an Asset Controller in Settings > Flowchart before performing this operation.',
            });
        }

        const assetControllerEmp = await resolveAssetControllerEmployee(assetController);
        const canAssign = await userCanAssignAssets(req, assetControllerEmp);
        if (!canAssign) {
            return res.status(403).json({ message: 'Only Asset Controller or Administrator can assign assets.' });
        }

        if (!assetIds || !Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ message: 'No assets selected' });
        }
        if (!assignedTo || !assignmentType) {
            return res.status(400).json({ message: 'Company and assignment type are required' });
        }

        if (!req.user.employeeObjectId) {
            return res.status(403).json({ message: 'You are not linked to an employee profile.' });
        }

        const assigner = await EmployeeBasic.findById(req.user.employeeObjectId);
        if (!assigner?.signature?.url) {
            return res.status(403).json({ message: 'cant you cant assign u r signator not added' });
        }

        const targetCompany = await Company.findById(assignedTo).select('name companyId');
        if (!targetCompany) {
            return res.status(404).json({ message: 'Target company not found' });
        }

        const companyCoordinatorRaw = await getCompanyAssetCoordinator();
        const companyCoordinator = companyCoordinatorRaw
            ? await resolveAssetControllerEmployee(companyCoordinatorRaw)
            : null;
        const coordinatorEmail = companyCoordinator ? pickEffectiveEmail(companyCoordinator) : null;
        if (!companyCoordinator?._id || !coordinatorEmail) {
            return res.status(400).json({
                message:
                    'No Assigned User or Admin in Flowchart. Configure one in Settings → Flowchart before allocating to a company.',
            });
        }

        const companyName = targetCompany.name || 'Company';
        const updateData = {
            assignedTo: null,
            assignedToType: 'Company',
            assignedCompany: targetCompany._id,
            assignedBy: req.user.employeeObjectId,
            assignmentType,
            assignedDays: null,
            assignedDate: null,
            temporaryEndDate: null,
            temporaryReminderSentAt: null,
            temporaryExpiredSentAt: null,
            ownership: companyName,
            negotiationHistory: [],
            status: 'Pending',
            acceptanceStatus: 'Pending',
            actionRequiredBy: companyCoordinator._id,
        };

        if (assignmentType === 'Temporary') {
            const parsedDays = Number(assignedDays);
            if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 60) {
                return res.status(400).json({ message: 'Temporary duration must be an integer between 1 and 60 days.' });
            }
            updateData.assignedDays = parsedDays;
        }

        const existingItems = await AssetItem.find({ _id: { $in: assetIds } }).select('status assetId');
        if (existingItems.length !== assetIds.length) {
            return res.status(400).json({ message: 'One or more assets were not found.' });
        }
        const notAssignable = existingItems.filter((doc) => !isAssignableFromPoolStatus(doc.status));
        if (notAssignable.length > 0) {
            const ids = notAssignable.map((d) => `${d.assetId || d._id} (${d.status})`).join(', ');
            return res.status(400).json({
                message: `Bulk assign is only allowed for Unassigned or Returned assets. Not assignable: ${ids}`,
            });
        }

        const bulkAssignmentGroupId = new mongoose.Types.ObjectId();
        const assetIdStrings = assetIds.map((id) => String(id));
        const actionRequiredBy = companyCoordinator._id;

        let bulkAssignmentAttachments = [];
        let bulkAssignmentHandoverS3Key = null;

        try {
            const bulkHandoverPdfCtx = buildPendingRequestHandoverCtx({
                assigner,
                assigneeName: companyName,
                employeeCode: targetCompany.companyId || '—',
                department: '—',
                hodName: '—',
            });
            bulkAssignmentAttachments = await buildAssignmentHandoverEmailAttachments(req, assetIdStrings, {
                ...bulkHandoverPdfCtx,
                assigner,
                assignee: null,
                filenameBase: 'bulk-company-assignment-handover',
            });
            if (!bulkAssignmentAttachments?.length) {
                bulkAssignmentAttachments = await requireBulkAssignmentHandoverPdfAttachment(
                    req,
                    assetIdStrings,
                    await finalizeHandoverPdfCtx(bulkHandoverPdfCtx, { assigner, assignee: null }),
                    'bulk-company-assignment-handover',
                );
            }
            if (bulkAssignmentAttachments[0]?.content) {
                bulkAssignmentHandoverS3Key = await persistHandoverPdfBufferToHistory(
                    bulkAssignmentAttachments[0].content,
                    `bulk-company-assignment-${bulkAssignmentGroupId}.pdf`,
                );
            }
        } catch (pdfErr) {
            return res.status(503).json({
                message:
                    pdfErr?.message ||
                    'Could not generate the assignment handover PDF. Assignment was not saved. Try again or contact support.',
            });
        }

        for (const aid of assetIds) {
            await AssetItem.updateOne(
                { _id: aid },
                {
                    $set: {
                        ...updateData,
                        pendingActionDetails: {
                            bulkAssignment: {
                                groupId: bulkAssignmentGroupId.toString(),
                                assetIds: assetIdStrings,
                                assignedToType: 'Company',
                                companyId: String(targetCompany._id),
                            },
                        },
                    },
                },
            );
        }

        try {
            const assets = await AssetItem.find({ _id: { $in: assetIds } }).select('assetId name assignmentType');
            if (assetIds.length > 1) {
                await supersedeOverlappingPendingBulkAssignmentRows(assetIdStrings, req.user.employeeObjectId);
                await DashboardAction.create({
                    assignedTo: actionRequiredBy,
                    assignedToEmpId: companyCoordinator.employeeId,
                    requestId: assetIds[0],
                    requestType: 'Asset',
                    subjectEmployeeId: targetCompany.companyId,
                    subjectName: companyName,
                    requestedByName: `${assigner?.firstName || 'System'} ${assigner?.lastName || ''}`.trim(),
                    extra1: `Bulk company assignment (${assetIds.length} assets)`,
                    extra2: assignmentType,
                    extra3: JSON.stringify({
                        isBulkAssignment: true,
                        bulkAssignmentGroupId: bulkAssignmentGroupId.toString(),
                        bulkAssetIds: assetIdStrings,
                        assignedToType: 'Company',
                        companyId: String(targetCompany._id),
                    }),
                    status: 'Pending',
                });
            } else if (assets.length === 1) {
                const one = assets[0];
                await DashboardAction.findOneAndUpdate(
                    {
                        requestId: one._id,
                        requestType: 'Asset Assignment',
                        status: 'Pending',
                    },
                    {
                        assignedTo: actionRequiredBy,
                        assignedToEmpId: companyCoordinator.employeeId,
                        requestId: one._id,
                        requestType: 'Asset Assignment',
                        subjectEmployeeId: targetCompany.companyId,
                        subjectName: companyName,
                        requestedByName: `${assigner?.firstName || 'System'} ${assigner?.lastName || ''}`.trim(),
                        extra1: `${one.assetId} — ${one.name}`,
                        extra2: one.assignmentType,
                        status: 'Pending',
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true },
                );
                await healDuplicatePendingAssignmentDashboardRows(one._id).catch(() => null);
            }
        } catch (err) {
        }

        const populatedAssets = await AssetItem.find({ _id: { $in: assetIds } })
            .populate('categoryId typeId acceptedBy accessories assignedCompany')
            .populate({ path: 'assignedBy', select: 'firstName lastName employeeId signature' });

        const historyEntries = populatedAssets.map((asset) => ({
            assetId: asset._id,
            action: 'Assigned',
            assignedToType: 'Company',
            assignedCompany: asset.assignedCompany,
            performedBy: req.user.employeeObjectId,
            date: new Date(),
            details: asset.toObject(),
            ...(bulkAssignmentHandoverS3Key ? { file: bulkAssignmentHandoverS3Key } : {}),
        }));
        await AssetHistory.insertMany(historyEntries);

        const items = await AssetItem.find({ _id: { $in: assetIds } }).select('typeId');
        const uniqueTypeIds = [...new Set(items.map((i) => i.typeId.toString()))];
        for (const typeId of uniqueTypeIds) {
            await updateAssetTypeCounts(typeId);
        }

        try {
            const assetsForEmail = await AssetItem.find({ _id: { $in: assetIds } })
                .populate('categoryId', 'name')
                .lean();
            const orderMap = new Map(assetIds.map((id, i) => [String(id), i]));
            assetsForEmail.sort((a, b) => (orderMap.get(String(a._id)) ?? 0) - (orderMap.get(String(b._id)) ?? 0));
            const firstAsset = await AssetItem.findById(assetIds[0]).populate('categoryId');

            if (firstAsset) {
                await sendAssetAssignmentEmail({
                    asset: firstAsset,
                    assets: assetsForEmail,
                    employee: { firstName: companyName, lastName: '', isCompany: true },
                    recipient: companyCoordinator,
                    isBulk: assetIds.length > 1,
                    assetCount: assetIds.length,
                    attachments: bulkAssignmentAttachments,
                    bulkAssignmentGroupId: bulkAssignmentGroupId.toString(),
                    pendingAssignment: true,
                });
            }
        } catch (emailErr) {
        }

        res.status(200).json({
            message: `${assetIds.length} assets assigned to ${companyName} successfully`,
            bulkAssignmentGroupId: bulkAssignmentGroupId.toString(),
        });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Download Historical Asset Handover Form PDF
// @route   GET /api/AssetItem/history-handover-pdf/:historyId
// @access  Private
export const downloadHistoryHandoverPdf = async (req, res) => {
    try {
        const { historyId } = req.params;

        const history = await AssetHistory.findById(historyId);
        if (!history || !history.details) {
            return res.status(404).json({ message: 'History record or snapshot not found' });
        }

        const assetSnapshot = history.details;

        // URL to the frontend print page
        const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
        const baseUrl = resolveFrontendBaseUrl(req);

        // We pass the historyId to the print page so it knows to fetch data from history instead of current asset
        const printUrl = `${baseUrl}/print/asset-handover/${assetSnapshot._id}?historyId=${historyId}`;


        const token = req.headers.authorization?.split(' ')[1] || '';
        const requestingUserId = req.user?.id;
        const userObj = await User.findById(requestingUserId);

        const userPayload = {
            id: requestingUserId,
            isAdmin: isJwtSystemSuperUser(userObj),
            role: userObj?.role,
            employeeId: userObj?.employeeId
        };

        const pdfBuffer = await generatePdf(printUrl, token, userPayload, {}, ASSET_HANDOVER_PDF_SELECTOR);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Historical-Handover-${assetSnapshot.assetId}.pdf"`);
        res.send(pdfBuffer);

    } catch (error) {
        res.status(500).json({ message: 'Failed to generate historical PDF', error: error.message });
    }
};

// @desc    Download fleet vehicle handover form PDF (filled VehicleHandoverFormView)
// @route   GET /api/AssetItem/vehicle-handover-pdf/:vehicleId?historyId=
// @access  Private
export const downloadVehicleHandoverPdf = async (req, res) => {
    try {
        const { vehicleId } = req.params;
        const historyId = String(req.query.historyId || '').trim();

        if (!historyId) {
            return res.status(400).json({ message: 'historyId query parameter is required.' });
        }

        const history = await AssetHistory.findById(historyId).select('assetId action').lean();
        if (!history) {
            return res.status(404).json({ message: 'History record not found' });
        }
        if (String(history.assetId) !== String(vehicleId)) {
            return res.status(400).json({ message: 'History record does not belong to this vehicle.' });
        }

        const asset = await AssetItem.findById(vehicleId).select('assetId name').lean();
        if (!asset) {
            return res.status(404).json({ message: 'Vehicle not found' });
        }

        const baseUrl = resolveFrontendBaseUrl(req);
        const printUrl = `${baseUrl}/print/vehicle-handover/${vehicleId}?historyId=${encodeURIComponent(historyId)}`;

        const token = req.headers.authorization?.split(' ')[1] || '';
        const requestingUserId = req.user?.id;
        const userObj = await User.findById(requestingUserId);
        const userPayload = {
            id: requestingUserId,
            isAdmin: isJwtSystemSuperUser(userObj),
            role: userObj?.role,
            employeeId: userObj?.employeeId,
        };

        const pdfBuffer = await generatePdf(printUrl, token, userPayload, {}, VEHICLE_HANDOVER_PDF_SELECTOR);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="Vehicle-Handover-${asset.assetId || vehicleId}.pdf"`,
        );
        res.send(pdfBuffer);
    } catch (error) {
        res.status(500).json({ message: 'Failed to generate vehicle handover PDF', error: error.message });
    }
};

// @desc    Download Asset Handover Form PDF
// @route   GET /api/AssetItem/handover-pdf/:id
// @access  Private
export const downloadHandoverPdf = async (req, res) => {
    try {
        const { id } = req.params;

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // URL to the frontend print page we created
        const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
        const baseUrl = resolveFrontendBaseUrl(req);
        const printUrl = `${baseUrl}/print/asset-handover/${id}`;


        const token = req.headers.authorization?.split(' ')[1] || '';

        // Prepare user payload for Puppeteer auth
        const requestingUserId = req.user?.id;
        const userObj = await User.findById(requestingUserId);

        const userPayload = {
            id: requestingUserId,
            isAdmin: isJwtSystemSuperUser(userObj),
            role: userObj?.role,
            employeeId: userObj?.employeeId
        };

        const permissions = {}; // Default permissions

        const pdfBuffer = await generatePdf(printUrl, token, userPayload, permissions, ASSET_HANDOVER_PDF_SELECTOR);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="HandoverForm-${asset.assetId}.pdf"`);
        res.send(pdfBuffer);

    } catch (error) {
        res.status(500).json({ message: 'Failed to generate PDF', error: error.message });
    }
};

// @desc    Respond to asset assignment (Accept/Reject/Negotiate)
// @route   PUT /api/AssetItem/:id/respond
// @access  Private (Assigned User or Assigner)
export const respondToAssignment = async (req, res) => {
    try {
        const { id } = req.params;
        const { action, comments, handoverFineId, handoverFineIds } = req.body; // action: 'Accept', 'Reject', 'AcceptWithComments'

        if (!['Accept', 'Reject', 'AcceptWithComments'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action.' });
        }

        const item = await AssetItem.findById(id)
            .populate({
                path: 'assignedTo',
                select: 'employeeId firstName lastName companyEmail enablePortalAccess primaryReportee',
                populate: { path: 'primaryReportee', select: '_id firstName lastName employeeId companyEmail workEmail' },
            })
            .populate('assignedBy assignedCompany')
            .populate('typeId', 'name');
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const assignmentBulkGroupId = item.pendingActionDetails?.bulkAssignment?.groupId || null;

        const currentUser = req.user.employeeObjectId;
        if (!currentUser) {
            return res.status(403).json({ message: 'You are not linked to an employee profile.' });
        }
        const cur = currentUser.toString();
        const norm = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');

        const isAssignee =
            item.assignedToType === 'Employee' &&
            item.assignedTo &&
            (
                (item.assignedTo._id || item.assignedTo).toString() === cur ||
                (item.assignedTo?.employeeId && req.user?.employeeId && norm(item.assignedTo.employeeId) === norm(req.user.employeeId))
            );
        const isAssigner =
            item.assignedBy && (item.assignedBy._id || item.assignedBy).toString() === cur;
        const isHR =
            item.assignedToType === 'Company' && item.actionRequiredBy?.toString() === cur;

        const actionRequiredByStr = item.actionRequiredBy
            ? (item.actionRequiredBy._id || item.actionRequiredBy).toString()
            : null;
        const isDesignatedResponder = !!actionRequiredByStr && actionRequiredByStr === cur;

        const fleetVehicleRespond = isFleetVehicleAssetFields({
            plateNumber: item.plateNumber,
            typeName: item.typeId?.name,
        });
        const handoverFlow = getVehicleHandoverFlow(item);
        let fleetHandoverHrSkipped = false;
        let isFleetHandoverAdminDelegate = false;
        if (fleetVehicleRespond && handoverFlow?.stage === 'target') {
            isFleetHandoverAdminDelegate = await userIsFlowchartAdminOfficer(req);
        }
        let isFleetHandoverHrActor = false;
        if (
            fleetVehicleRespond &&
            (handoverFlow?.stage === 'hr' || handoverFlow?.stage === 'management')
        ) {
            isFleetHandoverHrActor = await isUserActiveInFlowchart(req.user, 'hr');
        }

        // If assignee has NO company email OR NO ERP login access, allow assignee.primaryReportee to act as delegate
        let isPrimaryReporteeDelegate = false;
        let primaryReportee = null;
        if (
            item.assignedToType === 'Employee' &&
            item.assignedTo &&
            item.assignedTo.primaryReportee &&
            !(handoverFlow && handoverFlow.assigneeCanSelfAcknowledge === false)
        ) {
            // enablePortalAccess comes from EmployeeBasic; if missing, we fallback to linked User row
            let assigneeHasPortalAccess = null;
            if (typeof item.assignedTo.enablePortalAccess === 'boolean') {
                assigneeHasPortalAccess = item.assignedTo.enablePortalAccess;
            } else {
                const assigneeEmpId = item.assignedTo.employeeId;
                if (assigneeEmpId) {
                    const linkedUser = await User.findOne({ employeeId: assigneeEmpId, status: 'Active' })
                        .select('enablePortalAccess')
                        .lean()
                        .catch(() => null);
                    assigneeHasPortalAccess = !!(linkedUser && linkedUser.enablePortalAccess);
                }
            }
            const assigneeHasCompanyEmail = !!(
                item.assignedTo.companyEmail && String(item.assignedTo.companyEmail).trim().length > 0
            );
            const managerId = item.assignedTo.primaryReportee._id || item.assignedTo.primaryReportee;
            const allowDelegate =
                managerId &&
                managerId.toString() === cur &&
                (assigneeHasPortalAccess === false || !assigneeHasCompanyEmail);
            if (allowDelegate) {
                isPrimaryReporteeDelegate = true;
                // Fetch manager details for notifications
                primaryReportee = await EmployeeBasic.findById(managerId)
                    .select('firstName lastName employeeId companyEmail enablePortalAccess primaryReportee')
                    .lean()
                    .catch(() => null);
            }
        }

        if (item.assignedToType === 'Company') {
            const isCompanyCoordinator = await isUserCompanyAssetCoordinator(req.user).catch(() => false);
            if (!isHR && !isCompanyCoordinator) {
                return res.status(403).json({ message: 'You are not authorized to respond to this company assignment.' });
            }
            if (item.actionRequiredBy && item.actionRequiredBy.toString() !== cur && !isCompanyCoordinator) {
                return res.status(403).json({ message: 'It is not your turn (designated company coordinator) to respond.' });
            }
        } else {
            if (
                !isAssignee &&
                !isAssigner &&
                !isPrimaryReporteeDelegate &&
                !isDesignatedResponder &&
                !isFleetHandoverAdminDelegate &&
                !isFleetHandoverHrActor
            ) {
                return res.status(403).json({ message: 'You are not authorized to respond to this assignment.' });
            }
            // If actionRequiredBy is not the current user, allow assigner or delegated primaryReportee to act too.
            if (item.actionRequiredBy && item.actionRequiredBy.toString() !== cur) {
                const assigneeId = item.assignedTo?._id ? item.assignedTo._id.toString() : item.assignedTo?.toString?.() || null;
                const isActingOnAssignedTurn =
                    isAssigner ||
                    isPrimaryReporteeDelegate ||
                    isDesignatedResponder ||
                    isFleetHandoverAdminDelegate ||
                    isFleetHandoverHrActor ||
                    (isAssignee && assigneeId && item.actionRequiredBy.toString() === assigneeId);

                if (!isActingOnAssignedTurn) {
                    return res.status(403).json({ message: 'It is not your turn to respond.' });
                }
            }
        }

        if (action === 'Accept' && item.assignedToType === 'Employee' && item.assignedTo) {
            const handoverFlowForSig = handoverFlow;
            const requiresAssigneeSignature =
                !fleetVehicleRespond ||
                !handoverFlowForSig ||
                handoverFlowForSig.stage === 'hr' ||
                handoverFlowForSig.stage === 'management';
            if (requiresAssigneeSignature) {
                const assigneeSigCheck = await EmployeeBasic.findById(item.assignedTo._id || item.assignedTo)
                    .select('signature')
                    .lean();
                if (!assigneeSigCheck?.signature?.url) {
                    return res.status(403).json({
                        message:
                            'The assigned employee must have a digital signature on their profile before this assignment can be accepted.',
                    });
                }
            }
        }

        const assignee = item.assignedTo;

        if (
            fleetVehicleRespond &&
            handoverFlow &&
            (action === 'Accept' || action === 'AcceptWithComments')
        ) {
            const historyRecord = handoverFlow.historyId
                ? await AssetHistory.findById(handoverFlow.historyId).lean()
                : null;
            if (isInspectionHandoverHistoryRecord(historyRecord)) {
                return res.status(400).json({
                    message:
                        'This handover record is a vehicle inspection. Use Send to HR or HR inspection approval instead.',
                });
            }
            if (action === 'Accept') {
                // When accessories/body match previous, Accept finalizes (skips HR) — require signature first.
                if (handoverFlow?.stage === 'target' && historyRecord) {
                    const requiresHr = await handoverRequiresHrApproval(historyRecord, item);
                    if (!requiresHr) {
                        const assigneeSigCheck = await EmployeeBasic.findById(
                            item.assignedTo._id || item.assignedTo,
                        )
                            .select('signature')
                            .lean();
                        if (!assigneeSigCheck?.signature?.url) {
                            return res.status(403).json({
                                message:
                                    'The assigned employee must have a digital signature on their profile before this assignment can be accepted.',
                            });
                        }
                    }
                }
                const advance = await advanceFleetHandoverOnAccept({
                    item,
                    historyRecord,
                    assigneeDoc: item.assignedTo,
                    actor: await EmployeeBasic.findById(currentUser).catch(() => null),
                    assigner: item.assignedBy,
                });
                if (advance.error) {
                    return res.status(400).json({ message: advance.error });
                }
                if (advance.hrSkipped) {
                    fleetHandoverHrSkipped = true;
                }
                if (advance.advanced) {
                    if (handoverFlow?.stage === 'target') {
                        const updatedFlow = getVehicleHandoverFlow(item);
                        item.pendingActionDetails = {
                            ...(item.pendingActionDetails || {}),
                            vehicleHandoverFlow: markHandoverEscalationResolved(updatedFlow || {}),
                        };
                    }
                    await item.save();
                    const stagedItem = await AssetItem.findById(id)
                        .populate('assignedCompany')
                        .populate({
                            path: 'assignedTo',
                            select:
                                'firstName lastName employeeId profilePicture companyEmail workEmail department dateOfJoining reportingAuthority primaryReportee enablePortalAccess',
                            populate: [
                                { path: 'reportingAuthority', select: 'firstName lastName' },
                                { path: 'primaryReportee', select: 'firstName lastName employeeId' },
                            ],
                        })
                        .populate({ path: 'assignedBy', select: 'firstName lastName employeeId signature' })
                        .populate('actionRequiredBy', 'firstName lastName employeeId')
                        .populate('typeId', 'name imagePreview')
                        .populate('categoryId', 'name imagePreview');
                    return res.status(200).json({
                        message: 'Handover advanced to the next approval stage.',
                        asset: stagedItem,
                    });
                }
            }
        }

        // Determine actor for notifications
        let actor =
            isAssignee
                ? item.assignedTo
                : isPrimaryReporteeDelegate
                    ? primaryReportee || (await EmployeeBasic.findById(currentUser).catch(() => null))
                    : isDesignatedResponder || isFleetHandoverAdminDelegate
                        ? await EmployeeBasic.findById(currentUser).catch(() => null)
                        : isHR
                            ? await EmployeeBasic.findById(currentUser)
                            : item.assignedBy;

        // Notify all relevant parties (assigner + Asset Controller always; assignee/manager when applicable)
        const notifyParties = async () => {
            try {
                const recipients = [];
                const seenRecipientIds = new Set();
                const pushRecipient = (emp) => {
                    if (!emp) return;
                    const id = (emp._id || emp).toString();
                    if (seenRecipientIds.has(id)) return;
                    seenRecipientIds.add(id);
                    recipients.push(emp);
                };

                if (item.assignedBy) pushRecipient(item.assignedBy);

                const fleetVehicle = isFleetVehicleAssetFields({
                    plateNumber: item.plateNumber,
                    typeName: item.typeId?.name,
                });
                if (fleetVehicle) {
                    const hrForNotify = await getResolvedFleetHrEmployee();
                    if (hrForNotify) pushRecipient(hrForNotify);
                } else {
                    const acForNotify = await getResolvedAssetControllerEmployee();
                    if (acForNotify) pushRecipient(acForNotify);
                }

                // 2. Notify the subject (employee or delegated primary reportee) if they were NOT the one who acted
                if (item.assignedToType === 'Employee' && item.assignedTo && item.assignedTo._id.toString() !== currentUser.toString()) {
                    // If assignee has portal access, notify assignee.
                    // Otherwise notify their primaryReportee delegate.
                    const assigneeHasPortalAccess = typeof item.assignedTo.enablePortalAccess === 'boolean'
                        ? item.assignedTo.enablePortalAccess
                        : null;

                    if (assigneeHasPortalAccess === true) {
                        pushRecipient(item.assignedTo);
                    } else {
                        const managerId = item.assignedTo.primaryReportee?._id || item.assignedTo.primaryReportee;
                        if (managerId) {
                            const manager = primaryReportee || await EmployeeBasic.findById(managerId)
                                .select('firstName lastName employeeId companyEmail enablePortalAccess primaryReportee')
                                .lean()
                                .catch(() => null);
                            if (manager) pushRecipient(manager);
                        }
                    }
                }

                // 3. For 'Accept', also notify Manager (Employee Flow only)
                if (action === 'Accept' && item.assignedToType === 'Employee' && item.assignedTo?.primaryReportee) {
                    const managerId = item.assignedTo.primaryReportee._id || item.assignedTo.primaryReportee;
                    if (!seenRecipientIds.has(managerId.toString()) && managerId.toString() !== currentUser.toString()) {
                        const manager = await EmployeeBasic.findById(managerId);
                        if (manager) pushRecipient(manager);
                    }
                }

                let responseInvPdf = [];

                for (let recipient of recipients) {
                    await sendAssetResponseEmail({
                        asset: item,
                        actor,
                        recipient,
                        action,
                        comment: comments,
                        assignedToType: item.assignedToType,
                        assignedCompany: item.assignedCompany,
                        attachments: responseInvPdf
                    });
                }
            } catch (err) {
            }
        };

        const parkingCtx = item.pendingActionDetails?.parkingReassignContext;
        const serviceCtx = item.pendingActionDetails?.serviceReassignContext;
        const transferCtx = item.pendingActionDetails?.assigneeTransferContext;

        if (action === 'Reject') {
            if (fleetVehicleRespond && handoverFlow) {
                const adminOfficer = await resolveAdminOfficerEmployee();
                const stageLabel =
                    handoverFlow.stage === 'hr' || handoverFlow.stage === 'management'
                        ? 'HR Approval'
                        : 'Target User / Admin Officer';
                const previousRecipient = await resolvePreviousHandoverRejectionRecipient(
                    handoverFlow.stage,
                    {
                        assigner: item.assignedBy,
                        assignee: item.assignedTo,
                        assigneeCanSelfAcknowledge: handoverFlow.assigneeCanSelfAcknowledge,
                        adminOfficer,
                        historyId: handoverFlow.historyId,
                    },
                );
                await notifyHandoverRejectedToPrevious({
                    asset: item,
                    recipient: previousRecipient,
                    actor: await EmployeeBasic.findById(currentUser).catch(() => null),
                    comment: comments,
                    historyId: handoverFlow.historyId,
                    stageLabel,
                });
            }
            if (!transferCtx?.isAssigneeTransfer) {
                await notifyParties();
            }

            // Capture snapshot BEFORE clearing
            const snapshotItem = await AssetItem.findById(item._id)
                .populate('categoryId typeId assignedTo assignedBy acceptedBy assignedCompany');
            req.rejectionSnapshot = snapshotItem.toObject();

            // If it was a transfer, we just revert to old owner (keep existing assignedTo)
            if (item.pendingAction === 'Asset Transfer') {
                const oldOwnerId = item.pendingActionDetails?.transferFrom || item.assignedTo;
                item.status = 'Pending';
                item.acceptanceStatus = 'Pending';
                item.pendingAction = 'Retention Confirmation';
                item.actionRequiredBy = oldOwnerId;

                // Dashboard action for old HR
                try {
                    const oldHREmp = await EmployeeBasic.findById(oldOwnerId).select('employeeId firstName lastName');
                    await DashboardAction.create({
                        assignedTo: oldOwnerId,
                        assignedToEmpId: oldHREmp?.employeeId,
                        requestId: item._id,
                        requestType: 'Asset Retention',
                        subjectEmployeeId: oldHREmp?.employeeId,
                        subjectName: `${oldHREmp?.firstName || ""} ${oldHREmp?.lastName || ""}`.trim(),
                        requestedByName: req.user.name || 'New HR',
                        extra1: `${item.assetId} - ${item.name}`,
                        extra2: 'Handover Rejected: Confirm you still have this asset',
                        status: 'Pending'
                    });
                } catch (dashErr) {
                }
            } else if (transferCtx?.isAssigneeTransfer && transferCtx?.oldAssignedTo) {
                item.status = 'Assigned';
                item.assignedToType = 'Employee';
                item.assignedTo = transferCtx.oldAssignedTo;
                item.assignedCompany = null;
                item.assignedBy = transferCtx.oldAssignedBy || item.assignedBy;
                item.assignmentType = transferCtx.oldAssignmentType || item.assignmentType;
                item.assignedDays = transferCtx.oldAssignedDays ?? item.assignedDays;
                item.assignedDate = transferCtx.oldAssignedDate ?? item.assignedDate;
                item.temporaryEndDate = transferCtx.oldTemporaryEndDate ?? item.temporaryEndDate;
                item.temporaryReminderSentAt = transferCtx.oldTemporaryReminderSentAt ?? item.temporaryReminderSentAt;
                item.temporaryExpiredSentAt = transferCtx.oldTemporaryExpiredSentAt ?? item.temporaryExpiredSentAt;
                item.acceptanceStatus = 'Accepted';
                item.actionRequiredBy = null;
                item.negotiationHistory = [];
                if (item.pendingActionDetails?.assigneeTransferContext) {
                    delete item.pendingActionDetails.assigneeTransferContext;
                }

                void (async () => {
                    try {
                        const oldAssignee = await loadEmployeeWithReportee(transferCtx.oldAssignedTo);
                        const newAssignee = await EmployeeBasic.findById(currentUser).lean();
                        const initiator = transferCtx.requestedBy
                            ? await loadEmployeeWithReportee(transferCtx.requestedBy)
                            : null;
                        const approver = await EmployeeBasic.findById(currentUser)
                            .select('firstName lastName employeeId companyEmail workEmail')
                            .lean();
                        await sendAssigneeTransferResultEmails({
                            asset: item,
                            oldAssignee,
                            newAssignee,
                            initiator,
                            approver,
                            approved: false,
                            comment: comments,
                        });
                    } catch (e) {
                    }
                })();
            } else if (parkingCtx?.isParkingReassign && parkingCtx?.oldAssignedTo) {
                item.onLeaveActive = true;
                item.status = 'Assigned';
                item.assignedToType = 'Employee';
                item.assignedTo = parkingCtx.oldAssignedTo;
                item.assignedCompany = null;
                item.assignedBy = parkingCtx.oldAssignedBy || item.assignedBy;
                item.assignmentType = parkingCtx.oldAssignmentType || item.assignmentType;
                item.assignedDays = parkingCtx.oldAssignedDays ?? item.assignedDays;
                item.assignedDate = parkingCtx.oldAssignedDate ?? item.assignedDate;
                item.temporaryEndDate = parkingCtx.oldTemporaryEndDate ?? item.temporaryEndDate;
                item.temporaryReminderSentAt = parkingCtx.oldTemporaryReminderSentAt ?? item.temporaryReminderSentAt;
                item.temporaryExpiredSentAt = parkingCtx.oldTemporaryExpiredSentAt ?? item.temporaryExpiredSentAt;
                restoreParkingFields(item, parkingCtx.parkingSnapshot);
                item.acceptanceStatus = 'Accepted';
                item.actionRequiredBy = null;
                item.negotiationHistory = [];
                item.pendingAction = null;
                if (item.pendingActionDetails?.parkingReassignContext) {
                    delete item.pendingActionDetails.parkingReassignContext;
                }
            } else if (serviceCtx?.isServiceReassign && serviceCtx?.oldAssignedTo) {
                item.onServiceActive = true;
                item.status = 'Assigned';
                item.assignedToType = 'Employee';
                item.assignedTo = serviceCtx.oldAssignedTo;
                item.assignedCompany = null;
                item.assignedBy = serviceCtx.oldAssignedBy || item.assignedBy;
                item.assignmentType = serviceCtx.oldAssignmentType || item.assignmentType;
                item.assignedDays = serviceCtx.oldAssignedDays ?? item.assignedDays;
                item.assignedDate = serviceCtx.oldAssignedDate ?? item.assignedDate;
                item.temporaryEndDate = serviceCtx.oldTemporaryEndDate ?? item.temporaryEndDate;
                item.temporaryReminderSentAt = serviceCtx.oldTemporaryReminderSentAt ?? item.temporaryReminderSentAt;
                item.temporaryExpiredSentAt = serviceCtx.oldTemporaryExpiredSentAt ?? item.temporaryExpiredSentAt;
                item.acceptanceStatus = 'Accepted';
                item.actionRequiredBy = null;
                item.negotiationHistory = [];
                item.pendingAction = null;
                if (item.pendingActionDetails?.serviceReassignContext) {
                    delete item.pendingActionDetails.serviceReassignContext;
                }
            } else {
                item.status = 'Unassigned';
                item.assignedTo = null;
                item.assignedCompany = null;
                item.assignedToType = null;
                item.assignedBy = null;
                item.assignmentType = null;
                item.assignedDays = null;
                item.assignedDate = null;
                item.temporaryEndDate = null;
                item.temporaryReminderSentAt = null;
                item.temporaryExpiredSentAt = null;
                item.acceptanceStatus = 'Rejected';
                item.actionRequiredBy = null;
                item.negotiationHistory = [];
                if (item.pendingActionDetails?.vehicleHandoverFlow) {
                    delete item.pendingActionDetails.vehicleHandoverFlow;
                }
            }

        } else if (action === 'Accept' || action === 'AcceptWithComments') {
            if (fleetVehicleRespond && handoverFlow && action === 'Accept') {
                const flowNow = getVehicleHandoverFlow(item);
                const hrStage =
                    handoverFlow.stage === 'hr' ||
                    handoverFlow.stage === 'management' ||
                    flowNow?.stage === 'hr' ||
                    flowNow?.stage === 'management';
                if (hrStage || fleetHandoverHrSkipped) {
                    const historyId = flowNow?.historyId || handoverFlow?.historyId;
                    if (historyId) {
                        const fineIdList = [
                            ...(Array.isArray(handoverFineIds) ? handoverFineIds : []),
                            ...(handoverFineId ? [handoverFineId] : []),
                        ]
                            .map((value) => String(value || '').trim())
                            .filter(Boolean);
                        const uniqueFineIds = [...new Set(fineIdList)];
                        const primaryFineId = uniqueFineIds[0] || null;
                        const handoverPatch = {
                            'details.handoverApprovedWithFine': uniqueFineIds.length > 0,
                            'details.handoverLifecycleStatus': 'approved',
                        };
                        if (primaryFineId) {
                            handoverPatch['details.handoverFineId'] = String(primaryFineId);
                        }
                        if (uniqueFineIds.length > 0) {
                            handoverPatch['details.handoverFineIds'] = uniqueFineIds;
                        }
                        if (fleetHandoverHrSkipped) {
                            handoverPatch['details.hrApprovalSkipped'] = true;
                        } else {
                            handoverPatch['details.handoverHrApprovedAt'] = new Date();
                        }
                        await AssetHistory.updateOne({ _id: historyId }, { $set: handoverPatch }).catch(
                            () => null,
                        );
                        try {
                            const historyForAccessories = await AssetHistory.findById(historyId).lean();
                            if (historyForAccessories) {
                                await applyPendingHandoverAccessoriesToVehicleList(historyForAccessories);
                            }
                        } catch {
                            /* non-fatal */
                        }
                    }
                    if (item.pendingActionDetails?.vehicleHandoverFlow) {
                        delete item.pendingActionDetails.vehicleHandoverFlow;
                    }
                }
            }

            // Handle HR Handover / Asset Transfer: Reassign 'assignedTo' to the person who accepted
            if (item.pendingAction === 'Asset Transfer' && item.actionRequiredBy?.toString() === currentUser.toString()) {
                item.assignedTo = currentUser;
                item.pendingAction = null;
                item.pendingActionDetails = null;
            } else if (item.pendingAction === 'Retention Confirmation' && item.actionRequiredBy?.toString() === currentUser.toString()) {
                item.assignedBy = currentUser; // User is re-assigning to themselves essentially
                item.pendingAction = null;
                item.pendingActionDetails = null;
            }

            if (action === 'Accept') {
                // Parking reassignment stays On Leave; service reassignment keeps service status.
                if (parkingCtx?.isParkingReassign) {
                    item.onLeaveActive = true;
                    item.status = 'Assigned';
                    restoreParkingFields(item, parkingCtx.parkingSnapshot);
                } else if (serviceCtx?.isServiceReassign) {
                    item.onServiceActive = true;
                    if (serviceCtx.preservedOnLeave) {
                        item.onLeaveActive = true;
                    }
                    item.status = 'Assigned';
                } else {
                    item.status = 'Assigned';
                }
                item.acceptanceStatus = 'Accepted';
                item.actionRequiredBy = null;
                item.acceptedBy = req.user.employeeObjectId;

                // Stamp assignment start (and temporary end) for normal Assigned assets —
                // not parking or service reassignment (those restore prior dates below).
                if (!parkingCtx?.isParkingReassign && !serviceCtx?.isServiceReassign) {
                    stampAssignmentDatesOnAccept(item);
                } else if (parkingCtx?.isParkingReassign) {
                    item.assignmentType = parkingCtx.oldAssignmentType ?? item.assignmentType;
                    item.assignedDays = parkingCtx.oldAssignedDays ?? item.assignedDays;
                    item.assignedDate = parkingCtx.oldAssignedDate ?? item.assignedDate;
                    item.temporaryEndDate = parkingCtx.oldTemporaryEndDate ?? item.temporaryEndDate;
                    item.temporaryReminderSentAt = parkingCtx.oldTemporaryReminderSentAt ?? item.temporaryReminderSentAt;
                    item.temporaryExpiredSentAt = parkingCtx.oldTemporaryExpiredSentAt ?? item.temporaryExpiredSentAt;
                } else if (serviceCtx?.isServiceReassign) {
                    item.assignmentType = serviceCtx.oldAssignmentType ?? item.assignmentType;
                    item.assignedDays = serviceCtx.oldAssignedDays ?? item.assignedDays;
                    item.assignedDate = serviceCtx.oldAssignedDate ?? item.assignedDate;
                    item.temporaryEndDate = serviceCtx.oldTemporaryEndDate ?? item.temporaryEndDate;
                    item.temporaryReminderSentAt = serviceCtx.oldTemporaryReminderSentAt ?? item.temporaryReminderSentAt;
                    item.temporaryExpiredSentAt = serviceCtx.oldTemporaryExpiredSentAt ?? item.temporaryExpiredSentAt;
                }

                // Parking reassignment accepted: notify old assignee.
                if (parkingCtx?.isParkingReassign && parkingCtx?.oldAssignedTo && item.assignedToType === 'Employee') {
                    try {
                        const oldAssignee = await EmployeeBasic.findById(parkingCtx.oldAssignedTo)
                            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                            .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
                            .lean();
                        const newAssignee = await EmployeeBasic.findById(item.assignedTo?._id || item.assignedTo)
                            .select('firstName lastName employeeId companyEmail workEmail personalEmail email')
                            .lean();
                        const assetController = await EmployeeBasic.findById(item.assignedBy?._id || item.assignedBy)
                            .select('firstName lastName employeeId')
                            .lean();

                        if (oldAssignee && newAssignee) {
                            await sendParkingReassignAcceptedEmail({
                                asset: item,
                                oldAssignee,
                                newAssignee,
                                assetController
                            });
                        }
                    } catch (mailErr) {
                    }
                }

                if (item.pendingActionDetails?.parkingReassignContext) {
                    delete item.pendingActionDetails.parkingReassignContext;
                }
                if (item.pendingActionDetails?.serviceReassignContext) {
                    delete item.pendingActionDetails.serviceReassignContext;
                }
                if (item.pendingActionDetails?.assigneeTransferContext) {
                    const ctx = item.pendingActionDetails.assigneeTransferContext;
                    delete item.pendingActionDetails.assigneeTransferContext;
                    void (async () => {
                        try {
                            const oldAssignee = await loadEmployeeWithReportee(ctx.oldAssignedTo);
                            const newAssignee = await loadEmployeeWithReportee(item.assignedTo?._id || item.assignedTo);
                            const initiator = ctx.requestedBy
                                ? await loadEmployeeWithReportee(ctx.requestedBy)
                                : null;
                            const approver = await EmployeeBasic.findById(currentUser)
                                .select('firstName lastName employeeId companyEmail workEmail')
                                .lean();
                            let att = [];
                            try {
                                att = await buildAssigneeTransferHandoverAttachments(req, item._id, {
                                    assigner: initiator,
                                    oldAssignee,
                                    newAssignee,
                                });
                            } catch (e) {
                                /* non-fatal */
                            }
                            await sendAssigneeTransferResultEmails({
                                asset: item,
                                oldAssignee,
                                newAssignee,
                                initiator,
                                approver,
                                approved: true,
                                comment: comments,
                                attachments: att,
                            });
                        } catch (e) {
                        }
                    })();
                }
            }

            else if (action === 'AcceptWithComments') {
                let fileUrl = null;
                if (req.body.file) {
                    try {
                        const uploadResult = await uploadDocumentToS3(req.body.file, 'asset-negotiation');
                        fileUrl = uploadResult.publicId;
                    } catch (err) {
                    }
                }

                item.negotiationHistory.push({
                    sender: currentUser,
                    message: comments,
                    action: 'AcceptWithComments',
                    file: fileUrl,
                    date: new Date()
                });

                // Pass the ball: assignee/coordinator → assigner; assigner → assignee (or company coordinator)
                if (isAssignee || isHR || isPrimaryReporteeDelegate || isDesignatedResponder) {
                    item.actionRequiredBy = item.assignedBy._id || item.assignedBy;
                } else {
                    if (item.assignedToType === 'Company') {
                        const cc = await getCompanyAssetCoordinator();
                        if (!cc) {
                            return res.status(400).json({
                                message: 'No Assigned User or Admin in Flowchart. Cannot route company negotiation.'
                            });
                        }
                        item.actionRequiredBy = cc._id;
                    } else {
                        item.actionRequiredBy = item.assignedTo._id || item.assignedTo;
                    }
                }

                await notifyParties();

                // Log negotiation
                const snapshotItem = await AssetItem.findById(item._id)
                    .populate('categoryId typeId acceptedBy accessories assignedCompany')
                    .populate({
                        path: 'assignedTo',
                        populate: [{ path: 'primaryReportee', select: 'firstName lastName employeeId' }]
                    })
                    .populate({ path: 'assignedBy', select: 'firstName lastName employeeId signature' });

                await AssetHistory.create({
                    assetId: item._id,
                    action: 'Comment',
                    assignedToType: item.assignedToType,
                    assignedTo: item.assignedTo,
                    assignedCompany: item.assignedCompany,
                    performedBy: req.user.employeeObjectId,
                    comments: comments,
                    file: fileUrl,
                    details: snapshotItem.toObject()
                });
            }
        }

        await item.save();

        if (
            fleetVehicleRespond &&
            handoverFlow?.stage === 'target' &&
            (action === 'Reject' || action === 'Accept')
        ) {
            const flowAfter = getVehicleHandoverFlow(item);
            if (flowAfter && !flowAfter.escalation?.resolvedAt) {
                item.pendingActionDetails = {
                    ...(item.pendingActionDetails || {}),
                    vehicleHandoverFlow: markHandoverEscalationResolved(flowAfter),
                };
                await item.save();
            }
        }

        // Update Dashboard Actions
        try {
            if (fleetVehicleRespond && handoverFlow && action === 'Reject') {
                await closeFleetHandoverDashboardActions(
                    item._id,
                    'Rejected',
                    currentUser,
                    comments || 'Vehicle handover rejected.',
                );
            } else {
                const existingAction = await DashboardAction.findOne({
                    requestId: item._id,
                    assignedTo: currentUser,
                    status: 'Pending',
                });

                if (existingAction) {
                    existingAction.status = action === 'Reject' ? 'Rejected' : 'Approved';
                    existingAction.actionedDate = new Date();
                    existingAction.actionedBy = currentUser;
                    existingAction.comment = comments;
                    await existingAction.save();
                }
            }

            if (action === 'AcceptWithComments') {
                const nextActorId = item.actionRequiredBy;
                const nextActor = await EmployeeBasic.findById(nextActorId).select('employeeId firstName lastName');

                let subjectName = "";
                let subjectEmpId = "";
                if (item.assignedToType === 'Company') {
                    const comp = await Company.findById(item.assignedCompany);
                    subjectName = comp?.name || "Company";
                    subjectEmpId = comp?.companyId || "N/A";
                } else {
                    const subjectEmp = await EmployeeBasic.findById(item.assignedTo).select('employeeId firstName lastName');
                    subjectName = `${subjectEmp?.firstName || ""} ${subjectEmp?.lastName || ""} `.trim();
                    subjectEmpId = subjectEmp?.employeeId;
                }

                const senderEmp = await EmployeeBasic.findById(currentUser).select('firstName lastName');

                await DashboardAction.create({
                    assignedTo: nextActorId,
                    assignedToEmpId: nextActor?.employeeId,
                    requestId: item._id,
                    requestType: 'Asset',
                    subjectEmployeeId: subjectEmpId,
                    subjectName: subjectName,
                    requestedByName: `${senderEmp?.firstName || ""} ${senderEmp?.lastName || ""} `.trim(),
                    extra1: `${item.assetId} - ${item.name} `,
                    extra2: `Update Required: ${comments} `,
                    status: 'Pending'
                });
            }
        } catch (err) {
        }

        if (assignmentBulkGroupId) {
            try {
                await refreshBulkAssignmentDashboardIfGroupFullyResolved(assignmentBulkGroupId, currentUser);
            } catch (dash2) {
            }
        }

        const priorAcceptedCountForReassign =
            action === 'Accept'
                ? await AssetHistory.countDocuments({ assetId: item._id, action: 'Accepted' })
                : 0;

        // Log final actions
        if (action === 'Reject') {
            const fleetHandoverHistoryId = handoverFlow?.historyId;
            if (fleetVehicleRespond && fleetHandoverHistoryId) {
                await updateFleetHandoverHistoryRecord({
                    historyId: fleetHandoverHistoryId,
                    action: 'Rejected',
                    performedBy: req.user.employeeObjectId,
                    comments,
                    detailsPatch: {
                        ...(req.rejectionSnapshot || {}),
                        rejectionComments: comments,
                    },
                });
            } else {
                await AssetHistory.create({
                    assetId: item._id,
                    action: 'Rejected',
                    assignedToType: item.assignedToType,
                    assignedTo: null,
                    assignedCompany: null,
                    performedBy: req.user.employeeObjectId,
                    comments: comments,
                    details: {
                        ...(req.rejectionSnapshot || {}),
                        rejectionComments: comments
                    }
                });
            }
            await updateAssetTypeCounts(item.typeId);
        } else if (action === 'Accept') {
            const snapshotItem = await AssetItem.findById(item._id)
                .populate('categoryId typeId acceptedBy accessories assignedCompany')
                .populate({
                    path: 'assignedTo',
                    select: 'firstName lastName employeeId department signature primaryReportee',
                    populate: [{ path: 'primaryReportee', select: 'firstName lastName employeeId' }],
                })
                .populate({ path: 'assignedBy', select: 'firstName lastName employeeId signature' });

            const pr = item.assignedTo?.primaryReportee;
            const primaryReporteeId = pr && (typeof pr === 'object' ? pr._id || pr : pr);
            const isManager =
                item.assignedToType === 'Employee' &&
                !!primaryReporteeId &&
                primaryReporteeId.toString() === cur &&
                !isFleetHandoverAdminDelegate;

            let acceptComment = comments;
            if (isFleetHandoverAdminDelegate) {
                acceptComment = `Accepted by Admin Officer on behalf of employee.${comments ? ` ${comments}` : ''}`;
            } else if (isManager) {
                acceptComment = `Accepted by manager on behalf of employee.${comments ? ` ${comments}` : ''}`;
            } else if (isHR) {
                acceptComment = `Accepted by HR on behalf of company.${comments ? ` ${comments}` : ''}`;
            }

            const fleetHandoverHistoryId =
                handoverFlow?.historyId ||
                (await (async () => {
                    if (!fleetVehicleRespond) return null;
                    const assigneeId = item.assignedTo?._id || item.assignedTo;
                    if (!assigneeId) return null;
                    const openHandover = await AssetHistory.findOne({
                        assetId: item._id,
                        assignedTo: assigneeId,
                        action: { $in: ['Assigned', 'Accepted'] },
                        'details.handoverKind': { $ne: 'vehicle_inspection' },
                        'details.firstInspection': { $ne: true },
                    })
                        .sort({ createdAt: -1 })
                        .select('_id')
                        .lean();
                    return openHandover?._id?.toString?.() || null;
                })());
            let acceptHistDoc;

            if (fleetVehicleRespond && fleetHandoverHistoryId) {
                const wasHrHandoverApproval =
                    handoverFlow?.stage === 'hr' ||
                    handoverFlow?.stage === 'management' ||
                    fleetHandoverHrSkipped;
                acceptHistDoc = await updateFleetHandoverHistoryRecord({
                    historyId: fleetHandoverHistoryId,
                    action: 'Accepted',
                    performedBy: req.user.employeeObjectId,
                    comments: acceptComment,
                    snapshotItem,
                    detailsPatch: {
                        isAcceptedByManager: isManager,
                        isAcceptedByHR: isHR,
                        isAcceptedByAdminOfficer: isFleetHandoverAdminDelegate,
                        handoverLifecycleStatus: wasHrHandoverApproval
                            ? HANDOVER_LIFECYCLE.APPROVED
                            : HANDOVER_LIFECYCLE.ACCEPTED,
                        ...(fleetHandoverHrSkipped ? { hrApprovalSkipped: true } : {}),
                    },
                });
            } else {
                acceptHistDoc = await AssetHistory.create({
                    assetId: item._id,
                    action: 'Accepted',
                    assignedToType: item.assignedToType,
                    assignedTo: item.assignedTo,
                    assignedCompany: item.assignedCompany,
                    performedBy: req.user.employeeObjectId,
                    comments: acceptComment,
                    details: {
                        ...snapshotItem.toObject(),
                        isAcceptedByManager: isManager,
                        isAcceptedByHR: isHR,
                        isAcceptedByAdminOfficer: isFleetHandoverAdminDelegate,
                    }
                });
            }

            try {
                const signerEmp = await EmployeeBasic.findById(currentUser).select('firstName lastName signature');

                let subjectEmployeeName = '';
                let subjectCode = '';
                let subjectDept = '';
                let hodDisplay = '—';
                let assigneeForAck = null;
                if (item.assignedToType === 'Company') {
                    const comp = await Company.findById(item.assignedCompany).select('name companyId').lean();
                    subjectEmployeeName = comp?.name || '—';
                    subjectCode = comp?.companyId || '—';
                    subjectDept = '—';
                    assigneeForAck = signerEmp;
                } else {
                    const ato = snapshotItem.assignedTo;
                    subjectEmployeeName = ato ? `${ato.firstName || ''} ${ato.lastName || ''}`.trim() : '—';
                    subjectCode = ato?.employeeId || '—';
                    subjectDept = (ato?.department && String(ato.department).trim()) || '—';
                    const hodFromReportee = ato?.primaryReportee;
                    if (hodFromReportee && typeof hodFromReportee === 'object') {
                        hodDisplay =
                            `${hodFromReportee.firstName || ''} ${hodFromReportee.lastName || ''}`.trim() ||
                            hodFromReportee.employeeId ||
                            '—';
                    }
                    const assigneeId = ato?._id || ato;
                    if (assigneeId) {
                        assigneeForAck = await EmployeeBasic.findById(assigneeId)
                            .select('firstName lastName employeeId signature')
                            .lean();
                    }
                }
                const assignerNameStr = snapshotItem.assignedBy
                    ? `${snapshotItem.assignedBy.firstName || ''} ${snapshotItem.assignedBy.lastName || ''}`.trim()
                    : '—';

                const handoverAcceptCtx = await finalizeHandoverPdfCtx(
                    buildFullySignedHandoverCtx({
                        assigner: snapshotItem.assignedBy,
                        assignerName: assignerNameStr,
                        assignee: assigneeForAck,
                        assigneeName: subjectEmployeeName,
                        employeeCode: subjectCode,
                        department: subjectDept,
                        hodName: hodDisplay,
                    }),
                    { assigner: snapshotItem.assignedBy, assignee: assigneeForAck },
                );

                const pdfBuf = await generateBulkAssignmentHandoverPdf(req, [item._id.toString()], handoverAcceptCtx);

                let acceptPdfAttachments = [];
                if (acceptHistDoc && pdfBuf?.length) {
                    const fk = await persistHandoverPdfBufferToHistory(
                        pdfBuf,
                        `accept-${item.assetId}-${acceptHistDoc._id}.pdf`,
                    );
                    if (fk) {
                        await AssetHistory.updateOne({ _id: acceptHistDoc._id }, { $set: { file: fk } });
                    }
                    acceptPdfAttachments = [
                        {
                            filename: `handover-accept-${item.assetId}.pdf`,
                            content: pdfBuf,
                            contentType: 'application/pdf',
                            contentDisposition: 'attachment',
                        },
                    ];
                }

                const recipients = [];
                const pushUniqueRecipient = (emp) => {
                    if (!emp) return;
                    const id = (emp._id || emp).toString();
                    if (!recipients.some((r) => (r._id || r).toString() === id)) recipients.push(emp);
                };

                if (item.assignedBy) pushUniqueRecipient(item.assignedBy);

                const acForAcceptNotify = await getResolvedAssetControllerEmployee();
                if (acForAcceptNotify) pushUniqueRecipient(acForAcceptNotify);

                if (item.assignedToType === 'Employee' && item.assignedTo) {
                    const assigneeIdStr = (item.assignedTo._id || item.assignedTo).toString();
                    const isSelfAccept = assigneeIdStr === cur;

                    const assigneeRecipient = await EmployeeBasic.findById(item.assignedTo._id || item.assignedTo)
                        .select(
                            'firstName lastName employeeId companyEmail workEmail email primaryReportee enablePortalAccess',
                        )
                        .populate('primaryReportee', 'firstName lastName companyEmail workEmail')
                        .lean()
                        .catch(() => item.assignedTo);

                    if (!isSelfAccept) {
                        pushUniqueRecipient(assigneeRecipient);
                    }

                    const managerId =
                        assigneeRecipient?.primaryReportee?._id || assigneeRecipient?.primaryReportee;
                    if (managerId && managerId.toString() !== currentUser.toString()) {
                        const manager =
                            primaryReportee ||
                            (await EmployeeBasic.findById(managerId)
                                .select('firstName lastName employeeId companyEmail workEmail')
                                .lean()
                                .catch(() => null));
                        pushUniqueRecipient(manager);
                    }
                }

                for (const recipient of recipients) {
                    await sendAssetResponseEmail({
                        asset: item,
                        actor: signerEmp,
                        recipient,
                        action: 'Accept',
                        comment: comments,
                        assignedToType: item.assignedToType,
                        assignedCompany: item.assignedCompany,
                        attachments: acceptPdfAttachments,
                    });
                }
            } catch (acceptNotifyErr) {
            }

            if (priorAcceptedCountForReassign >= 1) {
                void notifyAssetControllerReassignmentAcceptedWithHandover(req, { assetMongoId: item._id });
                void notifyPreviousAssigneeReassignmentAcceptedWithHandover(req, { assetMongoId: item._id });
            }

            if (fleetVehicleRespond && handoverFlow?.historyId) {
                try {
                    await closeFleetHandoverDashboardActions(
                        item._id,
                        'Approved',
                        currentUser,
                        'Vehicle handover approved by HR.',
                    );
                    const hod = await resolveHodEmployee(item.assignedTo);
                    const adminOfficer = await resolveAdminOfficerEmployee();
                    const hrEmp = await getResolvedFleetHrEmployee();

                    let fleetHandoverPdfBuffers = [];
                    try {
                        const baseUrl = resolveFrontendBaseUrl(req);
                        const printUrl = `${baseUrl}/print/vehicle-handover/${item._id}?historyId=${encodeURIComponent(handoverFlow.historyId)}`;
                        const token = req.headers.authorization?.split(' ')[1] || '';
                        const userObj = await User.findById(req.user?.id);
                        const userPayload = {
                            id: req.user?.id,
                            isAdmin: isJwtSystemSuperUser(userObj),
                            role: userObj?.role,
                            employeeId: userObj?.employeeId,
                        };
                        const fleetPdfBuf = await generatePdf(
                            printUrl,
                            token,
                            userPayload,
                            {},
                            VEHICLE_HANDOVER_PDF_SELECTOR,
                        );
                        if (fleetPdfBuf?.length) {
                            fleetHandoverPdfBuffers = [fleetPdfBuf];
                        }
                    } catch {
                        /* non-fatal */
                    }

                    await notifyHandoverCompletionEmails({
                        asset: item,
                        assignee: item.assignedTo,
                        assigner: item.assignedBy,
                        adminOfficer,
                        hod,
                        hrEmployee: hrEmp,
                        historyId: handoverFlow.historyId,
                        attachmentBuffers: fleetHandoverPdfBuffers,
                    });
                } catch (completionErr) {
                    /* non-fatal */
                }
            }
        }

        res.status(200).json(item);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

/**
 * @desc    Bulk respond to asset assignments (Accept/Reject)
 * @route   PUT /api/AssetItem/bulk/respond
 * @access  Private
 */
export const bulkRespondToAssignment = async (req, res) => {
    try {
        const { assetIds, action, comments } = req.body; // action: 'Accept' or 'Reject'

        if (!Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ message: 'Please provide at least one asset ID' });
        }

        if (!['Accept', 'Reject'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action. Must be "Accept" or "Reject"' });
        }

        const currentUser = req.user.employeeObjectId;
        const items = await AssetItem.find({ _id: { $in: assetIds } })
            .populate({
                path: 'assignedTo',
                select: 'employeeId companyEmail primaryReportee enablePortalAccess',
                populate: { path: 'primaryReportee', select: '_id' },
            })
            .populate('assignedBy assignedCompany');

        const results = { success: [], failed: [] };

        for (const item of items) {
            const bulkAssignGroupId = item.pendingActionDetails?.bulkAssignment?.groupId || null;
            try {
                // Check if user is authorized for this specific asset
                const curBulk = currentUser.toString();
                const isAssignee =
                    item.assignedToType === 'Employee' &&
                    item.assignedTo &&
                    (item.assignedTo._id || item.assignedTo).toString() === curBulk;
                const isHR = item.assignedToType === 'Company' && item.actionRequiredBy?.toString() === curBulk;
                const isActionRequired = item.actionRequiredBy?.toString() === curBulk;

                // Assigner / delegated primaryReportee
                const isAssigner =
                    !!item.assignedBy &&
                    (item.assignedBy._id || item.assignedBy).toString() === curBulk;

                let isPrimaryReporteeDelegate = false;
                if (item.assignedToType === 'Employee' && item.assignedTo && item.assignedTo.primaryReportee) {
                    const assigneeHasCompanyEmail = !!(
                        item.assignedTo.companyEmail && String(item.assignedTo.companyEmail).trim().length > 0
                    );
                    const managerId = item.assignedTo.primaryReportee._id || item.assignedTo.primaryReportee;
                    let assigneeHasPortalAccess = null;
                    if (typeof item.assignedTo.enablePortalAccess === 'boolean') {
                        assigneeHasPortalAccess = item.assignedTo.enablePortalAccess;
                    } else {
                        const assigneeEmpId = item.assignedTo.employeeId;
                        if (assigneeEmpId) {
                            const linkedUser = await User.findOne({ employeeId: assigneeEmpId, status: 'Active' })
                                .select('enablePortalAccess')
                                .lean()
                                .catch(() => null);
                            assigneeHasPortalAccess = !!(linkedUser && linkedUser.enablePortalAccess);
                        }
                    }
                    const allowDelegate =
                        managerId &&
                        managerId.toString() === curBulk &&
                        (assigneeHasPortalAccess === false || !assigneeHasCompanyEmail);
                    if (allowDelegate) isPrimaryReporteeDelegate = true;
                }

                if (!isAssignee && !isHR && !isActionRequired && !isAssigner && !isPrimaryReporteeDelegate) {
                    results.failed.push({ id: item.assetId, message: 'Unauthorized' });
                    continue;
                }

                if (action === 'Accept') {
                    // Handle handover
                    if (item.pendingAction === 'Asset Transfer' && isActionRequired) {
                        item.assignedTo = currentUser;
                        item.pendingAction = null;
                        item.pendingActionDetails = null;
                    } else if (item.pendingAction === 'Retention Confirmation' && isActionRequired) {
                        item.assignedBy = currentUser;
                        item.pendingAction = null;
                        item.pendingActionDetails = null;
                    }

                    item.status = 'Assigned';
                    item.acceptanceStatus = 'Accepted';
                    item.actionRequiredBy = null;
                    item.acceptedBy = currentUser;

                    // Stamp assignment start for Permanent + Temporary (days-assigned + temp expiry).
                    stampAssignmentDatesOnAccept(item);
                } else {
                    // Rejection
                    if (item.pendingAction === 'Asset Transfer') {
                        const oldOwnerId = item.pendingActionDetails?.transferFrom || item.assignedTo;
                        item.status = 'Pending';
                        item.acceptanceStatus = 'Pending';
                        item.pendingAction = 'Retention Confirmation';
                        item.actionRequiredBy = oldOwnerId;

                        try {
                            const oldHREmp = await EmployeeBasic.findById(oldOwnerId).select('employeeId firstName lastName');
                            await DashboardAction.create({
                                assignedTo: oldOwnerId,
                                assignedToEmpId: oldHREmp?.employeeId,
                                requestId: item._id,
                                requestType: 'Asset Retention',
                                subjectEmployeeId: oldHREmp?.employeeId,
                                subjectName: `${oldHREmp?.firstName || ""} ${oldHREmp?.lastName || ""}`.trim(),
                                requestedByName: req.user.name || 'New HR',
                                extra1: `${item.assetId} - ${item.name}`,
                                extra2: 'Handover Rejected (Bulk): Confirm you still have this asset',
                                status: 'Pending'
                            });
                        } catch (dashErr) {
                        }
                    } else {
                        item.status = 'Unassigned';
                        item.assignedTo = null;
                        item.assignedCompany = null;
                        item.assignedToType = null;
                        item.assignedBy = null;
                        item.acceptanceStatus = 'Rejected';
                        item.actionRequiredBy = null;
                    }

                    // Clear temporary assignment fields on rejection
                    item.assignmentType = null;
                    item.assignedDays = null;
                    item.assignedDate = null;
                    item.temporaryEndDate = null;
                    item.temporaryReminderSentAt = null;
                    item.temporaryExpiredSentAt = null;
                }

                await item.save();

                // Clear Dashboard Actions
                await DashboardAction.updateMany(
                    { requestId: item._id, assignedTo: currentUser, status: 'Pending' },
                    {
                        status: action === 'Accept' ? 'Approved' : 'Rejected',
                        actionedDate: new Date(),
                        actionedBy: currentUser,
                        comment: comments || 'Bulk Action'
                    }
                );

                if (bulkAssignGroupId) {
                    try {
                        await refreshBulkAssignmentDashboardIfGroupFullyResolved(bulkAssignGroupId, currentUser);
                    } catch (bdash) {
                    }
                }

                const priorAcceptedCountForReassign =
                    action === 'Accept'
                        ? await AssetHistory.countDocuments({ assetId: item._id, action: 'Accepted' })
                        : 0;

                // Log History
                await AssetHistory.create({
                    assetId: item._id,
                    action: action === 'Accept' ? 'Accepted' : 'Rejected',
                    performedBy: currentUser,
                    comments: `Bulk ${action}ed. ${comments || ''}`,
                    date: new Date()
                });

                if (action === 'Accept' && priorAcceptedCountForReassign >= 1) {
                    void notifyAssetControllerReassignmentAcceptedWithHandover(req, { assetMongoId: item._id });
                    void notifyPreviousAssigneeReassignmentAcceptedWithHandover(req, { assetMongoId: item._id });
                }

                results.success.push(item.assetId);

            } catch (err) {
                results.failed.push({ id: item.assetId, message: err.message });
            }
        }

        res.status(200).json({
            message: `Processed ${items.length} assets: ${results.success.length} successful, ${results.failed.length} failed.`,
            results
        });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

const canUserActAsAssigneeForBulkItem = (currentUserStr, item) => {
    const curBulk = currentUserStr;
    const assigneeId =
        item.assignedTo?._id?.toString?.() ||
        (item.assignedTo != null ? item.assignedTo.toString?.() : '') ||
        '';
    /** Real company-held assets use Company + assignedCompany; bulk AC assigns an employee only. */
    const isCompanyPoolAsset = item.assignedToType === 'Company' && item.assignedCompany;
    const assigneeMatchesUser = assigneeId && assigneeId === curBulk;
    const isAssignee = assigneeMatchesUser && !isCompanyPoolAsset;

    const actionRequiredId =
        item.actionRequiredBy?._id?.toString?.() || item.actionRequiredBy?.toString?.() || '';
    const isDesignatedResponder =
        !isCompanyPoolAsset && !!actionRequiredId && actionRequiredId === curBulk;

    let isPrimaryReporteeDelegate = false;
    if (!isCompanyPoolAsset && item.assignedTo && item.assignedTo.primaryReportee) {
        const assigneeHasCompanyEmail = !!(
            item.assignedTo.companyEmail && String(item.assignedTo.companyEmail).trim().length > 0
        );
        const managerId = item.assignedTo.primaryReportee._id || item.assignedTo.primaryReportee;
        const assigneeHasPortalAccess =
            typeof item.assignedTo.enablePortalAccess === 'boolean'
                ? item.assignedTo.enablePortalAccess
                : null;
        const allowDelegate =
            managerId &&
            managerId.toString() === curBulk &&
            (assigneeHasPortalAccess === false || !assigneeHasCompanyEmail);
        if (allowDelegate) isPrimaryReporteeDelegate = true;
    }
    return { isAssignee, isPrimaryReporteeDelegate, isDesignatedResponder };
};

const canUserActOnCompanyBulkAssignment = async (req, currentUserStr, item) => {
    const isCompanyPoolAsset = item?.assignedToType === 'Company' && item?.assignedCompany;
    if (!isCompanyPoolAsset) return false;
    const actionRequiredId =
        item.actionRequiredBy?._id?.toString?.() || item.actionRequiredBy?.toString?.() || '';
    if (actionRequiredId && actionRequiredId === currentUserStr) return true;
    return isUserCompanyAssetCoordinator(req.user).catch(() => false);
};

const parseDashboardExtra3 = (raw) => {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

const bulkAssignmentAssetSetKey = (bulkAssetIds = []) =>
    [...new Set(bulkAssetIds.map((x) => String(x).trim()).filter(Boolean))].sort().join(',');

/** Close stale pending bulk-assignment bell rows that overlap a new batch (double-submit / retry). */
const supersedeOverlappingPendingBulkAssignmentRows = async (assetIdStrings, actionedBy) => {
    const assetSet = new Set(assetIdStrings.map(String));
    if (!assetSet.size) return;

    const rows = await DashboardAction.find({
        status: 'Pending',
        requestType: 'Asset',
        extra3: { $exists: true, $nin: [null, ''] },
    })
        .select('_id extra3')
        .lean();

    for (const da of rows) {
        const p = parseDashboardExtra3(da.extra3);
        if (!p?.isBulkAssignment || !Array.isArray(p.bulkAssetIds)) continue;
        const overlap = p.bulkAssetIds.some((id) => assetSet.has(String(id)));
        if (!overlap) continue;
        await DashboardAction.findByIdAndUpdate(da._id, {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                actionedBy: actionedBy || null,
                comment: 'Superseded by a newer bulk assignment batch.',
            },
        });
    }

    const individualRows = await DashboardAction.find({
        status: 'Pending',
        requestType: 'Asset Assignment',
        requestId: { $in: [...assetSet] },
    })
        .select('_id')
        .lean();

    for (const da of individualRows) {
        await DashboardAction.findByIdAndUpdate(da._id, {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                actionedBy: actionedBy || null,
                comment: 'Superseded by a newer bulk assignment batch.',
            },
        });
    }
};

/** Close stale pending bulk-action bell rows (leave / return / EOL / L&D) that overlap a new batch. */
const supersedeOverlappingPendingBulkActionRows = async (assetIdStrings, requestType, actionedBy) => {
    const assetSet = new Set(assetIdStrings.map(String));
    if (!assetSet.size || !requestType) return;

    const rows = await DashboardAction.find({
        status: 'Pending',
        requestType,
        extra3: { $exists: true, $nin: [null, ''] },
    })
        .select('_id extra3')
        .lean();

    for (const da of rows) {
        const p = parseDashboardExtra3(da.extra3);
        if (!p?.isBulk) continue;
        const ids = p.assetIds || p.bulkAssetIds || [];
        if (!Array.isArray(ids) || ids.length < 2) continue;
        const overlap = ids.some((id) => assetSet.has(String(id)));
        if (!overlap) continue;
        await DashboardAction.findByIdAndUpdate(da._id, {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                actionedBy: actionedBy || null,
                comment: 'Superseded by a newer bulk action request.',
            },
        });
    }
};

const BULK_ACTION_INBOX_TYPES = new Set([
    'Asset Leave',
    'Asset Return',
    'Asset End of Life',
    'Asset Loss Damage',
]);

const resolveBulkInboxAssetIds = (row) => {
    const meta = parseDashboardExtra3(row.extra3);
    if (Array.isArray(row.bulkAssetIds) && row.bulkAssetIds.length > 1) {
        return row.bulkAssetIds;
    }
    const ids = meta?.assetIds || meta?.bulkAssetIds;
    return Array.isArray(ids) ? ids : [];
};

/** One inbox row per bulk batch — keep newest when duplicates share group id or asset set. */
const dedupePendingBulkInboxItems = (items) => {
    const kept = [];
    const seenGroupIds = new Set();
    const seenBulkAssignAssetSets = new Set();
    const seenBulkActionKeys = new Set();

    const sorted = [...items].sort(
        (a, b) => new Date(b.requestedDate || 0) - new Date(a.requestedDate || 0),
    );

    for (const row of sorted) {
        const meta = parseDashboardExtra3(row.extra3);
        const isBulkAssign =
            row.bulkKind === 'assignment' && row.isBulk && meta?.isBulkAssignment === true;

        if (isBulkAssign) {
            const gid = meta.bulkAssignmentGroupId ? String(meta.bulkAssignmentGroupId) : '';
            if (gid && seenGroupIds.has(gid)) continue;

            const assetKey = bulkAssignmentAssetSetKey(row.bulkAssetIds || meta.bulkAssetIds);
            if (assetKey && seenBulkAssignAssetSets.has(assetKey)) continue;

            if (gid) seenGroupIds.add(gid);
            if (assetKey) seenBulkAssignAssetSets.add(assetKey);
            kept.push(row);
            continue;
        }

        const requestType = String(row.requestType || '').trim();
        const isBulkAction = row.isBulk && BULK_ACTION_INBOX_TYPES.has(requestType);
        if (isBulkAction) {
            const assetKey = bulkAssignmentAssetSetKey(resolveBulkInboxAssetIds(row));
            if (assetKey) {
                const dedupeKey = `${requestType}:${assetKey}`;
                if (seenBulkActionKeys.has(dedupeKey)) continue;
                seenBulkActionKeys.add(dedupeKey);
            }
        }

        kept.push(row);
    }

    kept.sort((a, b) => new Date(b.requestedDate || 0) - new Date(a.requestedDate || 0));
    return kept;
};

/** Complete all DashboardAction rows for an AC bulk assignment batch (extra3.isBulkAssignment). */
const markBulkAssignmentDashboardRowComplete = async (bulkGroupId, actionedBy, summaryComment) => {
    if (!bulkGroupId) return;
    const gid = String(bulkGroupId);
    const rows = await DashboardAction.find({
        status: 'Pending',
        requestType: 'Asset',
        extra3: { $exists: true, $nin: [null, ''] }
    })
        .select('_id extra3')
        .lean();
    for (const da of rows) {
        const p = parseDashboardExtra3(da.extra3);
        if (p?.isBulkAssignment === true && String(p.bulkAssignmentGroupId) === gid) {
            await DashboardAction.findByIdAndUpdate(da._id, {
                $set: {
                    status: 'Approved',
                    actionedDate: new Date(),
                    actionedBy,
                    comment: summaryComment
                }
            });
        }
    }
};

/** If no assets in this bulk-assignment batch are still pending, complete the single inbox row. */
const countPendingBulkAssignmentBatch = async (meta, bulkAssetIds = []) => {
    const gid = meta?.bulkAssignmentGroupId ? String(meta.bulkAssignmentGroupId) : '';
    if (gid) {
        const n = await AssetItem.countDocuments({
            'pendingActionDetails.bulkAssignment.groupId': gid,
            status: 'Pending',
            acceptanceStatus: 'Pending',
        });
        if (n > 0) return n;
    }
    const ids = (Array.isArray(bulkAssetIds) ? bulkAssetIds : [])
        .map((id) => String(id).trim())
        .filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (!ids.length) return 0;
    return AssetItem.countDocuments({
        _id: { $in: ids },
        status: 'Pending',
        acceptanceStatus: 'Pending',
    });
};

const isAssignmentAcknowledgmentStillPending = (asset) => {
    if (!asset) return false;
    if (asset.pendingAction) return false;
    if (asset.fleetHandoverActive) return true;
    return (
        asset.acceptanceStatus === 'Pending' &&
        (asset.status === 'Pending' || asset.status === 'Assigned')
    );
};

const isFleetVehicleInboxAsset = (asset, meta = null) => {
    if (isFleetHandoverDashboardMeta(meta)) return true;
    const plate = String(asset?.plateNumber || '').trim();
    return Boolean(plate);
};

const closeStaleAssignmentDashboardAction = async (
    dashboardActionId,
    comment = 'Auto-closed: assignment acknowledgment completed.',
) => {
    if (!dashboardActionId) return;
    await DashboardAction.findOneAndUpdate(
        { _id: dashboardActionId, status: 'Pending' },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment,
            },
        },
    );
};

/** One pending bell per asset per assignee (viewer sees each task once even if they hold multiple roles). */
const healDuplicatePendingAssignmentDashboardRows = async (requestId) => {
    if (!requestId || !mongoose.Types.ObjectId.isValid(String(requestId))) return;
    const rows = await DashboardAction.find({
        requestId,
        requestType: 'Asset Assignment',
        status: 'Pending',
    })
        .sort({ requestedDate: -1 })
        .select('_id assignedTo extra3 requestedDate')
        .lean();
    if (rows.length <= 1) return;

    const groups = new Map();
    for (const row of rows) {
        const assigneeKey = String(row.assignedTo || '');
        if (!groups.has(assigneeKey)) groups.set(assigneeKey, []);
        groups.get(assigneeKey).push(row);
    }

    for (const groupRows of groups.values()) {
        if (groupRows.length <= 1) continue;
        const sorted = [...groupRows].sort((a, b) => {
            const metaA = parseDashboardExtra3(a.extra3);
            const metaB = parseDashboardExtra3(b.extra3);
            const score = (meta) => {
                const role = String(meta?.handoverViewerRole || '').trim();
                if (role === 'actor') return 3;
                if (role === 'assigner') return 2;
                if (role === 'adminOfficer') return 1;
                return 0;
            };
            const diff = score(metaB) - score(metaA);
            if (diff !== 0) return diff;
            return new Date(b.requestedDate || 0) - new Date(a.requestedDate || 0);
        });
        const [, ...dupes] = sorted;
        for (const dupe of dupes) {
            await closeStaleAssignmentDashboardAction(
                dupe._id,
                'Auto-closed: duplicate assignment notification.',
            );
        }
    }
};

/** In-memory dedupe: one inbox row per asset assignment (not per handover viewer role). */
const dedupeAssignmentDashboardInboxRows = (items, parseExtra3Fn) => {
    const kept = [];
    const seen = new Set();
    const sorted = [...items].sort(
        (a, b) => new Date(b.requestedDate || 0) - new Date(a.requestedDate || 0),
    );
    for (const it of sorted) {
        if (String(it.requestType || '').trim() !== 'Asset Assignment' || !it.requestId) {
            kept.push(it);
            continue;
        }
        const meta = parseExtra3Fn(it.extra3);
        if (meta?.isBulkAssignment === true) {
            kept.push(it);
            continue;
        }
        const key = String(it.requestId);
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push(it);
    }
    return kept;
};

/** Recreate or reopen inbox rows when an asset still awaits acknowledgment but the bell row is missing or was wrongly auto-closed. */
const syncPendingAssignmentDashboardRowsForUser = async (relevantIds, targetEmployeeId) => {
    const actorIds = [
        ...new Set(
            (relevantIds || [])
                .map((id) => {
                    const s = String(id ?? '').trim();
                    return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
                })
                .filter(Boolean)
                .map((oid) => oid.toString()),
        ),
    ].map((s) => new mongoose.Types.ObjectId(s));
    if (!actorIds.length) return;

    const pendingAssets = await AssetItem.find({
        acceptanceStatus: 'Pending',
        status: { $in: ['Pending', 'Assigned'] },
        $or: [{ pendingAction: null }, { pendingAction: '' }, { pendingAction: { $exists: false } }],
        actionRequiredBy: { $in: actorIds },
    })
        .select(
            'assetId name assignmentType actionRequiredBy assignedTo assignedToType assignedCompany assignedBy pendingActionDetails',
        )
        .populate('assignedTo', 'employeeId firstName lastName')
        .populate('assignedCompany', 'name companyId')
        .populate('actionRequiredBy', 'employeeId')
        .populate('assignedBy', 'firstName lastName')
        .lean();

    for (const item of pendingAssets) {
        if (item.pendingActionDetails?.bulkAssignment?.groupId) continue;

        let subjectName = '';
        let subjectEmpId = '';
        if (item.assignedToType === 'Company') {
            subjectName = item.assignedCompany?.name || 'Company';
            subjectEmpId = item.assignedCompany?.companyId || '';
        } else if (item.assignedTo) {
            subjectName = `${item.assignedTo.firstName || ''} ${item.assignedTo.lastName || ''}`.trim();
            subjectEmpId = item.assignedTo.employeeId || '';
        }

        const actorRef = item.actionRequiredBy;
        const actorId = actorRef?._id || actorRef;
        if (!actorId) continue;

        const actorEmpId = actorRef?.employeeId || targetEmployeeId || '';
        const assigner = item.assignedBy;
        const requestedByName = assigner
            ? `${assigner.firstName || 'System'} ${assigner.lastName || ''}`.trim()
            : 'System';

        const existingRow = await DashboardAction.findOne({
            requestId: item._id,
            requestType: 'Asset Assignment',
        })
            .select('status extra3')
            .lean();
        if (existingRow?.status === 'Dismissed') continue;

        const handoverFlowHeal = item.pendingActionDetails?.vehicleHandoverFlow;
        const isFleetHandover =
            handoverFlowHeal?.historyId &&
            (isFleetVehicleAssetFields({
                plateNumber: item.plateNumber,
            }) ||
                String(existingRow?.extra3 || '').includes('"isFleetVehicle"'));

        const actorRowFilter = isFleetHandover
            ? { extra3: { $regex: '"handoverViewerRole"\\s*:\\s*"actor"', $options: 'i' } }
            : {};

        await DashboardAction.findOneAndUpdate(
            { requestId: item._id, requestType: 'Asset Assignment', ...actorRowFilter },
            {
                $set: {
                    assignedTo: actorId,
                    assignedToEmpId: actorEmpId,
                    requestId: item._id,
                    requestType: 'Asset Assignment',
                    subjectEmployeeId: subjectEmpId,
                    subjectName,
                    requestedByName,
                    extra1: `${item.assetId} — ${item.name}`,
                    extra2: isFleetHandover ? 'Vehicle Handover' : item.assignmentType || '',
                    ...(isFleetHandover
                        ? {
                              extra3: buildHandoverDashboardExtra3(
                                  item._id,
                                  handoverFlowHeal.historyId,
                                  { viewerRole: 'actor' },
                              ),
                          }
                        : {}),
                    status: 'Pending',
                    actionedDate: null,
                    actionedBy: null,
                    comment: null,
                },
                $setOnInsert: { requestedDate: new Date() },
            },
            { upsert: true, setDefaultsOnInsert: true },
        );
        await healDuplicatePendingAssignmentDashboardRows(item._id).catch(() => null);

        if (isFleetHandover && assigner?._id) {
            await upsertHandoverAssignerDashboardAction({
                asset: item,
                assigner: typeof assigner === 'object' && assigner._id ? assigner : await EmployeeBasic.findById(assigner).lean(),
                historyId: handoverFlowHeal.historyId,
                subjectName,
                subjectEmpId,
            }).catch(() => null);
            const adminOfficer = await resolveAdminOfficerEmployee();
            if (adminOfficer?._id) {
                await upsertHandoverAdminOfficerDashboardAction({
                    asset: item,
                    adminOfficer,
                    historyId: handoverFlowHeal.historyId,
                    subjectName,
                    subjectEmpId,
                    stageLabel: 'Vehicle Handover — admin review required',
                }).catch(() => null);
            }
            if (item.assignedTo && item.assignedToType === 'Employee') {
                const assigneeRef =
                    typeof item.assignedTo === 'object' && item.assignedTo._id
                        ? item.assignedTo
                        : await EmployeeBasic.findById(item.assignedTo)
                              .select('firstName lastName employeeId companyEmail workEmail personalEmail email')
                              .lean()
                              .catch(() => null);
                const actorId = String(actorRef?._id || actorRef || '');
                const assigneeId = String(assigneeRef?._id || '');
                if (assigneeRef?._id && assigneeId && assigneeId !== actorId) {
                    await upsertHandoverTargetAssigneeDashboardAction({
                        asset: item,
                        assignee: assigneeRef,
                        historyId: handoverFlowHeal.historyId,
                        subjectName,
                        subjectEmpId,
                        assigner,
                    }).catch(() => null);
                }
            }
        }
    }
};

/** If no assets in this bulk-assignment batch are still pending, complete the single inbox row. */
const refreshBulkAssignmentDashboardIfGroupFullyResolved = async (groupId, actionedBy, comment = 'Bulk assignment completed.') => {
    if (!groupId) return;
    const gid = String(groupId);
    const pendingLeft = await AssetItem.countDocuments({
        'pendingActionDetails.bulkAssignment.groupId': gid,
        status: 'Pending',
        acceptanceStatus: 'Pending'
    });
    if (pendingLeft === 0) {
        await markBulkAssignmentDashboardRowComplete(gid, actionedBy, comment);
    }
};

// @desc    Pending bulk assignment (AC batch) — list assets for assignee review modal
// @route   GET /api/AssetItem/bulk-assignment-pending/:groupId
// @access  Private
export const getBulkAssignmentPendingGroup = async (req, res) => {
    try {
        const { groupId } = req.params;
        if (!groupId || !mongoose.Types.ObjectId.isValid(String(groupId))) {
            return res.status(400).json({ message: 'Invalid group id' });
        }
        const gid = String(groupId);
        const currentUser = req.user.employeeObjectId;
        if (!currentUser) {
            return res.status(403).json({ message: 'You are not linked to an employee profile.' });
        }
        const cur = currentUser.toString();

        const allInGroup = await AssetItem.find({
            'pendingActionDetails.bulkAssignment.groupId': gid,
            status: 'Pending',
            acceptanceStatus: 'Pending'
        })
            .populate('assignedTo', 'firstName lastName employeeId companyEmail primaryReportee')
            .populate('assignedCompany', 'name companyId')
            .populate('actionRequiredBy', '_id employeeId')
            .populate('categoryId', 'name')
            .populate('assignedBy', 'firstName lastName employeeId')
            .lean();

        if (!allInGroup.length) {
            await markBulkAssignmentDashboardRowComplete(
                gid,
                null,
                'Auto-closed: bulk assignment batch completed.',
            );
            return res.status(404).json({ message: 'No pending batch found for this link.' });
        }

        const firstAssigneeRef = allInGroup[0].assignedTo;
        const isCompanyBatch =
            allInGroup[0].assignedToType === 'Company' && allInGroup[0].assignedCompany;

        if (isCompanyBatch) {
            const targetCompanyId =
                allInGroup[0].assignedCompany?._id?.toString?.() ||
                allInGroup[0].assignedCompany?.toString?.();
            const allSameCompany = allInGroup.every((i) => {
                const cid = i.assignedCompany?._id?.toString?.() || i.assignedCompany?.toString?.();
                return cid === targetCompanyId;
            });
            if (!allSameCompany) {
                return res.status(400).json({ message: 'Batch data is inconsistent.' });
            }
            const canActCompany = await canUserActOnCompanyBulkAssignment(req, cur, allInGroup[0]);
            if (!canActCompany) {
                return res.status(403).json({ message: 'You are not authorized to review this batch.' });
            }
        } else {
            const targetAssigneeId = firstAssigneeRef?._id?.toString?.() || firstAssigneeRef?.toString?.();
            const allSameAssignee = allInGroup.every((i) => {
                const r = i.assignedTo;
                const id = r?._id?.toString?.() || r?.toString?.();
                return id === targetAssigneeId;
            });
            if (!allSameAssignee) {
                return res.status(400).json({ message: 'Batch data is inconsistent.' });
            }

            const firstAsDoc = await AssetItem.findById(allInGroup[0]._id).populate({
                path: 'assignedTo',
                select: 'employeeId companyEmail primaryReportee enablePortalAccess',
                populate: { path: 'primaryReportee', select: '_id' },
            });
            const wrapItem = firstAsDoc ? firstAsDoc.toObject() : allInGroup[0];
            const { isAssignee, isPrimaryReporteeDelegate, isDesignatedResponder } =
                canUserActAsAssigneeForBulkItem(cur, wrapItem);
            if (!isAssignee && !isPrimaryReporteeDelegate && !isDesignatedResponder) {
                return res.status(403).json({ message: 'You are not authorized to review this batch.' });
            }
        }

        return res.status(200).json({
            groupId: gid,
            items: allInGroup.map((row) => ({
                _id: row._id,
                assetId: row.assetId,
                name: row.name,
                status: row.status,
                assignmentType: row.assignmentType,
                assignedDays: row.assignedDays,
                categoryId: row.categoryId,
                assignedBy: row.assignedBy,
                bulkAssignment: row.pendingActionDetails?.bulkAssignment || null
            }))
        });
    } catch (e) {
        res.status(500).json({ message: 'Server Error' });
    }
};

/** PDFs + emails after bulk accept/reject — keeps HTTP response fast for the assignee UI. */
async function runBulkAssignmentRespondSideEffects(
    req,
    { acceptedPdfJobs = [], emailBundle = null } = {},
) {
    for (const job of acceptedPdfJobs) {
        try {
            const pdfBuf = await generateBulkAssignmentHandoverPdf(
                req,
                [job.assetMongoId],
                await finalizeHandoverPdfCtx(
                    buildFullySignedHandoverCtx(job.handoverPdfCtx),
                    {
                        assigner: job.handoverPdfCtx.assigner,
                        assignee: job.handoverPdfCtx.assignee,
                    },
                ),
            );
            if (pdfBuf?.length && job.acceptHistDocId) {
                const fk = await persistHandoverPdfBufferToHistory(
                    pdfBuf,
                    `bulk-accept-${job.assetCode}-${job.acceptHistDocId}.pdf`,
                );
                if (fk) {
                    await AssetHistory.updateOne({ _id: job.acceptHistDocId }, { $set: { file: fk } });
                }
            }
        } catch (bulkAcceptPdfErr) {
        }
        if (job.priorAcceptedCount >= 1) {
            void notifyAssetControllerReassignmentAcceptedWithHandover(req, {
                assetMongoId: job.assetMongoId,
            });
            void notifyPreviousAssigneeReassignmentAcceptedWithHandover(req, {
                assetMongoId: job.assetMongoId,
            });
        }
    }

    if (!emailBundle) return;

    const {
        firstAssignedTo,
        acceptedSummary,
        rejectedSummary,
        acceptedMongoIds,
        gid,
        responderDisplayName,
        isPrimaryReporteeDelegate,
        comments,
        firstAssignedBy,
        accepted,
        rejected,
        currentUser,
    } = emailBundle;

    try {
        await notifyBulkAssignmentResponseEmails(req, {
            acceptedMongoIds,
            rejectedMongoIds: rejected,
            acceptedSummary,
            rejectedSummary,
            assigneeEmployee: firstAssignedTo,
            assignerId: firstAssignedBy?._id || firstAssignedBy,
            responderEmployeeId: currentUser,
            responderName: responderDisplayName,
            comments: String(comments || '').trim(),
            isDelegate: isPrimaryReporteeDelegate,
        });
    } catch (summaryMailErr) {
    }
}

// @desc    Respond to AC bulk assignment batch (per-asset accept/reject)
// @route   PUT /api/AssetItem/bulk-assignment-respond
// @access  Private
export const respondBulkAssignmentGroup = async (req, res) => {
    try {
        const { groupId, acceptedAssetIds = [], rejectedAssetIds = [], comments = '' } = req.body;

        if (!groupId || !mongoose.Types.ObjectId.isValid(String(groupId))) {
            return res.status(400).json({ message: 'Invalid group id' });
        }
        const gid = String(groupId);
        const accepted = [...new Set((acceptedAssetIds || []).map(String))];
        const rejected = [...new Set((rejectedAssetIds || []).map(String))];
        const overlap = accepted.filter((id) => rejected.includes(id));
        if (overlap.length) {
            return res.status(400).json({ message: 'An asset cannot be both accepted and rejected.' });
        }
        if (accepted.length + rejected.length === 0) {
            return res.status(400).json({ message: 'Select at least one asset to accept or reject.' });
        }

        const currentUser = req.user.employeeObjectId;
        if (!currentUser) {
            return res.status(403).json({ message: 'You are not linked to an employee profile.' });
        }
        const cur = currentUser.toString();

        const allInGroup = await AssetItem.find({
            'pendingActionDetails.bulkAssignment.groupId': gid,
            status: 'Pending',
            acceptanceStatus: 'Pending'
        }).populate({
            path: 'assignedTo',
            select: 'employeeId companyEmail primaryReportee enablePortalAccess firstName lastName department',
            populate: { path: 'primaryReportee', select: '_id companyEmail firstName lastName' },
        })
            .populate('assignedCompany', 'name companyId')
            .populate('actionRequiredBy', '_id employeeId')
            .populate({ path: 'assignedBy', select: 'firstName lastName employeeId companyEmail workEmail' });

        if (!allInGroup.length) {
            return res.status(404).json({ message: 'No pending batch found.' });
        }

        const expectedIds = new Set(allInGroup.map((a) => a._id.toString()));
        for (const id of [...accepted, ...rejected]) {
            if (!expectedIds.has(id)) {
                return res.status(400).json({ message: 'One or more asset ids are not part of this pending batch.' });
            }
        }
        if (accepted.length + rejected.length !== expectedIds.size) {
            return res.status(400).json({ message: 'You must respond to every asset in this batch (accept or reject each).' });
        }

        const first = allInGroup[0];
        const isCompanyBatch = first.assignedToType === 'Company' && first.assignedCompany;
        let isPrimaryReporteeDelegate = false;
        if (isCompanyBatch) {
            const canActCompany = await canUserActOnCompanyBulkAssignment(req, cur, first);
            if (!canActCompany) {
                return res.status(403).json({ message: 'You are not authorized to respond to this batch.' });
            }
        } else {
            const delegateCheck = canUserActAsAssigneeForBulkItem(cur, first);
            isPrimaryReporteeDelegate = delegateCheck.isPrimaryReporteeDelegate;
            if (
                !delegateCheck.isAssignee &&
                !delegateCheck.isPrimaryReporteeDelegate &&
                !delegateCheck.isDesignatedResponder
            ) {
                return res.status(403).json({ message: 'You are not authorized to respond to this batch.' });
            }
        }

        const byId = new Map(allInGroup.map((a) => [a._id.toString(), a]));
        const rejectMetaById = new Map();
        const results = { accepted: [], rejected: [] };
        const acceptedPdfJobs = [];

        for (const idStr of accepted) {
            const item = byId.get(idStr);
            if (!item) continue;
            item.status = 'Assigned';
            item.acceptanceStatus = 'Accepted';
            item.actionRequiredBy = null;
            item.acceptedBy = currentUser;
            item.pendingActionDetails = null;
            stampAssignmentDatesOnAccept(item);
            await item.save();

            const snapshotItem = await AssetItem.findById(item._id)
                .populate('categoryId typeId acceptedBy accessories assignedCompany')
                .populate({
                    path: 'assignedTo',
                    populate: [{ path: 'primaryReportee', select: 'firstName lastName employeeId' }]
                })
                .populate({ path: 'assignedBy', select: 'firstName lastName employeeId signature' });

            const snap = snapshotItem ? snapshotItem.toObject() : {};
            let subjectEmployeeName = '—';
            let subjectCode = '—';
            let subjectDept = '—';
            let hodDisplay = '—';
            if (item.assignedToType === 'Company') {
                const comp = await Company.findById(item.assignedCompany).select('name companyId').lean();
                subjectEmployeeName = comp?.name || '—';
                subjectCode = comp?.companyId || '—';
                subjectDept = '—';
            } else {
                const ato = snap.assignedTo;
                subjectEmployeeName = ato ? `${ato.firstName || ''} ${ato.lastName || ''}`.trim() : '—';
                subjectCode = ato?.employeeId || '—';
                subjectDept = (ato?.department && String(ato.department).trim()) || '—';
                const hodFromReportee = ato?.primaryReportee;
                if (hodFromReportee && typeof hodFromReportee === 'object') {
                    hodDisplay =
                        `${hodFromReportee.firstName || ''} ${hodFromReportee.lastName || ''}`.trim() ||
                        hodFromReportee.employeeId ||
                        '—';
                }
            }
            const assignerNameStr = snap.assignedBy
                ? `${snap.assignedBy.firstName || ''} ${snap.assignedBy.lastName || ''}`.trim()
                : '—';

            let assigneeForBulkAck = null;
            if (item.assignedToType !== 'Company' && item.assignedTo) {
                assigneeForBulkAck = await EmployeeBasic.findById(item.assignedTo._id || item.assignedTo)
                    .select('firstName lastName employeeId signature')
                    .lean();
            } else if (item.assignedToType === 'Company') {
                assigneeForBulkAck = await EmployeeBasic.findById(currentUser)
                    .select('firstName lastName signature')
                    .lean();
            }

            const acceptHistDoc = await AssetHistory.create({
                assetId: item._id,
                action: 'Accepted',
                assignedToType: item.assignedToType,
                assignedTo: item.assignedTo,
                assignedCompany: item.assignedCompany,
                performedBy: currentUser,
                comments: isPrimaryReporteeDelegate
                    ? `Accepted by manager on behalf of employee (bulk). ${comments || ''}`
                    : comments || 'Accepted (bulk batch)',
                details: snap,
            });

            const priorAcceptedCount = await AssetHistory.countDocuments({
                assetId: item._id,
                action: 'Accepted',
            });
            acceptedPdfJobs.push({
                assetMongoId: item._id.toString(),
                assetCode: item.assetId,
                acceptHistDocId: acceptHistDoc._id,
                priorAcceptedCount,
                handoverPdfCtx: {
                    assigner: snap.assignedBy,
                    assignerName: assignerNameStr,
                    assignee: assigneeForBulkAck,
                    assigneeName: subjectEmployeeName,
                    employeeCode: subjectCode,
                    department: subjectDept,
                    hodName: hodDisplay,
                },
            });

            await updateAssetTypeCounts(item.typeId);
            results.accepted.push(item.assetId);
        }

        for (const idStr of rejected) {
            const item = byId.get(idStr);
            if (!item) continue;

            const bulkMeta = item.pendingActionDetails?.bulkAssignment;
            const revertTo = bulkMeta?.revertToEmployeeId;
            rejectMetaById.set(idStr, {
                revertToEmployeeId: revertTo || null,
                revertToDisplayName: bulkMeta?.revertToDisplayName || null,
            });

            if (revertTo) {
                let ownershipLabel = bulkMeta?.revertToDisplayName || '';
                if (!ownershipLabel) {
                    const e = await EmployeeBasic.findById(revertTo).select('firstName lastName').lean();
                    ownershipLabel = e ? `${e.firstName || ''} ${e.lastName || ''}`.trim() : '';
                }
                item.assignedTo = revertTo;
                item.assignedToType = 'Employee';
                item.status = 'Assigned';
                item.acceptanceStatus = 'Accepted';
                item.actionRequiredBy = null;
                item.acceptedBy = null;
                item.pendingActionDetails = null;
                if (ownershipLabel) item.ownership = ownershipLabel;
            } else {
                item.status = 'Unassigned';
                item.assignedTo = null;
                item.assignedCompany = null;
                item.assignedToType = null;
                item.assignedBy = null;
                item.assignmentType = null;
                item.assignedDays = null;
                item.assignedDate = null;
                item.temporaryEndDate = null;
                item.temporaryReminderSentAt = null;
                item.temporaryExpiredSentAt = null;
                item.acceptanceStatus = 'Rejected';
                item.actionRequiredBy = null;
                item.pendingActionDetails = null;
                item.ownership = null;
            }

            item.negotiationHistory = [];
            await item.save();

            await AssetHistory.create({
                assetId: item._id,
                action: 'Rejected',
                assignedToType: item.assignedToType,
                assignedTo: revertTo || null,
                assignedCompany: null,
                performedBy: currentUser,
                comments: comments || (revertTo ? 'Bulk assignment declined — returned to previous assignee.' : 'Bulk assignment declined — returned to unassigned.'),
                details: { bulkBatchReject: true, revertTo: revertTo || null }
            });

            await updateAssetTypeCounts(item.typeId);
            results.rejected.push(item.assetId);
        }

        await markBulkAssignmentDashboardRowComplete(
            gid,
            currentUser,
            `Bulk assignment: ${results.accepted.length} accepted, ${results.rejected.length} declined.${comments ? ` ${comments}` : ''}`.trim()
        );

        const acceptedSummary = accepted.map((idStr) => {
            const item = byId.get(idStr);
            return { assetId: item?.assetId, name: item?.name };
        });
        const rejectedSummary = rejected.map((idStr) => {
            const item = byId.get(idStr);
            const meta = rejectMetaById.get(idStr);
            const note = meta?.revertToEmployeeId
                ? `Returned to ${meta.revertToDisplayName || 'previous assignee'}`
                : 'Returned to unassigned';
            return { assetId: item?.assetId, name: item?.name, note };
        });

        const responderEmp = await EmployeeBasic.findById(currentUser)
            .select('firstName lastName')
            .lean();
        const responderDisplayName =
            `${responderEmp?.firstName || ''} ${responderEmp?.lastName || ''}`.trim() ||
            req.user?.name ||
            'Assignee';

        setImmediate(() => {
            runBulkAssignmentRespondSideEffects(req, {
                acceptedPdfJobs,
                emailBundle: {
                    firstAssignedTo: first.assignedTo,
                    firstAssignedBy: first.assignedBy,
                    acceptedSummary,
                    rejectedSummary,
                    acceptedMongoIds: accepted,
                    gid,
                    responderDisplayName,
                    isPrimaryReporteeDelegate,
                    comments,
                    accepted,
                    rejected,
                    currentUser,
                },
            }).catch(() => null);
        });

        return res.status(200).json({
            message: `Batch processed: ${results.accepted.length} accepted, ${results.rejected.length} declined.`,
            results
        });
    } catch (e) {
        const detail = e?.message || 'Server Error';
        res.status(500).json({
            message: process.env.NODE_ENV === 'production' ? 'Server Error' : detail,
        });
    }
};

// @desc    Return an asset item (unassign)
// @route   PUT /api/AssetItem/:id/return
// @access  Private
export const returnAssetItem = async (req, res) => {
    try {
        const { id } = req.params;

        const item = await AssetItem.findById(id).populate('typeId', 'name');

        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const fleetVehicle = isFleetVehicleAssetFields({
            plateNumber: item.plateNumber,
            typeName: item.typeId?.name,
        });

        if (fleetVehicle && !isFleetVehicleProfileActive(item)) {
            return res.status(400).json({ message: FLEET_PROFILE_INACTIVE_ASSIGNMENT_MSG });
        }

        if (fleetVehicle && String(item.status || '').trim().toLowerCase() !== 'assigned') {
            return res.status(400).json({
                message: 'Return is available only when the vehicle status is Assigned.',
            });
        }

        const isJwtAdmin = isJwtSystemSuperUser(req.user);
        const isSysAdmin = await isUserAdministrator(req.user?.id);
        const isAcFlow = await isUserInFlowchart(req.user, 'assetcontroller');
        const isAdminOfficerFlow = fleetVehicle
            ? await isUserInFlowchart(req.user, 'admincontroller').catch(() => false)
            : false;
        const isHrFlow = fleetVehicle ? await isUserInFlowchart(req.user, 'hr').catch(() => false) : false;
        const hrHod = fleetVehicle ? await getDepartmentHOD('hr').catch(() => null) : null;
        const matchesDeptHr =
            fleetVehicle &&
            !!hrHod?._id &&
            req.user?.employeeObjectId &&
            hrHod._id.toString() === req.user.employeeObjectId.toString();
        const isCompanyCoordinatorFlow = await isUserActiveCompanyAssetCoordinator(
            req.user?.employeeObjectId,
            req.user?.employeeId
        );
        const hodAc = await getDepartmentHOD('assetcontroller');
        const matchesDeptAc =
            !!hodAc?._id &&
            req.user?.employeeObjectId &&
            hodAc._id.toString() === req.user.employeeObjectId.toString();
        const isCompanyAssignedAsset = item.assignedToType === 'Company' && !!item.assignedCompany;
        const isElevatedReturn =
            isJwtAdmin ||
            isSysAdmin ||
            isAcFlow ||
            matchesDeptAc ||
            isAdminOfficerFlow ||
            (fleetVehicle && (isHrFlow || matchesDeptHr)) ||
            (isCompanyCoordinatorFlow && isCompanyAssignedAsset);

        let currentEmpId = req.user?.employeeObjectId?.toString();
        if (!currentEmpId && req.user?.employeeId) {
            const empRow = await EmployeeBasic.findOne({
                employeeId: { $regex: new RegExp(`^${String(req.user.employeeId).replace(/\s+/g, '\\s*')}$`, 'i') }
            })
                .select('_id')
                .lean();
            if (empRow) currentEmpId = empRow._id.toString();
        }
        const isAssigneeReturn =
            !!item.assignedTo && !!currentEmpId && item.assignedTo.toString() === currentEmpId;

        if (item.assignedTo) {
            if (!isElevatedReturn && !isAssigneeReturn) {
                return res.status(403).json({
                    message: fleetVehicle
                        ? 'Only the assigned employee, Admin Officer, HR, or an administrator can return this vehicle.'
                        : 'Only the assigned employee, Asset Controller, or an administrator can return this asset.'
                });
            }
        } else {
            if (!isElevatedReturn) {
                return res.status(403).json({
                    message: fleetVehicle
                        ? 'Only Admin Officer, HR, or an administrator can return a vehicle that is not assigned to an employee.'
                        : 'Only Asset Controller or an administrator can return an asset that is not assigned to an employee.'
                });
            }
        }

        const fleetReturnApprover = fleetVehicle
            ? hrHod
                ? await resolveAssetControllerEmployee(hrHod)
                : null
            : null;
        const assetController = fleetVehicle ? fleetReturnApprover : hodAc;
        if (!assetController && !isAssigneeReturn) {
            return res.status(403).json({
                message: fleetVehicle
                    ? "Vehicle return denied: No HR assignee has been configured in the organization flow. Please assign HR in Settings > Flowchart before performing this operation."
                    : "Asset return denied: No Asset Controller has been assigned in the organization flow. Please assign an Asset Controller in Settings > Flowchart before performing this operation."
            });
        }

        // If an assigned employee requests return (non-elevated), route it to HR (fleet) or Asset Controller for approval
        // with dashboard + email, instead of immediately unassigning.
        if (isAssigneeReturn && !isElevatedReturn) {
            if (!assetController?._id) {
                return res.status(400).json({
                    message: fleetVehicle
                        ? 'HR assignee not found. Cannot request return approval.'
                        : 'Asset Controller not found. Cannot request return approval.',
                });
            }

            const requesterEmp = await EmployeeBasic.findById(req.user.employeeObjectId).select('firstName lastName employeeId').lean().catch(() => null);
            const requesterName = requesterEmp ? `${requesterEmp.firstName || ''} ${requesterEmp.lastName || ''}`.trim() : (req.user.name || req.user.employeeId || 'User');

            const rawBulkIds = Array.isArray(req.body?.bulkAssetIds) ? req.body.bulkAssetIds.map((x) => String(x).trim()).filter(Boolean) : [];
            const currentIdStr = item._id.toString();
            const uniqueBulk = Array.from(new Set([currentIdStr, ...rawBulkIds]));
            const isBulkReturn = uniqueBulk.length > 1;

            if (!isBulkReturn) {
                if (item.pendingAction) {
                    return res.status(400).json({ message: `This asset already has a pending "${item.pendingAction}" request.` });
                }

                // Single assignee return: no PDF — asset details are included in the AC notification email body.
                const singleReturnAttachments = [];

                item.pendingAction = 'Return Asset';
                item.pendingActionDetails = {
                    reason: req.body?.reason || 'Return requested by assigned employee',
                    requestedBy: req.user.employeeObjectId || req.user._id,
                    requestedAt: new Date()
                };
                item.actionRequiredBy = assetController._id; // EmployeeBasic
                item.status = 'Pending';

                await item.save();

                await DashboardAction.create({
                    assignedTo: assetController._id,
                    assignedToEmpId: assetController.employeeId,
                    requestId: item._id,
                    requestType: 'Asset Return',
                    status: 'Pending',
                    subjectEmployeeId: req.user.employeeId || (requesterEmp?.employeeId || 'UNASSIGNED'),
                    subjectName: requesterName || 'Employee',
                    requestedByName: requesterName,
                    extra1: `${item.assetId} — ${item.name || ''}`,
                    extra2: 'Return Asset'
                });

                try {
                    await sendAssetActionApprovalEmail(
                        item,
                        'Return Asset',
                        assetController,
                        { name: requesterName },
                        item.pendingActionDetails?.reason || '',
                        singleReturnAttachments
                    );
                } catch (e) {
                    // non-fatal
                }

                return res.status(200).json({
                    message: fleetVehicle
                        ? 'Return request sent to HR for approval'
                        : 'Return request sent to Asset Controller for approval',
                    asset: item
                });
            }

            // Bulk return (same assignee): multiple assets, one dashboard row on primary (URL param asset).
            const bulkAssets = await AssetItem.find({ _id: { $in: uniqueBulk } });
            if (bulkAssets.length !== uniqueBulk.length) {
                return res.status(404).json({ message: 'One or more assets not found' });
            }

            const requesterOid = req.user.employeeObjectId?.toString();
            for (const a of bulkAssets) {
                if (!a.assignedTo || a.assignedTo.toString() !== requesterOid) {
                    return res.status(403).json({ message: 'All selected assets must be assigned to you.' });
                }
                if (a.pendingAction) {
                    return res.status(400).json({ message: `Asset ${a.assetId} already has a pending "${a.pendingAction}" request.` });
                }
                if (a.status !== 'Assigned') {
                    return res.status(400).json({ message: `Asset ${a.assetId} must be Assigned to request return.` });
                }
            }

            const reason = req.body?.reason || 'Return requested by assigned employee';
            const bulkAssetIdsOrdered = uniqueBulk;

            let bulkReturnAttachments;
            try {
                bulkReturnAttachments = await requireBulkAssetInventoryPdfAttachment(
                    req,
                    bulkAssetIdsOrdered,
                    'bulk-return-inventory'
                );
            } catch (pdfErr) {
                return res.status(503).json({
                    message:
                        pdfErr?.message ||
                        'Could not generate the asset list PDF. Return request was not submitted.'
                });
            }

            for (const a of bulkAssets) {
                a.pendingAction = 'Return Asset';
                a.pendingActionDetails = {
                    reason,
                    requestedBy: req.user.employeeObjectId || req.user._id,
                    requestedAt: new Date(),
                    isBulk: true,
                    bulkAssetIds: bulkAssetIdsOrdered
                };
                a.actionRequiredBy = assetController._id;
                a.status = 'Pending';
                await a.save();

                await AssetHistory.create({
                    assetId: a._id,
                    action: 'Comment',
                    performedBy: req.user._id,
                    comments: `Bulk Return Asset request submitted. Reason: ${reason}`,
                    date: new Date(),
                    details: { type: 'BulkReturnRequest', action: 'Return Asset', bulkAssetIds: bulkAssetIdsOrdered }
                });
            }

            const primaryAsset = bulkAssets.find((a) => a._id.toString() === currentIdStr) || bulkAssets[0];
            const assetSummary = bulkAssets.map((a) => `${a.assetId} — ${a.name || ''}`).join('; ');
            const extra1 =
                bulkAssets.length > 1
                    ? `Bulk Return (${bulkAssets.length} assets): ${assetSummary.substring(0, 200)}${assetSummary.length > 200 ? '...' : ''}`
                    : `${primaryAsset.assetId} — ${primaryAsset.name || ''}`;

            if (bulkAssets.length > 1) {
                await supersedeOverlappingPendingBulkActionRows(
                    bulkAssetIdsOrdered,
                    'Asset Return',
                    req.user.employeeObjectId,
                );
            }

            await DashboardAction.create({
                assignedTo: assetController._id,
                assignedToEmpId: assetController.employeeId,
                requestId: primaryAsset._id,
                requestType: 'Asset Return',
                status: 'Pending',
                subjectEmployeeId: req.user.employeeId || (requesterEmp?.employeeId || 'UNASSIGNED'),
                subjectName: requesterName || 'Employee',
                requestedByName: requesterName,
                extra1,
                extra2: 'Return Asset',
                extra3:
                    bulkAssets.length > 1
                        ? JSON.stringify({
                            isBulk: true,
                            totalAssets: bulkAssets.length,
                            assetIds: bulkAssetIdsOrdered
                        })
                        : null
            });

            try {
                await sendAssetActionApprovalEmail(
                    { ...primaryAsset.toObject(), assetId: primaryAsset.assetId, name: `Bulk Return Asset (${bulkAssets.length} assets)` },
                    'Return Asset',
                    assetController,
                    { name: requesterName },
                    `Bulk return for ${bulkAssets.length} asset(s). ${reason}`,
                    bulkReturnAttachments
                );
            } catch (e) {
                // non-fatal
            }

            return res.status(200).json({
                message: `Return request for ${bulkAssets.length} asset(s) sent to Asset Controller for approval`,
                asset: primaryAsset,
                bulkCount: bulkAssets.length
            });
        }

        // Store current details for history
        const prevAssignedTo = item.assignedTo;

        const { reassignTo, assignmentType, assignedDays, assignedToType } = req.body;

        // Capture snapshot BEFORE mutation
        const snapshotItem = await AssetItem.findById(item._id)
            .populate('categoryId typeId assignedTo assignedBy acceptedBy assignedCompany');
        const returnSnapshot = snapshotItem.toObject();

        if (reassignTo) {
            // Check if reassigning a company-assigned asset
            const isCompanyAsset = item.assignedToType === 'Company' && item.assignedCompany;

            // If transferring from company to employee, or company to company
            if (isCompanyAsset) {
                const companyCoordinator = await getCompanyAssetCoordinator();
                if (!companyCoordinator?._id) {
                    return res.status(400).json({
                        message: 'No Assigned User or Admin in Flowchart. Company asset transfers require that role to approve.'
                    });
                }

                let adminCoordinator = null;
                if (assignedToType === 'Company') {
                    const targetCompany = await Company.findById(reassignTo);
                    if (!targetCompany) {
                        return res.status(404).json({ message: "Target company not found" });
                    }

                    const transferCoordinatorRaw = await getCompanyAssetCoordinator();
                    const transferCoordinator = transferCoordinatorRaw
                        ? await resolveAssetControllerEmployee(transferCoordinatorRaw)
                        : null;
                    const transferCoordinatorEmail = transferCoordinator
                        ? pickEffectiveEmail(transferCoordinator)
                        : null;

                    if (!transferCoordinator?._id || !transferCoordinatorEmail) {
                        return res.status(400).json({
                            message:
                                'No Assigned User or Admin in Flowchart. Configure one in Settings → Flowchart before allocating to a company.',
                        });
                    }

                    item.assignedToType = 'Company';
                    item.assignedCompany = targetCompany._id;
                    item.assignedTo = null;
                    item.status = 'Pending';
                    item.acceptanceStatus = 'Pending';
                    item.actionRequiredBy = transferCoordinator._id;
                    adminCoordinator = transferCoordinator;
                } else {
                    const newAssignee = await EmployeeBasic.findById(reassignTo);
                    if (!newAssignee) {
                        return res.status(404).json({ message: "Target employee for reassignment not found" });
                    }

                    item.assignedToType = 'Employee';
                    item.assignedTo = newAssignee._id;
                    item.assignedCompany = null;
                    item.status = 'Pending';
                    item.acceptanceStatus = 'Pending';
                    // actionRequiredBy references EmployeeBasic, so use EmployeeBasic._id
                    item.actionRequiredBy = companyCoordinator._id;
                }

                item.assignedBy = req.user.employeeObjectId;
                item.assignmentType = assignmentType || item.assignmentType || 'Permanent';
                item.assignedDays = assignmentType === 'Temporary' ? (assignedDays || null) : null;
                item.negotiationHistory = [];

                // For company transfers, notify company coordinator or admin coordinator
                try {
                    const assigner = await EmployeeBasic.findById(req.user.employeeObjectId).select('firstName lastName employeeId');
                    const targetCompany = assignedToType === 'Company'
                        ? await Company.findById(reassignTo).select('name companyId')
                        : null;
                    const targetEmployee = assignedToType === 'Employee'
                        ? await EmployeeBasic.findById(reassignTo).select('firstName lastName employeeId')
                        : null;

                    const subjectName = targetCompany ? targetCompany.name : (targetEmployee ? `${targetEmployee.firstName} ${targetEmployee.lastName}` : 'Unknown');
                    const subjectEmpId = targetCompany ? targetCompany.companyId : (targetEmployee ? targetEmployee.employeeId : 'N/A');

                    const approver = assignedToType === 'Company' ? adminCoordinator : companyCoordinator;

                    await DashboardAction.findOneAndUpdate(
                        {
                            requestId: item._id,
                            requestType: 'Asset Assignment',
                            status: 'Pending',
                        },
                        {
                            assignedTo: approver._id,
                            assignedToEmpId: approver.employeeId,
                            requestId: item._id,
                            requestType: 'Asset Assignment',
                            subjectEmployeeId: subjectEmpId,
                            subjectName: subjectName,
                            requestedByName: `${assigner?.firstName || "System"} ${assigner?.lastName || ""} `.trim(),
                            extra1: `${item.assetId} - ${item.name} `,
                            extra2: item.assignmentType || 'Permanent',
                            status: 'Pending',
                        },
                        { upsert: true, new: true, setDefaultsOnInsert: true },
                    );
                    await healDuplicatePendingAssignmentDashboardRows(item._id).catch(() => null);

                    const itemForHrEmail = await AssetItem.findById(item._id).populate('categoryId', 'name');
                    const targetFullForTransfer =
                        assignedToType === 'Employee' && targetEmployee
                            ? await EmployeeBasic.findById(reassignTo)
                                .select('firstName lastName employeeId department primaryReportee companyEmail workEmail email')
                                .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail')
                                .lean()
                                .catch(() => targetEmployee)
                            : null;

                    await sendAssetTransferHandoverEmails({
                        req,
                        asset: itemForHrEmail || item,
                        assetIds: [item._id.toString()],
                        targetEmployee: targetFullForTransfer,
                        targetCompany: assignedToType === 'Company' ? targetCompany : null,
                        assignedToType,
                        senderEmployeeId: req.user.employeeObjectId,
                        companyCoordinator: approver,
                    });

                } catch (err) {
                }
            } else {
                // Regular employee-to-employee transfer
                const newAssignee = await EmployeeBasic.findById(reassignTo);
                if (!newAssignee) {
                    return res.status(404).json({ message: "Target employee for reassignment not found" });
                }

                item.assignedTo = newAssignee._id;
                item.assignedBy = req.user.employeeObjectId;
                if (isLeaveActive(item)) {
                    item.status = 'Assigned';
                    item.onLeaveActive = true;
                } else {
                    item.status = 'Unassigned';
                }
                item.acceptanceStatus = 'Accepted';
                item.actionRequiredBy = null;
                item.assignmentType = assignmentType || 'Permanent';
                item.assignedDays = assignmentType === 'Temporary' ? (assignedDays || null) : null;
                item.negotiationHistory = [];
                item.assignedCompany = null;
                item.assignedToType = 'Employee';

                try {
                    const itemForEmail = await AssetItem.findById(item._id).populate('categoryId', 'name');
                    const targetFull = await EmployeeBasic.findById(reassignTo)
                        .select('firstName lastName employeeId companyEmail workEmail email primaryReportee department')
                        .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail')
                        .lean();

                    await sendAssetTransferHandoverEmails({
                        req,
                        asset: itemForEmail || item,
                        assetIds: [item._id.toString()],
                        targetEmployee: targetFull,
                        senderEmployeeId: req.user.employeeObjectId,
                        assignedToType: 'Employee',
                    });
                } catch (empTransferMailErr) {
                }
            }
        } else {
            // Return to unassigned pool — no assignee, no owner
            item.assignedTo = null;
            item.assignedCompany = null;
            item.assignedToType = null;
            item.assignedBy = null;
            item.acceptedBy = null;
            item.status = 'Unassigned';
            item.acceptanceStatus = 'Accepted';
            item.actionRequiredBy = null;
            item.assignmentType = null;
            item.assignedDays = null;
            item.assignedDate = null;
            item.temporaryEndDate = null;
            item.temporaryReminderSentAt = null;
            item.temporaryExpiredSentAt = null;
            item.negotiationHistory = [];
            item.ownership = null;
        }

        await item.save();

        const prevAssigneeEmp = prevAssignedTo
            ? await EmployeeBasic.findById(prevAssignedTo)
                  .select('firstName lastName employeeId')
                  .lean()
                  .catch(() => null)
            : null;
        const returnAdminOfficer = fleetVehicle ? await resolveAdminOfficerEmployee().catch(() => null) : null;
        const returnDisplay = buildFleetHandoverDisplayLabels({
            assignee: prevAssigneeEmp,
            previousAssignee: prevAssigneeEmp,
            adminOfficer: returnAdminOfficer,
            isReturn: true,
        });

        // Log History with Snapshot
        await AssetHistory.create({
            assetId: item._id,
            action: 'Returned',
            assignedTo: prevAssignedTo,
            performedBy: req.user._id,
            details: {
                ...returnSnapshot,
                ...returnDisplay,
            },
        });

        // If Asset Controller/Admin returned it, notify the previously assigned employee by email.
        if (isElevatedReturn && prevAssignedTo) {
            try {
                const employee = await EmployeeBasic.findById(prevAssignedTo)
                    .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                    .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
                    .lean()
                    .catch(() => null);
                if (employee) {
                    await sendAssignedEmployeeActionEmail({
                        asset: item,
                        employee,
                        action: 'Return Asset',
                        performedBy: req.user.employeeId || 'Asset Controller',
                        details: 'Your asset was returned to store by Asset Controller/Admin.'
                    });
                }
            } catch (e) {
                // non-fatal
            }
        }

        await updateAssetTypeCounts(item.typeId);

        res.status(200).json(item);

    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Update asset status (Unassign, Service, Live)
// @route   PUT /api/AssetItem/:id/status
// @access  Private
export const updateAssetStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, note, serviceDuration, description, invoice, attachment, serviceReport, amount } = req.body;

        const assetController = await getDepartmentHOD('assetcontroller');
        if (!assetController) {
            return res.status(403).json({
                message: "Asset status update denied: No Asset Controller has been assigned in the organization flow. Please assign an Asset Controller in Settings > Flowchart before performing this operation."
            });
        }

        // status: 'Unassigned' | 'Service' | 'Live'

        const allowedStatuses = ['Unassigned', 'Service', 'Live'];
        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({ message: 'Invalid status. Allowed: Unassigned, Service, Live' });
        }

        const item = await AssetItem.findById(id);
        if (!item) return res.status(404).json({ message: 'Asset not found' });

        const isAdminUser =
            isJwtSystemSuperUser(req.user);
        const isAssetControllerUser =
            (await isUserInFlowchart(req.user, 'assetcontroller')) ||
            (req.user?.id ? await hasPermission(req.user.id, 'hrm_asset', 'edit') : false);
        let actingEmpId = req.user?.employeeObjectId?.toString();
        if (!actingEmpId && req.user?.employeeId) {
            const me = await EmployeeBasic.findOne({
                employeeId: {
                    $regex: new RegExp(
                        `^${String(req.user.employeeId).replace(/\s+/g, '\\s*')}$`,
                        'i'
                    ),
                },
            })
                .select('_id')
                .lean()
                .catch(() => null);
            if (me?._id) actingEmpId = me._id.toString();
        }

        const isAssignedAsset = !!(item.assignedTo || item.assignedCompany);
        const isAssignedUser =
            !!item.assignedTo &&
            !!actingEmpId &&
            item.assignedTo.toString() === actingEmpId;

        if (status === 'Service' || status === 'Live') {
            if (status === 'Service' && !isAssignedAsset) {
                if (!isAdminUser && !isAssetControllerUser) {
                    return res.status(403).json({
                        message:
                            'Only Asset Controller or Admin can send an unassigned asset to service.',
                    });
                }
            } else if (!isAdminUser && !isAssetControllerUser && !isAssignedUser) {
                return res.status(403).json({
                    message:
                        'Only Asset Controller, Admin, or the assigned user can perform this service action.',
                });
            }
        }

        if (status === 'Service') {
            if (!serviceDuration) {
                return res.status(400).json({ message: 'Service duration is required.' });
            }
            const serviceDays = parseServiceDurationDays(serviceDuration);
            if (!serviceDays || serviceDays < 1 || serviceDays > MAX_ASSET_SERVICE_DAYS) {
                return res.status(400).json({
                    message: `Service duration must be between 1 and ${MAX_ASSET_SERVICE_DAYS} days.`,
                });
            }
        }

        const prevStatus = item.status;
        let serviceRecord = null;
        let completionRecord = null;

        // Capture snapshot before mutation
        const snapshotItem = await AssetItem.findById(item._id)
            .populate('categoryId typeId assignedTo assignedBy acceptedBy');
        const statusSnapshot = snapshotItem.toObject();

        if (status === 'Unassigned') {
            // ... (mutation logic) ...
            item.status = 'Unassigned';
            item.assignedTo = null;
            item.assignedBy = null;
            item.assignedCompany = null;
            item.assignedToType = null;
            item.assignmentType = null;
            item.assignedDays = null;
            item.acceptanceStatus = null;
            item.actionRequiredBy = null;
            item.negotiationHistory = [];
        } else if (status === 'Service') {
            const statusBeforeService = item.onLeaveActive ? 'On Leave' : item.status;
            applyServiceActiveState(item, statusBeforeService);

            const serviceDays = parseServiceDurationDays(serviceDuration);
            const normalizedDuration = `${serviceDays} days`;

            // Calculate expiry date from normalized day count
            let expiryDate = null;
            if (serviceDays) {
                expiryDate = new Date();
                expiryDate.setDate(expiryDate.getDate() + serviceDays);
            }

            // Build service record
            serviceRecord = {
                _id: new mongoose.Types.ObjectId(),
                serviceReqNo: allocateNextServiceReqNo(item),
                date: new Date(),
                expiryDate: expiryDate,
                serviceDuration: normalizedDuration,
                description: description || note || null,
                requestedBy: req.user.employeeObjectId,
                statusBeforeService: statusBeforeService || null,
            };

            // Upload invoice if provided (base64)
            if (invoice?.data) {
                try {
                    const invoiceResult = await uploadDocumentToS3(
                        invoice.data,
                        'asset-services',
                        invoice.name || `service - invoice - ${Date.now()}.pdf`,
                        'auto'
                    );
                    serviceRecord.invoice = invoiceResult.publicId;
                } catch (uploadErr) {
                }
            }

            // Upload attachment if provided (base64)
            if (attachment?.data) {
                try {
                    const attachResult = await uploadDocumentToS3(
                        attachment.data,
                        'asset-services',
                        attachment.name || `service - attachment - ${Date.now()}.pdf`,
                        'auto'
                    );
                    serviceRecord.attachment = attachResult.publicId;
                } catch (uploadErr) {
                }
            }

            item.services.push(serviceRecord);

        } else if (status === 'Live') {
            const openService = item.services?.length ? item.services[item.services.length - 1] : null;
            applyPostServiceOperationalState(item, openService);

            // Add completion record if data provided
            if (serviceReport || amount) {
                completionRecord = {
                    _id: new mongoose.Types.ObjectId(),
                    serviceReqNo: allocateNextServiceReqNo(item),
                    date: new Date(),
                    description: serviceReport,
                    value: amount || 0,
                    serviceType: 'Other'
                };

                if (attachment?.data) {
                    try {
                        const attachResult = await uploadDocumentToS3(
                            attachment.data,
                            'asset-services',
                            attachment.name || `service - report - ${Date.now()}.pdf`,
                            'auto'
                        );
                        completionRecord.attachment = attachResult.publicId;
                    } catch (uploadErr) {
                    }
                }
                item.services.push(completionRecord);
            }
        }

        await item.save();

        const resolveOpenServiceRecord = (services = []) => {
            for (let i = services.length - 1; i >= 0; i--) {
                const s = services[i];
                if (s?.expiryDate || s?.serviceDuration) return s;
            }
            return services.length ? services[services.length - 1] : null;
        };
        const activeServiceOnItem =
            status === 'Live' ? resolveOpenServiceRecord(item.services) : serviceRecord;

        // Email Notifications for Service
        try {
            const requestInitiatorId = req.user.employeeObjectId;
            const initiator = await EmployeeBasic.findById(requestInitiatorId)
                .select('firstName lastName employeeId companyEmail workEmail primaryReportee')
                .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail')
                .lean();

            const emailDetails = {
                serviceDuration:
                    status === 'Service'
                        ? serviceRecord?.serviceDuration || serviceDuration || null
                        : activeServiceOnItem?.serviceDuration || null,
                description:
                    status === 'Service'
                        ? description || note || null
                        : serviceReport || 'Service Completed',
            };

            if (status === 'Service') {
                await notifyAssetServiceStakeholderEmails({
                    asset: item,
                    type: 'Started',
                    details: emailDetails,
                    initiator,
                    initiatorIsAssetController: isAssetControllerUser,
                });
            } else if (status === 'Live') {
                await notifyAssetServiceStakeholderEmails({
                    asset: item,
                    type: 'Done',
                    details: emailDetails,
                    initiator,
                    initiatorIsAssetController: isAssetControllerUser,
                });

                try {
                    await DashboardAction.updateMany(
                        {
                            requestId: item._id,
                            status: 'Pending',
                            requestType: { $in: ['Asset', 'Asset Overdue'] },
                        },
                        {
                            status: 'Approved',
                            actionedDate: new Date(),
                            actionedBy: requestInitiatorId,
                        }
                    );
                } catch (dashErr) {
                }
            }
        } catch (emailErr) {
        }

        let historyDetails = null;
        let historyComments = description || note || serviceReport || null;

        if (status === 'Service' && serviceRecord) {
            historyDetails = buildServiceSendHistoryDetails({
                serviceRecord,
                prevStatus,
                description: description || note,
                serviceDuration,
            });
            const expiryLabel = serviceRecord.expiryDate
                ? new Date(serviceRecord.expiryDate).toLocaleDateString('en-GB')
                : '—';
            historyComments =
                historyComments ||
                `Sent to service on ${new Date(serviceRecord.date).toLocaleDateString('en-GB')}. Duration: ${serviceDuration || serviceRecord.serviceDuration || '—'}. Expected return: ${expiryLabel}.`;
        } else if (status === 'Live') {
            historyDetails = buildServiceReceiveHistoryDetails({
                action: 'live',
                currentService: activeServiceOnItem,
                completionRecord,
                prevStatus,
                nextStatus: item.status,
                serviceReport,
                amount,
            });
            historyComments =
                historyComments ||
                `Marked Live on ${new Date().toLocaleDateString('en-GB')}. Service completed.`;
        } else if (status === 'Unassigned') {
            historyDetails = { serviceEventType: 'unassigned', prevAssetStatus: prevStatus };
        }

        await AssetHistory.create({
            assetId: item._id,
            action: status === 'Unassigned' ? 'Unassigned' : status === 'Service' ? 'Service Send' : 'Service Receive',
            performedBy: req.user.employeeObjectId,
            comments: historyComments,
            file: (status === 'Service' ? (serviceRecord?.invoice || serviceRecord?.attachment) : completionRecord?.attachment) || null,
            details: historyDetails || { prevAssetStatus: prevStatus },
        });

        await updateAssetTypeCounts(item.typeId);

        res.status(200).json(item);
    } catch (error) {
        res.status(500).json({ message: 'Server Error', error: error.message, stack: error.stack });
    }
};

// @desc    Add image to asset
// @route   POST /api/AssetItem/:id/images
// @access  Private
export const addAssetImage = async (req, res) => {
    try {
        const { id } = req.params;
        const { imageData, imageName, imageMime, caption, date } = req.body;

        if (!imageData) return res.status(400).json({ message: 'Image data is required' });

        const item = await AssetItem.findById(id);
        if (!item) return res.status(404).json({ message: 'Asset not found' });

        const uploadResult = await uploadDocumentToS3(
            imageData,
            'asset-photos',
            imageName || `asset-image-${Date.now()}.jpg`,
            'image'
        );

        item.images.push({
            url: uploadResult.publicId,
            caption: caption || '',
            date: date ? new Date(date) : new Date()
        });
        await item.save();

        const savedImage = item.images[item.images.length - 1].toObject();
        savedImage.url = await getSignedFileUrl(savedImage.url);

        res.status(200).json(savedImage);
    } catch (error) {
        console.error('Error in addAssetImage:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// @desc    Delete image from asset
// @route   DELETE /api/AssetItem/:id/images/:imageId
// @access  Private
export const deleteAssetImage = async (req, res) => {
    try {
        const { id, imageId } = req.params;

        const item = await AssetItem.findById(id);
        if (!item) return res.status(404).json({ message: 'Asset not found' });

        item.images = item.images.filter(img => img._id.toString() !== imageId);
        await item.save();

        res.status(200).json({ message: 'Image deleted' });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get asset history
// @route   GET /api/AssetItem/:id/history
// @access  Private

const HANDOVER_LIST_DETAIL_KEYS = [
    'assignmentReason',
    'handoverLifecycleStatus',
    'handoverKind',
    'handoverHrApprovedAt',
    'hrApprovalSkipped',
    'firstInspection',
    'reinspection',
    'receiverAssessmentCompleted',
    'bodyConditionCompleted',
    'receiverAssessment',
    'vehicleAssessmentReportByReceiver',
    'bodyConditionReport',
    'bodyCondition',
    'vehicleHandoverWorkflow',
    'assignmentType',
    'assignedDays',
    'handoverApprovedWithFine',
    'handoverItemFineWaivers',
    'handoverItemFineInclusions',
    'handoverFineId',
    'handoverFineIds',
    'acceptanceStatus',
    'inspectionFormStatus',
    'handoverByDisplay',
    'handoverToDisplay',
    'assignedTo',
    'assignedToType',
    'assignedCompany',
    'reason',
    'rejectionReason',
    'extensionReason',
    'userStory',
    'byName',
    'performedByName',
];

/** Drop inline base64 from handover list payloads — keeps assign page responsive. */
function stripInlinePhotoDataFromMap(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return map;
    const next = {};
    for (const [key, row] of Object.entries(map)) {
        if (!row || typeof row !== 'object') {
            next[key] = row;
            continue;
        }
        let photo = row.photo ?? row.image ?? row.attachment ?? null;
        if (typeof photo === 'string' && photo.trim().startsWith('data:')) {
            photo = null;
        }
        next[key] = {
            ...row,
            photo,
        };
    }
    return next;
}

function slimHandoverHistoryForList(recordObj, assetMeta, handoverHistoryId, activeAssignmentReason) {
    const rawDetails =
        recordObj.details && typeof recordObj.details === 'object' ? recordObj.details : {};
    const details = {};
    HANDOVER_LIST_DETAIL_KEYS.forEach((key) => {
        if (rawDetails[key] === undefined || rawDetails[key] === null) return;
        const value = rawDetails[key];
        if (
            key === 'receiverAssessment' ||
            key === 'vehicleAssessmentReportByReceiver' ||
            key === 'bodyConditionReport' ||
            key === 'bodyCondition'
        ) {
            details[key] = stripInlinePhotoDataFromMap(value);
            return;
        }
        details[key] = value;
    });

    if (
        handoverHistoryId &&
        activeAssignmentReason &&
        String(recordObj._id) === String(handoverHistoryId) &&
        !String(details.assignmentReason || '').trim()
    ) {
        details.assignmentReason = activeAssignmentReason;
    } else if (
        String(recordObj.action || '').trim() === 'Assigned' &&
        !String(details.assignmentReason || '').trim() &&
        !String(recordObj.comments || '').trim() &&
        assetMeta?.assignmentType
    ) {
        details.assignmentType = details.assignmentType || assetMeta.assignmentType;
        details.assignedDays = details.assignedDays ?? assetMeta.assignedDays ?? null;
    }

    return {
        _id: recordObj._id,
        date: recordObj.date,
        createdAt: recordObj.createdAt,
        action: recordObj.action,
        comments: recordObj.comments,
        assignedTo: recordObj.assignedTo,
        assignedCompany: recordObj.assignedCompany,
        assignedToType: recordObj.assignedToType,
        performedBy: recordObj.performedBy,
        details,
    };
}

export const getAssetHistory = async (req, res) => {
    try {
        const { id } = req.params;
        const forHandoverList =
            String(req.query.forHandover || '').toLowerCase() === '1' ||
            String(req.query.forHandover || '').toLowerCase() === 'true';

        const assetMeta = await AssetItem.findById(id)
            .select('pendingActionDetails assignmentType assignedDays')
            .lean();

        if (forHandoverList) {
            const handoverDetailProjection = HANDOVER_LIST_DETAIL_KEYS.map(
                (key) => `details.${key}`,
            ).join(' ');

            const history = await AssetHistory.find({ assetId: id })
                .select(
                    `action date createdAt comments assignedTo assignedCompany assignedToType performedBy ${handoverDetailProjection}`,
                )
                .populate('performedBy', 'firstName lastName employeeId')
                .populate('assignedTo', 'firstName lastName employeeId')
                .populate('assignedCompany', 'name companyId')
                .sort({ date: -1, createdAt: -1 })
                .lean();

            const handoverHistoryId = assetMeta?.pendingActionDetails?.vehicleHandoverFlow?.historyId;
            const activeAssignmentReason = String(
                assetMeta?.pendingActionDetails?.assignmentReason || '',
            ).trim();

            const slimmed = await Promise.all(
                history.map(async (recordObj) => {
                    const slim = slimHandoverHistoryForList(
                        recordObj,
                        assetMeta,
                        handoverHistoryId,
                        activeAssignmentReason,
                    );
                    const details = slim?.details;
                    const hasHandoverMedia =
                        details?.bodyConditionReport ||
                        details?.bodyCondition ||
                        details?.receiverAssessment ||
                        details?.vehicleAssessmentReportByReceiver;
                    if (hasHandoverMedia && details) {
                        await signHandoverAssessmentMediaInDetails(details, getSignedFileUrl);
                    }
                    return slim;
                }),
            );

            await attachAssigneeDrivingLicenseIssueDates(slimmed);

            return res.status(200).json(slimmed);
        }

        const history = await AssetHistory.find({ assetId: id })
            .populate('performedBy', 'firstName lastName employeeId signature')
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId primaryReportee enablePortalAccess companyEmail signature',
                populate: {
                    path: 'primaryReportee',
                    select: 'firstName lastName employeeId signature',
                },
            })
            .populate('assignedCompany', 'name companyId')
            .sort({ date: -1, createdAt: -1 });

        const handoverHistoryId = assetMeta?.pendingActionDetails?.vehicleHandoverFlow?.historyId;
        const activeAssignmentReason = String(
            assetMeta?.pendingActionDetails?.assignmentReason || '',
        ).trim();

        const historyWithUrls = await Promise.all(history.map(async (record) => {
            const recordObj = record.toObject();

            if (
                handoverHistoryId &&
                activeAssignmentReason &&
                String(recordObj._id) === String(handoverHistoryId) &&
                !String(recordObj.details?.assignmentReason || '').trim()
            ) {
                recordObj.comments = activeAssignmentReason;
                recordObj.details = {
                    ...(recordObj.details && typeof recordObj.details === 'object' ? recordObj.details : {}),
                    assignmentReason: activeAssignmentReason,
                };
                void AssetHistory.updateOne(
                    { _id: recordObj._id },
                    {
                        $set: {
                            comments: activeAssignmentReason,
                            'details.assignmentReason': activeAssignmentReason,
                        },
                    },
                ).catch(() => null);
            } else if (
                String(recordObj.action || '').trim() === 'Assigned' &&
                !String(recordObj.details?.assignmentReason || '').trim() &&
                !String(recordObj.comments || '').trim() &&
                assetMeta?.assignmentType
            ) {
                recordObj.details = {
                    ...(recordObj.details && typeof recordObj.details === 'object' ? recordObj.details : {}),
                    assignmentType: recordObj.details?.assignmentType || assetMeta.assignmentType,
                    assignedDays: recordObj.details?.assignedDays ?? assetMeta.assignedDays ?? null,
                };
            }

            if (recordObj.file) {
                recordObj.file = await getSignedFileUrl(recordObj.file);
            }
            if (recordObj.details) {
                const d = recordObj.details;
                if (d.invoice) d.invoice = await getSignedFileUrl(d.invoice);
                if (d.invoiceFile) d.invoiceFile = await getSignedFileUrl(d.invoiceFile);
                if (d.attachment) d.attachment = await getSignedFileUrl(d.attachment);
                if (d.serviceRecord?.invoice) d.serviceRecord.invoice = await getSignedFileUrl(d.serviceRecord.invoice);
                if (d.serviceRecord?.attachment) d.serviceRecord.attachment = await getSignedFileUrl(d.serviceRecord.attachment);
                if (d.completionRecord?.attachment) {
                    d.completionRecord.attachment = await getSignedFileUrl(d.completionRecord.attachment);
                }
                if (d.assignedBy?.signature?.url) {
                    d.assignedBy.signature.url = await getSignedFileUrl(d.assignedBy.signature.url);
                }
                if (d.assignedTo?.signature?.url) {
                    d.assignedTo.signature.url = await getSignedFileUrl(d.assignedTo.signature.url);
                }
                if (d.acceptedBy?.signature?.url) {
                    d.acceptedBy.signature.url = await getSignedFileUrl(d.acceptedBy.signature.url);
                }
                await signHandoverAssessmentMediaInDetails(d, getSignedFileUrl);
            }
            if (recordObj.performedBy?.signature?.url) {
                recordObj.performedBy.signature.url = await getSignedFileUrl(recordObj.performedBy.signature.url);
            }
            if (recordObj.assignedTo?.signature?.url) {
                recordObj.assignedTo.signature.url = await getSignedFileUrl(recordObj.assignedTo.signature.url);
            }
            if (recordObj.assignedTo?.primaryReportee?.signature?.url) {
                recordObj.assignedTo.primaryReportee.signature.url = await getSignedFileUrl(
                    recordObj.assignedTo.primaryReportee.signature.url,
                );
            }
            await enrichHandoverWorkflowActorSignatures(recordObj, getSignedFileUrl);
            return recordObj;
        }));

        res.status(200).json(historyWithUrls);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get single history record
// @route   GET /api/AssetItem/history-record/:historyId
// @access  Private
export const getHistoryRecord = async (req, res) => {
    try {
        const { historyId } = req.params;
        const record = await AssetHistory.findById(historyId)
            .populate('performedBy', 'firstName lastName employeeId signature')
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId primaryReportee enablePortalAccess companyEmail signature',
                populate: {
                    path: 'primaryReportee',
                    select: 'firstName lastName employeeId signature',
                },
            });

        if (!record) {
            return res.status(404).json({ message: 'History record not found' });
        }

        if (
            String(record.action || '') === 'Assigned' &&
            record.assignedTo &&
            !record.details?.vehicleHandoverWorkflow
        ) {
            try {
                const assigneeDoc =
                    typeof record.assignedTo === 'object' && record.assignedTo.employeeId
                        ? record.assignedTo
                        : await EmployeeBasic.findById(record.assignedTo)
                            .select(
                                'firstName lastName employeeId companyEmail enablePortalAccess primaryReportee',
                            )
                            .lean();
                const canSelf = assigneeDoc
                    ? await assigneeCanSelfAcknowledgeFleetHandover(assigneeDoc)
                    : false;
                const adminOfficer = canSelf ? null : await resolveAdminOfficerEmployee();
                const workflowMeta = buildInitialHandoverWorkflowMeta({
                    assigneeCanSelfAcknowledge: canSelf,
                    assigner: record.performedBy,
                    assignee: assigneeDoc,
                    firstActorDoc: canSelf ? assigneeDoc : adminOfficer,
                    assignDate: record.createdAt || record.date || new Date(),
                });
                await persistHandoverWorkflowMeta(record._id, workflowMeta);
                record.details = {
                    ...(record.details && typeof record.details === 'object' ? record.details : {}),
                    vehicleHandoverWorkflow: workflowMeta,
                };
            } catch {
                /* non-fatal */
            }
        }

        let recordForResponse = record;
        try {
            const seedResult = await seedPreviousHandoverReportsOnHistory({
                historyId: record._id,
                assetId: record.assetId,
            });
            if (seedResult.applied) {
                recordForResponse = await AssetHistory.findById(historyId)
                    .populate('performedBy', 'firstName lastName employeeId signature')
                    .populate({
                        path: 'assignedTo',
                        select: 'firstName lastName employeeId primaryReportee enablePortalAccess companyEmail signature',
                        populate: {
                            path: 'primaryReportee',
                            select: 'firstName lastName employeeId signature',
                        },
                    });
            }
        } catch {
            /* non-fatal */
        }

        try {
            const assetMeta = await AssetItem.findById(record.assetId)
                .select('pendingActionDetails assignmentType assignedDays')
                .lean();
            const activeHistoryId = assetMeta?.pendingActionDetails?.vehicleHandoverFlow?.historyId;
            const assignmentReason = String(
                assetMeta?.pendingActionDetails?.assignmentReason || '',
            ).trim();
            if (
                assignmentReason &&
                activeHistoryId &&
                String(recordForResponse._id) === String(activeHistoryId) &&
                !String(recordForResponse.details?.assignmentReason || '').trim()
            ) {
                await AssetHistory.updateOne(
                    { _id: recordForResponse._id },
                    {
                        $set: {
                            comments: assignmentReason,
                            'details.assignmentReason': assignmentReason,
                        },
                    },
                );
                recordForResponse.comments = assignmentReason;
                recordForResponse.details = {
                    ...(recordForResponse.details && typeof recordForResponse.details === 'object'
                        ? recordForResponse.details
                        : {}),
                    assignmentReason,
                };
            }
        } catch {
            /* non-fatal */
        }

        try {
            const rawDetails =
                recordForResponse.details && typeof recordForResponse.details === 'object'
                    ? recordForResponse.details
                    : {};
            const { details: healedDetails, changed } = stripUnconfirmedBodyConditionDetails(rawDetails);
            if (changed) {
                await AssetHistory.updateOne(
                    { _id: recordForResponse._id },
                    { $set: { 'details.bodyConditionReport': {} } },
                );
                recordForResponse.details = healedDetails;
            }
        } catch {
            /* non-fatal */
        }

        const recordObj = recordForResponse.toObject();
        if (recordObj.file) {
            recordObj.file = await getSignedFileUrl(recordObj.file);
        }
        if (recordObj.details) {
            const d = recordObj.details;
            if (d.invoice) d.invoice = await getSignedFileUrl(d.invoice);
            if (d.invoiceFile) d.invoiceFile = await getSignedFileUrl(d.invoiceFile);
            await signHandoverAssessmentMediaInDetails(d, getSignedFileUrl);
        }
        if (recordObj.performedBy?.signature?.url) {
            recordObj.performedBy.signature.url = await getSignedFileUrl(recordObj.performedBy.signature.url);
        }
        if (recordObj.assignedTo?.signature?.url) {
            recordObj.assignedTo.signature.url = await getSignedFileUrl(recordObj.assignedTo.signature.url);
        }
        if (recordObj.assignedTo?.primaryReportee?.signature?.url) {
            recordObj.assignedTo.primaryReportee.signature.url = await getSignedFileUrl(
                recordObj.assignedTo.primaryReportee.signature.url,
            );
        }
        await enrichHandoverWorkflowActorSignatures(recordObj, getSignedFileUrl);

        if (recordObj.assignedTo) {
            await attachAssigneeDrivingLicenseIssueDate(recordObj.assignedTo);
        }

        res.status(200).json(recordObj);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

const DELETABLE_HANDOVER_HISTORY_ACTIONS = new Set([
    'Assigned',
    'Accepted',
    'Transfer',
    'ControllerHandover',
    'Returned',
    'Unassigned',
    'Rejected',
]);

function handoverAssigneeKey(entity) {
    if (!entity) return '';
    if (String(entity.assignedToType || '').toLowerCase() === 'company') {
        const companyId = entity.assignedCompany?._id || entity.assignedCompany;
        return `company:${companyId || ''}`;
    }
    const assigneeId = entity.assignedTo?._id || entity.assignedTo;
    return `emp:${assigneeId || ''}`;
}

function isActivePendingAssignedHandover(asset, record) {
    if (!asset || !record) return false;
    if (String(record.action || '').trim() !== 'Assigned') return false;
    if (String(asset.acceptanceStatus || '').trim() !== 'Pending') return false;
    return handoverAssigneeKey(asset) === handoverAssigneeKey(record);
}

function buildHandoverDeleteAssetPatch(asset, record, historyId) {
    const assetPatch = {};
    const flow = asset.pendingActionDetails?.vehicleHandoverFlow;
    const flowMatchesDeleted =
        flow?.historyId && String(flow.historyId) === String(historyId);
    const isPendingAssigned = isActivePendingAssignedHandover(asset, record);

    if (flowMatchesDeleted || isPendingAssigned) {
        assetPatch.pendingAction = null;
        assetPatch.actionRequiredBy = null;
        const nextDetails = { ...(asset.pendingActionDetails || {}) };
        delete nextDetails.vehicleHandoverFlow;
        assetPatch.pendingActionDetails = Object.keys(nextDetails).length ? nextDetails : null;
        if (isPendingAssigned || flowMatchesDeleted) {
            assetPatch.acceptanceStatus = 'Accepted';
        }
    }

    if (
        asset.vehicleInspectionHandoverHistoryId &&
        String(asset.vehicleInspectionHandoverHistoryId) === String(historyId)
    ) {
        assetPatch.vehicleInspectionHandoverHistoryId = null;
        const inspStatus = String(asset.vehicleInspectionStatus || '').toLowerCase();
        if (inspStatus === 'pending_hr' || inspStatus === 'draft') {
            assetPatch.vehicleInspectionStatus = null;
        }
    }

    return { assetPatch, isActiveFlow: flowMatchesDeleted };
}

// @desc    Delete a vehicle handover history record (system Super User only)
// @route   DELETE /api/AssetItem/history-record/:historyId
// @access  System Super User
export const deleteVehicleHandoverHistory = async (req, res) => {
    try {
        if (!isJwtSystemSuperUser(req.user)) {
            return res.status(403).json({
                message: 'Only the system Super User can delete handover records.',
            });
        }

        const { historyId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(historyId)) {
            return res.status(400).json({ message: 'Invalid history record id.' });
        }

        const record = await AssetHistory.findById(historyId)
            .select('action assetId file assignedTo assignedToType assignedCompany')
            .lean();
        if (!record) {
            return res.status(404).json({ message: 'History record not found' });
        }

        const action = String(record.action || '').trim();
        if (!DELETABLE_HANDOVER_HISTORY_ACTIONS.has(action)) {
            return res.status(400).json({
                message: 'Only handover history rows can be deleted from this screen.',
            });
        }

        await AssetHistory.findByIdAndDelete(historyId);

        const asset = await AssetItem.findById(record.assetId).select(
            'pendingActionDetails vehicleInspectionHandoverHistoryId vehicleInspectionStatus vehicleAccessoriesListEntries acceptanceStatus assignedTo assignedCompany assignedToType',
        );

        let isActiveFlow = false;
        if (asset) {
            const { assetPatch, isActiveFlow: activeFlow } = buildHandoverDeleteAssetPatch(
                asset,
                record,
                historyId,
            );
            isActiveFlow = activeFlow;

            if (Array.isArray(asset.vehicleAccessoriesListEntries)) {
                const filtered = asset.vehicleAccessoriesListEntries.filter(
                    (entry) => String(entry?.sourceHistoryId || '') !== String(historyId),
                );
                if (filtered.length !== asset.vehicleAccessoriesListEntries.length) {
                    assetPatch.vehicleAccessoriesListEntries = filtered;
                }
            }

            if (Object.keys(assetPatch).length) {
                await AssetItem.findByIdAndUpdate(asset._id, { $set: assetPatch });
            }
        }

        res.status(200).json({
            message: 'Handover record deleted successfully.',
            assetId: record.assetId,
            historyId,
        });

        void (async () => {
            try {
                if (isActiveFlow && asset?._id) {
                    void closeFleetHandoverDashboardActions(
                        asset._id,
                        'Rejected',
                        req.user?.employeeObjectId || req.user?._id,
                        'Handover record deleted by Super User.',
                    );
                }

                if (record.file) {
                    await deleteDocumentFromS3(record.file);
                }
            } catch (cleanupError) {
                console.warn('[deleteVehicleHandoverHistory] cleanup failed:', cleanupError?.message || cleanupError);
            }
        })();
    } catch (error) {
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

const RECEIVER_ASSESSMENT_KEYS = [
    { key: 'spareTyre', label: 'Spare Tyre' },
    { key: 'toolsKit', label: 'Tools Kit' },
    { key: 'scissorJack', label: 'Scissor Jack' },
    { key: 'firstAidKit', label: 'First Aid Kit' },
    { key: 'fireExtinguisher', label: 'Fire extinguisher' },
];

// @desc    Upload a single handover accessory / body photo to S3
// @route   POST /api/AssetItem/handover/upload-photo
// @access  Private
export const uploadHandoverAssessmentPhoto = async (req, res) => {
    try {
        const { file, fileName } = req.body;
        if (!file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const stored = await persistStoredAttachmentValue(
            file,
            'asset-accessories',
            fileName || 'handover-accessory',
        );
        if (!stored) {
            return res.status(400).json({ message: 'Could not store uploaded photo.' });
        }

        const signedUrl = await getSignedFileUrl(stored).catch(() => null);
        res.status(200).json({
            publicId: stored,
            url: signedUrl || stored,
        });
    } catch (error) {
        res.status(500).json({ message: error.message || 'Upload failed' });
    }
};

// @desc    Save receiver vehicle assessment accessories on a history record
// @route   PUT /api/AssetItem/history-record/:historyId/receiver-assessment
// @access  Private
export const updateHistoryReceiverAssessment = async (req, res) => {
    try {
        const { historyId } = req.params;
        const { receiverAssessment, partial } = req.body;

        if (!receiverAssessment || typeof receiverAssessment !== 'object') {
            return res.status(400).json({ message: 'receiverAssessment is required.' });
        }

        const record = await AssetHistory.findById(historyId);
        if (!record) {
            return res.status(404).json({ message: 'History record not found' });
        }

        const isInspectionHandoverFlow = isInspectionHandoverHistoryRecord(record);

        if (isInspectionHandoverFlow) {
            const asset = await AssetItem.findById(record.assetId)
                .populate('assignedTo', 'companyEmail enablePortalAccess employeeId')
                .lean();
            if (!asset) {
                return res.status(404).json({ message: 'Asset not found' });
            }
            if (!(await canEditInspectionHandoverContent(req, asset, record))) {
                return res.status(403).json({
                    message: 'You are not authorized to edit this inspection handover.',
                });
            }
        }

        const existing =
            record.details?.receiverAssessment && typeof record.details.receiverAssessment === 'object'
                ? record.details.receiverAssessment
                : {};
        const merged = { ...existing };

        for (const { key, label } of RECEIVER_ASSESSMENT_KEYS) {
            if (!(key in receiverAssessment)) continue;

            const row = receiverAssessment[key];
            if (!row || typeof row !== 'object') {
                return res.status(400).json({ message: `${label}: select Yes or No.` });
            }
            if (typeof row.present !== 'boolean') {
                return res.status(400).json({ message: `${label}: select Yes or No.` });
            }
            if (row.present === true && !partial) {
                const photo = typeof row.photo === 'string' ? row.photo.trim() : row.photo;
                if (!photo) {
                    return res.status(400).json({ message: `${label}: photo is required when marked Yes.` });
                }
            }

            let photo = row.present === true ? row.photo || null : null;
            if (row.present === true && photo) {
                photo = await persistStoredAttachmentValue(
                    photo,
                    'asset-accessories',
                    `${key}-receiver-assessment`,
                );
            }

            merged[key] = {
                present: row.present,
                photo: row.present === true ? photo : null,
                ...(row.amount != null && row.amount !== '' && Number.isFinite(Number(row.amount))
                    ? { amount: Number(row.amount) }
                    : {}),
            };
        }

        if (!partial) {
            for (const { key, label } of RECEIVER_ASSESSMENT_KEYS) {
                const row = merged[key];
                if (!row || typeof row !== 'object' || typeof row.present !== 'boolean') {
                    return res.status(400).json({ message: `${label}: select Yes or No.` });
                }
                if (row.present === true) {
                    const photo = typeof row.photo === 'string' ? row.photo.trim() : row.photo;
                    if (!photo) {
                        return res.status(400).json({ message: `${label}: photo is required when marked Yes.` });
                    }
                }
            }
        }

        const detailsBase =
            record.details && typeof record.details === 'object' ? { ...record.details } : {};

        if (Object.keys(merged).length > 0 || receiverAssessment) {
            detailsBase.receiverAssessment = merged;
        }

        const assetForPending = await AssetItem.findById(record.assetId).select('vehicleAccessoriesListEntries');
        if (assetForPending) {
            const pendingChanges = await buildPendingAccessoriesChanges(assetForPending, merged);
            if (pendingChanges.length > 0) {
                detailsBase.pendingAccessoriesChanges = pendingChanges;
            } else if (detailsBase.pendingAccessoriesChanges) {
                delete detailsBase.pendingAccessoriesChanges;
            }
        }

        if (req.body.assessmentCompleted === true) {
            for (const { key, label } of RECEIVER_ASSESSMENT_KEYS) {
                const row = merged[key];
                if (!row || typeof row !== 'object' || typeof row.present !== 'boolean') {
                    return res.status(400).json({ message: `${label}: select Yes or No before completing assessment.` });
                }
                if (row.present === true) {
                    const photo = typeof row.photo === 'string' ? row.photo.trim() : row.photo;
                    if (!photo) {
                        return res.status(400).json({ message: `${label}: photo is required before completing assessment.` });
                    }
                }
            }
            detailsBase.receiverAssessmentCompleted = true;
        }

        record.details = detailsBase;
        record.markModified('details');
        await record.save();

        if (req.body.assessmentCompleted === true) {
            await syncVehicleAccessoriesListOnAssessmentComplete(record, merged).catch(() => null);
        }

        const populated = await AssetHistory.findById(historyId)
            .populate('performedBy', 'firstName lastName employeeId')
            .populate('assignedTo', 'firstName lastName employeeId');

        const recordObj = populated.toObject();
        if (recordObj.details) {
            await signHandoverAssessmentMediaInDetails(recordObj.details, getSignedFileUrl);
        }

        res.status(200).json(recordObj);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

const BODY_CONDITION_KEYS = [
    { key: 'frontView', label: 'Front View' },
    { key: 'backView', label: 'Back View' },
    { key: 'frontRightCorner', label: 'Front Right Corner' },
    { key: 'backRightCorner', label: 'Back Right Corner' },
    { key: 'frontLeftCorner', label: 'Front Left Corner' },
    { key: 'backLeftCorner', label: 'Back Left Corner' },
    { key: 'frontRightDoor', label: 'Front Right Door' },
    { key: 'backRightDoor', label: 'Back Right Door' },
    { key: 'frontLeftDoor', label: 'Front Left Door' },
    { key: 'backLeftDoor', label: 'Back Left Door' },
    { key: 'frontInsideView', label: 'Front Inside View' },
    { key: 'backInsideView', label: 'Back Inside View' },
    { key: 'frontDashBoard', label: 'Front Dash Board' },
    { key: 'carTopView', label: 'CAR Top View' },
];

// @desc    Save body condition report on a history record
// @route   PUT /api/AssetItem/history-record/:historyId/body-condition
// @access  Private
export const updateHistoryBodyCondition = async (req, res) => {
    try {
        const { historyId } = req.params;
        const { bodyConditionReport, partial, bodyConditionCompleted, submitInspectionForHr } = req.body;

        if (!bodyConditionReport || typeof bodyConditionReport !== 'object') {
            return res.status(400).json({ message: 'bodyConditionReport is required.' });
        }

        const record = await AssetHistory.findById(historyId);
        if (!record) {
            return res.status(404).json({ message: 'History record not found' });
        }

        const isInspectionHandoverFlow = isInspectionHandoverHistoryRecord(record);
        const skipNewImageCommentRequirement = isInspectionHandoverFlow;

        if (isInspectionHandoverFlow) {
            const asset = await AssetItem.findById(record.assetId)
                .populate('assignedTo', 'companyEmail enablePortalAccess employeeId')
                .lean();
            if (!asset) {
                return res.status(404).json({ message: 'Asset not found' });
            }
            if (!(await canEditInspectionHandoverContent(req, asset, record))) {
                return res.status(403).json({
                    message: 'You are not authorized to edit this inspection handover.',
                });
            }
        }

        const existing =
            record.details?.bodyConditionReport && typeof record.details.bodyConditionReport === 'object'
                ? record.details.bodyConditionReport
                : {};
        const merged = { ...existing };

        for (const { key, label } of BODY_CONDITION_KEYS) {
            if (!(key in bodyConditionReport)) continue;

            const row = bodyConditionReport[key];
            if (!row || typeof row !== 'object') {
                return res.status(400).json({ message: `${label}: invalid data.` });
            }

            if (!partial) {
                const photo = typeof row.photo === 'string' ? row.photo.trim() : row.photo;
                if (!photo) {
                    return res.status(400).json({ message: `${label}: photo is required (mandatory).` });
                }
            }

            let photo = row.photo || null;
            if (photo) {
                photo = await persistStoredAttachmentValue(photo, 'asset-history', `${key}-body-condition`);
                if (typeof photo === 'string' && photo.startsWith('http')) {
                    photo = normalizeS3Key(photo) || photo;
                }
            }

            const existingRow =
                existing[key] && typeof existing[key] === 'object' ? existing[key] : {};
            const photoSource =
                row.photoSource === 'previous' || row.photoSource === 'new'
                    ? row.photoSource
                    : existingRow.photoSource === 'previous' || existingRow.photoSource === 'new'
                      ? existingRow.photoSource
                      : null;

            const comment = typeof row.comment === 'string' ? row.comment.trim() : '';
            if (
                !partial &&
                !skipNewImageCommentRequirement &&
                photoSource === 'new' &&
                photo &&
                !comment
            ) {
                return res.status(400).json({
                    message: `${label}: comment is required when using a new image.`,
                });
            }
            const userSelected =
                row.userSelected === true ||
                Boolean(comment) ||
                photoSource === 'previous' ||
                photoSource === 'new';

            merged[key] = {
                comment,
                photo,
                ...(photoSource ? { photoSource } : {}),
                ...(userSelected ? { userSelected: true } : {}),
            };
        }

        if (!partial) {
            for (const { key, label } of BODY_CONDITION_KEYS) {
                const row = merged[key];
                const photo = typeof row?.photo === 'string' ? row.photo.trim() : row?.photo;
                if (!photo) {
                    return res.status(400).json({ message: `${label}: photo is required (mandatory).` });
                }
            }
        }

        const detailsBase =
            record.details && typeof record.details === 'object' ? { ...record.details } : {};

        if (Object.keys(merged).length > 0 || bodyConditionReport) {
            detailsBase.bodyConditionReport = merged;
        }

        if (bodyConditionCompleted === true) {
            for (const { key, label } of BODY_CONDITION_KEYS) {
                const row = merged[key];
                const photo = typeof row?.photo === 'string' ? row.photo.trim() : row?.photo;
                if (!photo) {
                    return res.status(400).json({
                        message: `${label}: photo is required before completing body condition report.`,
                    });
                }
                if (
                    !skipNewImageCommentRequirement &&
                    row?.photoSource === 'new' &&
                    !String(row?.comment || '').trim()
                ) {
                    return res.status(400).json({
                        message: `${label}: comment is required when using a new image.`,
                    });
                }
            }
            detailsBase.bodyConditionCompleted = true;
        }

        record.details = detailsBase;
        record.markModified('details');
        await record.save();

        let inspectionSubmitResult = null;
        if (submitInspectionForHr === true) {
            try {
                inspectionSubmitResult = await submitInspectionHandoverAfterAssessment(req, record);
            } catch (inspectionErr) {
                return res.status(400).json({
                    message: inspectionErr.message || 'Failed to submit inspection for HR approval.',
                });
            }
        }

        const populated = await AssetHistory.findById(historyId)
            .populate('performedBy', 'firstName lastName employeeId')
            .populate('assignedTo', 'firstName lastName employeeId');

        const responseBody = populated.toObject();
        if (responseBody.details) {
            await signHandoverAssessmentMediaInDetails(responseBody.details, getSignedFileUrl);
        }
        if (inspectionSubmitResult?.asset) {
            responseBody.vehicleAsset = inspectionSubmitResult.asset;
            responseBody.inspectionSubmittedForHr = inspectionSubmitResult.submitted === true;
        }

        res.status(200).json(responseBody);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

function normalizeHandoverItemFineWaivers(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const normalized = [];
    for (const entry of list) {
        const itemType = String(entry?.itemType || '').trim();
        const itemKey = String(entry?.itemKey || '').trim();
        if (!itemType || !itemKey) continue;
        if (!['accessory', 'body'].includes(itemType)) continue;
        const id = `${itemType}:${itemKey}`;
        if (seen.has(id)) continue;
        seen.add(id);
        normalized.push({ itemType, itemKey });
    }
    return normalized;
}

const normalizeHandoverItemFineInclusions = normalizeHandoverItemFineWaivers;

// @desc    Mark handover accessory/body item as include/exclude for fine (HR decision)
// @route   PUT /api/AssetItem/history-record/:historyId/handover-item-fine-waiver
// @access  Private (Flowchart HR or admin)
export const updateHistoryHandoverItemFineWaiver = async (req, res) => {
    try {
        const { historyId } = req.params;
        const itemType = String(req.body?.itemType || '').trim();
        const itemKey = String(req.body?.itemKey || '').trim();
        const decisionRaw = String(req.body?.decision || '').trim().toLowerCase();
        const waived =
            decisionRaw === 'exclude'
                ? true
                : decisionRaw === 'include'
                  ? false
                  : req.body?.waived === true;
        const include =
            decisionRaw === 'include'
                ? true
                : decisionRaw === 'exclude'
                  ? false
                  : req.body?.included === true;

        if (!itemType || !itemKey) {
            return res.status(400).json({ message: 'itemType and itemKey are required.' });
        }
        if (!['accessory', 'body'].includes(itemType)) {
            return res.status(400).json({ message: 'itemType must be accessory or body.' });
        }

        const isHr = await isUserActiveInFlowchart(req.user, 'hr');
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isHr && !isAdmin) {
            return res.status(403).json({ message: 'Only Flowchart HR or admin may update handover item fines.' });
        }

        const record = await AssetHistory.findById(historyId);
        if (!record) {
            return res.status(404).json({ message: 'History record not found' });
        }

        const detailsBase =
            record.details && typeof record.details === 'object' ? { ...record.details } : {};
        const existingWaivers = normalizeHandoverItemFineWaivers(detailsBase.handoverItemFineWaivers);
        const existingInclusions = normalizeHandoverItemFineInclusions(
            detailsBase.handoverItemFineInclusions,
        );
        const decisionId = `${itemType}:${itemKey}`;

        let nextWaivers = existingWaivers.filter(
            (entry) => `${entry.itemType}:${entry.itemKey}` !== decisionId,
        );
        let nextInclusions = existingInclusions.filter(
            (entry) => `${entry.itemType}:${entry.itemKey}` !== decisionId,
        );

        if (waived || decisionRaw === 'exclude') {
            nextWaivers.push({ itemType, itemKey });
            const linkedFine = await Fine.findOne({
                'handoverApprovalContext.historyId': String(historyId),
                'handoverApprovalContext.itemType': itemType,
                'handoverApprovalContext.itemKey': itemKey,
            });
            if (linkedFine) {
                await Fine.findByIdAndDelete(linkedFine._id);
            }
        } else if (include || decisionRaw === 'include') {
            nextInclusions.push({ itemType, itemKey });
        }

        detailsBase.handoverItemFineWaivers = nextWaivers;
        detailsBase.handoverItemFineInclusions = nextInclusions;
        record.details = detailsBase;
        record.markModified('details');
        await record.save();

        const populated = await AssetHistory.findById(historyId)
            .populate('performedBy', 'firstName lastName employeeId')
            .populate('assignedTo', 'firstName lastName employeeId');

        const responseBody = populated.toObject();
        if (responseBody.details) {
            await signHandoverAssessmentMediaInDetails(responseBody.details, getSignedFileUrl);
        }

        return res.status(200).json(responseBody);
    } catch (error) {
        console.error('[updateHistoryHandoverItemFineWaiver]', error);
        return res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Add a document to an asset item
// @route   POST /api/AssetItem/:id/document
// @access  Private
export const addAssetDocument = async (req, res) => {
    try {
        const { id } = req.params;
        const { type, issueAuthority, issueDate, expiryDate, description, document, renewFromDocumentId } = req.body;

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        let documentUrl = null;
        if (document && document.data) {
            try {
                // Upload to S3 under asset-documents folder
                const uploadResult = await uploadDocumentToS3(
                    document.data,
                    'asset-documents',
                    document.name || document.fileName,
                );
                documentUrl = uploadResult.publicId;
            } catch (error) {
                return res.status(500).json({
                    message: error?.message || 'Failed to upload document',
                });
            }
        }

        asset.documents.push({
            type,
            issueAuthority: issueAuthority || null,
            issueDate: issueDate || null,
            expiryDate: expiryDate || null,
            description: description || null,
            attachment: documentUrl
        });

        const addedDoc = asset.documents[asset.documents.length - 1];
        const renewFromId = String(renewFromDocumentId || '').trim();
        if (renewFromId && addedDoc?._id) {
            const { finalizeVehicleDocumentRenewal } = await import('../utils/vehicleDocumentRenewal.js');
            finalizeVehicleDocumentRenewal(asset, renewFromId, addedDoc._id);
        }

        await asset.save();
        try {
            const { clearVehicleExpiryNotificationsForDocument } = await import(
                '../utils/vehicleExpiryNotificationHelpers.js'
            );
            const addedDoc = asset.documents[asset.documents.length - 1];
            await clearVehicleExpiryNotificationsForDocument(asset, addedDoc || type);
        } catch {
            /* non-fatal */
        }
        // Only notify on Service-specific document add flows.
        // For general documents (Registration, Insurance, etc.) there is no serviceType context.
        if (String(type || '').trim().toLowerCase() === 'service') {
            const serviceTypeSafe = req.body?.serviceType || 'Service';
            await notifyAssignedEmployeeIfController(
                req,
                asset,
                'Service',
                `Service "${serviceTypeSafe}" was added by Asset Controller.`
            );
        }

        // Log to history
        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Update',
                performedBy: req.user.employeeObjectId || req.user._id,
                comments: `New document "${type}" added.`,
                details: { type: 'DocumentAdd', docType: type }
            });
        } catch (historyErr) {
        }

        // Return signed URL for immediate UI update if needed
        const newDoc = asset.documents[asset.documents.length - 1].toObject();
        if (newDoc.attachment) {
            newDoc.attachment = await getSignedFileUrl(newDoc.attachment);
        }

        res.status(200).json({ message: 'Document added successfully', document: newDoc });
    } catch (error) {
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Update an existing document on an asset item
// @route   PUT /api/AssetItem/:id/document/:docId
// @access  Private
export const updateAssetDocument = async (req, res) => {
    try {
        const { id, docId } = req.params;
        const { type, issueAuthority, issueDate, expiryDate, description, document } = req.body;

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Find the document subdocument by _id
        const doc = asset.documents.id(docId);
        if (!doc) {
            return res.status(404).json({ message: 'Document not found' });
        }

        // Update fields
        if (type) doc.type = type;
        if (issueAuthority !== undefined) doc.issueAuthority = issueAuthority;
        if (issueDate !== undefined) doc.issueDate = issueDate;
        if (expiryDate !== undefined) doc.expiryDate = expiryDate;
        if (description !== undefined) doc.description = description;

        const { syncVehicleDocumentStatusFromDescription, syncVehicleExpiryFieldsFromLiveDocuments } =
            await import('../utils/vehicleDocumentRenewal.js');
        syncVehicleDocumentStatusFromDescription(doc);

        // Upload new file only if provided
        if (document && document.data) {
            try {
                const uploadResult = await uploadDocumentToS3(
                    document.data,
                    'asset-documents',
                    document.name || document.fileName,
                );
                doc.attachment = uploadResult.publicId;
            } catch (error) {
                return res.status(500).json({
                    message: error?.message || 'Failed to upload document',
                });
            }
        }

        syncVehicleExpiryFieldsFromLiveDocuments(asset);
        await asset.save();

        try {
            const { clearVehicleExpiryNotificationsForDocument } = await import(
                '../utils/vehicleExpiryNotificationHelpers.js'
            );
            await clearVehicleExpiryNotificationsForDocument(asset, doc);
        } catch {
            /* non-fatal */
        }

        // Log to history
        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Update',
                performedBy: req.user.employeeObjectId || req.user._id,
                comments: `Document "${doc.type}" updated.`,
                details: { type: 'DocumentUpdate', docType: doc.type }
            });
        } catch (historyErr) {
        }

        const updatedDoc = doc.toObject();
        if (updatedDoc.attachment) {
            updatedDoc.attachment = await getSignedFileUrl(updatedDoc.attachment);
        }

        res.status(200).json({ message: 'Document updated successfully', document: updatedDoc });
    } catch (error) {
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Delete a document from an asset item
// @route   DELETE /api/AssetItem/:id/document/:docId
// @access  Private
export const deleteAssetDocument = async (req, res) => {
    try {
        const uid = req.user?.id || req.user?._id?.toString?.();
        const isAdminUser = await isReqUserAdmin(req.user);
        const hasAssetDeletePerm =
            uid && (await hasPermission(uid, 'hrm_asset', 'delete'));

        const { id, docId } = req.params;

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const fleetVehicle = isFleetVehicleAssetFields({ plateNumber: asset.plateNumber });
        if (fleetVehicle) {
            // Inactive fleet profile: any authenticated user may delete cards/documents.
            // Active fleet profile: portal Super User only (not Flowchart Admin Officer).
            if (isFleetVehicleProfileActive(asset) && !isAdminUser) {
                return res.status(403).json({
                    message: 'Only administrator can delete vehicle documents on an active profile.',
                });
            }
        } else if (!isAdminUser && !hasAssetDeletePerm) {
            return res.status(403).json({ message: 'Only administrator can delete asset documents.' });
        }

        const doc = asset.documents.id(docId);
        if (!doc) {
            return res.status(404).json({ message: 'Document not found' });
        }

        const idsToDelete = collectAssetDocumentIdsForDeletion(asset.documents, docId);
        const removedSnapshots = [];
        for (const removeId of idsToDelete) {
            const sub = asset.documents.id(removeId);
            if (sub) {
                removedSnapshots.push(sub.toObject ? sub.toObject() : { ...sub });
            }
        }

        const docName = doc.name;
        const docSnapshot = doc.toObject ? doc.toObject() : { ...doc };
        await awaitAdminDeletionArchive(req, {
            moduleName: 'Asset Document',
            recordId: asset.assetId || String(asset._id),
            details: `${docName || docSnapshot?.type || 'Document'} on ${asset.name || asset.assetId}`,
            deletedPayload: {
                assetId: asset.assetId,
                mongoAssetId: asset._id,
                assetName: asset.name,
                document: docSnapshot,
                relatedDocuments: removedSnapshots.length > 1 ? removedSnapshots.slice(1) : [],
            },
        });
        for (const removeId of idsToDelete) {
            asset.documents.pull({ _id: removeId });
        }
        await asset.save();

        // Log to history
        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Update',
                performedBy: req.user.employeeObjectId || req.user._id,
                comments: `Document "${docName}" deleted.`,
                details: { type: 'DocumentDelete', docName }
            });
        } catch (historyErr) {
        }

        res.status(200).json({
            message: 'Document deleted successfully',
            deletedCount: idsToDelete.length,
            deletedIds: idsToDelete,
        });
    } catch (error) {
        res.status(500).json({ message: 'Internal server error' });
    }
};


// @desc    Add a service record to an asset item
// @route   POST /api/AssetItem/:id/service
// @access  Private
export const addAssetService = async (req, res) => {
    try {
        const { id } = req.params;
        const { serviceType, date, expiryDate, currentKm, description, paidBy, value, remark, invoice, attachment, quotation2, quotation3, tireCondition, bodyWorkImages, accidentImages, serviceRequestSource, isDraft } = req.body;

        const asset = await AssetItem.findById(id).populate('typeId', 'name');
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const isVehicleAssetForServiceGate = () => {
            const plate = String(asset.plateNumber || '').trim();
            if (plate) return true;
            const name = (asset.typeId && typeof asset.typeId === 'object' && asset.typeId.name)
                ? String(asset.typeId.name)
                : '';
            const t = name.toLowerCase();
            return t.includes('vehicle') || t.includes('car') || t.includes('fleet') || t.includes('truck');
        };

        const vehicleServiceRequestSourcesAllowed = new Set(['vehicle_fleet_dashboard', 'vehicle_asset_detail']);
        if (
            isVehicleAssetForServiceGate() &&
            !vehicleServiceRequestSourcesAllowed.has(String(serviceRequestSource || '').trim())
        ) {
            return res.status(403).json({
                message:
                    'Vehicle service requests must be raised from the vehicle asset page or the Vehicle Fleet dashboard.',
            });
        }

        // Multiple same-type (and cross-type) service requests may coexist.
        // A previous request still ending does not block raising or approving the next.

        // Fleet vehicle service request: any authenticated user (same rule as route middleware).
        const isFleetVehicleServiceRequest =
            isVehicleAssetForServiceGate() && serviceRequestSource === 'vehicle_fleet_dashboard';

        // Permission: asset controller/admin OR assignee (non-fleet vehicle, or non-vehicle assets)
        // Also allow:
        // - assigner (asset.assignedBy) with full permissions
        // - primary reportee delegation when assignee has NO companyEmail
        const actorFlags = await getActorPermissionFlagsForAsset(req.user, asset);
        const isOilServiceBootstrap =
            isVehicleAssetForServiceGate() &&
            String(serviceType || '').trim() === 'Oil Service' &&
            !!isDraft;
        const isVehicleServiceTabBootstrap =
            isVehicleAssetForServiceGate() &&
            isVehicleServiceTabRequestType(serviceType) &&
            !!isDraft &&
            !isTireChangeServiceType(serviceType);
        const isCarWashRequest =
            isVehicleAssetForServiceGate() &&
            String(serviceType || '').trim() === 'Car Wash';
        if (isVehicleAssetForServiceGate() && isTireChangeServiceType(serviceType)) {
            let earlyRemark = {};
            if (remark && typeof remark === 'string') {
                try {
                    earlyRemark = JSON.parse(remark);
                } catch {
                    earlyRemark = {};
                }
            } else if (remark && typeof remark === 'object') {
                earlyRemark = remark;
            }
            if (req.body?.autoCreated || earlyRemark?.autoCreated) {
                return res.status(403).json({
                    message:
                        'Tire change requests cannot be auto-created by the system. Create them manually from the vehicle Service tab.',
                });
            }
            if (!isDraft) {
                return res.status(403).json({
                    message:
                        'Tire change must be created as a pending request from the vehicle Service tab (Request Tire Change).',
                });
            }
            if (String(serviceRequestSource || '').trim() !== 'vehicle_asset_detail' &&
                String(serviceRequestSource || '').trim() !== 'vehicle_fleet_dashboard') {
                return res.status(403).json({
                    message: 'Tire change requests must be created from the vehicle asset Service tab or Vehicle list.',
                });
            }
            const allowed = await actorMayCreateOrInitiateVehicleService(req.user);
            if (!allowed) {
                return res.status(403).json({
                    message: 'Access denied. Sign in to create a tire change request.',
                });
            }
        } else if (isCarWashRequest) {
            const allowed = await actorMayCreateOrInitiateVehicleService(req.user);
            if (!allowed) {
                return res.status(403).json({
                    message: 'Access denied. Sign in to raise a car wash request.',
                });
            }
            let earlyCarWashRemark = {};
            if (remark && typeof remark === 'string') {
                try {
                    earlyCarWashRemark = JSON.parse(remark);
                } catch {
                    earlyCarWashRemark = {};
                }
            } else if (remark && typeof remark === 'object') {
                earlyCarWashRemark = remark;
            }
            const washMonth = earlyCarWashRemark?.carWashMonth;
            if (washMonth && findExistingCarWashForMonth(asset, washMonth)) {
                return res.status(400).json({
                    message:
                        'This vehicle already has a car wash for that month. Only one car wash is allowed per month.',
                });
            }
            const washMonthKey = normalizeCarWashMonthKey(washMonth);
            const latestWashMonth = getLatestOccupiedCarWashMonth(asset);
            if (washMonthKey && latestWashMonth && washMonthKey <= latestWashMonth) {
                return res.status(400).json({
                    message:
                        'Car wash month must be after the previous wash month. Previous and earlier months are not allowed.',
                });
            }
        } else if (isOilServiceBootstrap || isVehicleServiceTabBootstrap) {
            const allowed = await actorMayCreateOrInitiateVehicleService(req.user);
            if (!allowed) {
                return res.status(403).json({
                    message: 'Access denied. Sign in to raise this service request.',
                });
            }
        } else if (!isFleetVehicleServiceRequest && !actorFlags.canAct) {
            // Non-vehicle / non-bootstrap service adds stay on the existing actor gate.
            return res.status(403).json({ message: 'Access denied. Only Asset Controller/Admin, assigner, assigned user, or (if assignee has no company email) primary reportee can add service records.' });
        }

        let invoiceUrl = null;
        if (invoice && invoice.data) {
            try {
                const uploadResult = await uploadDocumentToS3(invoice.data, 'asset-service-invoices', invoice.name);
                invoiceUrl = uploadResult.publicId;
            } catch (error) {
                return res.status(500).json({ message: 'Failed to upload invoice' });
            }
        }

        let attachmentUrl = null;
        if (attachment && attachment.data) {
            try {
                const uploadResult = await uploadDocumentToS3(
                    attachment.data,
                    'asset-service-attachments',
                    attachment.name || `service-attachment-${Date.now()}.pdf`
                );
                attachmentUrl = uploadResult.publicId;
            } catch (error) {
                return res.status(500).json({ message: 'Failed to upload attachment' });
            }
        }

        let quotation2Url = null;
        if (quotation2 && quotation2.data) {
            try {
                const uploadResult = await uploadDocumentToS3(
                    quotation2.data,
                    'asset-service-attachments',
                    quotation2.name || `service-quotation2-${Date.now()}.pdf`
                );
                quotation2Url = uploadResult.publicId;
            } catch (error) {
                return res.status(500).json({ message: 'Failed to upload quotation 2' });
            }
        }

        let quotation3Url = null;
        if (quotation3 && quotation3.data) {
            try {
                const uploadResult = await uploadDocumentToS3(
                    quotation3.data,
                    'asset-service-attachments',
                    quotation3.name || `service-quotation3-${Date.now()}.pdf`
                );
                quotation3Url = uploadResult.publicId;
            } catch (error) {
                return res.status(500).json({ message: 'Failed to upload quotation 3' });
            }
        }
        const bodyWorkImageUrls = [];
        if (Array.isArray(bodyWorkImages) && bodyWorkImages.length) {
            for (const img of bodyWorkImages) {
                if (!img?.data) continue;
                try {
                    const uploadResult = await uploadDocumentToS3(
                        img.data,
                        'asset-service-attachments',
                        img.name || `body-work-image-${Date.now()}.jpg`
                    );
                    bodyWorkImageUrls.push({
                        url: uploadResult.publicId,
                        name: img.name || 'Body work image',
                    });
                } catch (error) {
                    return res.status(500).json({ message: 'Failed to upload body work images' });
                }
            }
        }
        const accidentImageUrls = [];
        if (Array.isArray(accidentImages) && accidentImages.length) {
            for (const img of accidentImages) {
                if (!img?.data) continue;
                try {
                    const uploadResult = await uploadDocumentToS3(
                        img.data,
                        'asset-service-attachments',
                        img.name || `accident-image-${Date.now()}.jpg`
                    );
                    accidentImageUrls.push({
                        url: uploadResult.publicId,
                        name: img.name || 'Accident image',
                    });
                } catch (error) {
                    return res.status(500).json({ message: 'Failed to upload accident images' });
                }
            }
        }

        let parsedRemark = null;
        if (remark && typeof remark === 'string') {
            try {
                parsedRemark = JSON.parse(remark);
            } catch {
                parsedRemark = null;
            }
        }
        let tireConditionUrl = null;
        if (tireCondition && tireCondition.data) {
            try {
                const uploadResult = await uploadDocumentToS3(
                    tireCondition.data,
                    'asset-service-attachments',
                    tireCondition.name || `service-tire-condition-${Date.now()}.pdf`
                );
                tireConditionUrl = uploadResult.publicId;
            } catch (error) {
                return res.status(500).json({ message: 'Failed to upload tire condition file' });
            }
        }

        // Create the service record (explicit subdoc _id for stable keys in UI + workflow linkage)
        const remarkObj = parsedRemark && typeof parsedRemark === 'object' ? parsedRemark : {};
        if (tireConditionUrl) {
            remarkObj.tireConditionUrl = tireConditionUrl;
            remarkObj.tireConditionName = tireCondition.name || '';
        }
        if (bodyWorkImageUrls.length) {
            remarkObj.bodyWorkImages = bodyWorkImageUrls;
        }
        if (accidentImageUrls.length) {
            remarkObj.accidentImages = accidentImageUrls;
        }
        remarkObj.requestStatus =
            isVehicleAssetForServiceGate() &&
            (String(serviceType || '').trim() === 'Oil Service' || isVehicleServiceTabRequestType(serviceType)) &&
            isDraft
                ? String(parsedRemark?.requestStatus || 'pending').toLowerCase() === 'draft'
                    ? 'draft'
                    : 'pending'
                : isDraft
                  ? 'draft'
                  : 'submitted';
        remarkObj.requestedByUserId = req.user?.id || req.user?._id || null;
        if (String(serviceType || '').trim() === 'Car Wash' && !isDraft) {
            remarkObj.carWashPaymentStatus = 'pending';
        }
        const newService = {
            _id: new mongoose.Types.ObjectId(),
            serviceReqNo: allocateNextServiceReqNo(asset),
            serviceType,
            date: date || new Date(),
            expiryDate: expiryDate || null,
            currentKm: currentKm || null,
            description,
            paidBy,
            value: value || 0,
            remark: JSON.stringify(remarkObj),
            invoice: invoiceUrl,
            attachment: attachmentUrl,
            requestedBy: req.user.employeeObjectId || undefined,
            ...(quotation2Url ? { quotation2: quotation2Url } : {}),
            ...(quotation3Url ? { quotation3: quotation3Url } : {}),
        };

        asset.services.push(newService);

        const isOilServicePendingCreate =
            isVehicleAssetForServiceGate() &&
            String(serviceType || '').trim() === 'Oil Service' &&
            isDraft &&
            remarkObj.requestStatus === 'pending';
        if (isOilServicePendingCreate) {
            const creatorName = await getRequesterName(req.user);
            appendOilServiceActivity(newService, {
                type: 'service_created',
                byName: creatorName,
                note: 'Oil service request created',
            });
        }

        const isTireChangePendingCreate =
            isVehicleAssetForServiceGate() &&
            isTireChangeServiceType(serviceType) &&
            isDraft &&
            remarkObj.requestStatus === 'pending';
        if (isTireChangePendingCreate) {
            const creatorName = await getRequesterName(req.user);
            remarkObj.requestedByName = creatorName;
            newService.remark = JSON.stringify(remarkObj);
            appendTireChangeActivity(newService, {
                type: 'service_created',
                byName: creatorName,
                note: 'Tire change request created',
            });
        }

        // Update asset's current kilometer if provided in service record
        if (currentKm && Number(currentKm) > (asset.currentKilometer || 0)) {
            asset.currentKilometer = Number(currentKm);
        }

        // Update specialized dates if it's an Oil Service
        if (serviceType === 'Oil Service') {
            asset.oilChangeDate = date || new Date();
            asset.lastServiceDate = date || new Date();
        } else if (serviceType === 'Accident Repair') {
            const accidentStatus = parsedRemark?.accidentStatus || 'Active';
            if (accidentStatus === 'Active') {
                const start = parsedRemark?.accidentDate ? new Date(parsedRemark.accidentDate) : (date ? new Date(date) : new Date());
                const until = new Date(start);
                until.setDate(until.getDate() + 60);
                asset.status = 'Accident';
                asset.accidentStartedAt = start;
                asset.accidentActiveUntil = until;
                asset.accidentReminderLastSentAt = null;
            }
            asset.lastServiceDate = date || new Date();
        } else {
            // General last service date update
            asset.lastServiceDate = date || new Date();
        }

        await asset.save();

        const lastServiceDoc = asset.services[asset.services.length - 1];

        if (isVehicleAssetForServiceGate()) {
            const createStatus = String(remarkObj.requestStatus || '').toLowerCase();
            const notifyAdminOnCreate = !isDraft || createStatus === 'pending';
            if (notifyAdminOnCreate && lastServiceDoc?._id) {
                try {
                    const creatorName =
                        remarkObj.requestedByName || (await getRequesterName(req.user));
                    await notifyAdminOfficerOnVehicleServiceCreated({
                        asset,
                        serviceRecordId: lastServiceDoc._id,
                        serviceType,
                        requestedByName: creatorName,
                    });
                } catch (notifyErr) {
                    console.error('[addAssetService] Admin officer create notify failed:', notifyErr);
                }
            }
        }

        const skipWorkflowForOilPending =
            isVehicleAssetForServiceGate() &&
            String(serviceType || '').trim() === 'Oil Service' &&
            isDraft &&
            remarkObj.requestStatus === 'pending';
        const skipWorkflowForVehicleTabPending =
            isVehicleAssetForServiceGate() &&
            isVehicleServiceTabRequestType(serviceType) &&
            isDraft &&
            remarkObj.requestStatus === 'pending';
        const skipLegacyWorkflowForOil =
            isVehicleAssetForServiceGate() &&
            String(serviceType || '').trim() === 'Oil Service';
        if (!isDraft && !skipWorkflowForOilPending && !skipWorkflowForVehicleTabPending && !skipLegacyWorkflowForOil) {
            try {
                if (String(serviceType || '').trim() === 'Car Wash') {
                    await maybeStartCarWashWorkflow(asset, {
                        serviceRecordId: lastServiceDoc._id,
                        req,
                    });
                } else {
                    await maybeStartVehicleServiceWorkflow(asset, {
                        serviceRecordId: lastServiceDoc._id,
                        serviceType,
                        req,
                    });
                }
            } catch (wfErr) {
            }
        }

        // Log to history
        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Service',
                performedBy: req.user.employeeObjectId || req.user._id,
                comments: `${isDraft ? 'Service draft saved' : 'Service record added'}: ${serviceType}. ${description || ''}`,
                details: { type: 'ServiceAdd', serviceType, value, description, isDraft: !!isDraft }
            });
        } catch (historyErr) {
        }

        // Return signed URL for the new invoice
        const addedService = asset.services[asset.services.length - 1].toObject();
        if (addedService.invoice) {
            addedService.invoice = await getSignedFileUrl(addedService.invoice);
        }
        if (addedService.attachment) {
            addedService.attachment = await getSignedFileUrl(addedService.attachment);
        }
        if (addedService.quotation2) {
            addedService.quotation2 = await getSignedFileUrl(addedService.quotation2);
        }
        if (addedService.quotation3) {
            addedService.quotation3 = await getSignedFileUrl(addedService.quotation3);
        }

        res.status(200).json({ message: isDraft ? 'Service draft saved successfully' : 'Service record added successfully', service: addedService });
    } catch (error) {
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Delete a service record from an asset item
// @route   DELETE /api/AssetItem/:id/service/:serviceId
// @access  Private (inactive fleet: any auth user; active fleet / non-fleet: Super User)
export const deleteAssetService = async (req, res) => {
    try {
        const isJwtAdmin = isJwtSystemSuperUser(req.user);
        const isSysAdmin = await isUserAdministrator(req.user?.id);
        const isAdminUser = isJwtAdmin || isSysAdmin;

        const { id, serviceId } = req.params;
        if (!id || !serviceId) {
            return res.status(400).json({ message: 'Asset id and service id are required' });
        }

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const isFleetVehicle =
            String(asset.plateNumber || '').trim() !== '' ||
            String(asset.vehicleProfileActivationStatus || '').trim() !== '';
        const fleetProfileActive =
            String(asset.vehicleProfileActivationStatus || '').toLowerCase() === 'active';

        if (isFleetVehicle) {
            // Inactive: any authenticated user. Active: portal Super User only.
            if (fleetProfileActive && !isAdminUser) {
                return res.status(403).json({
                    message: 'Only administrator can delete service records on an active vehicle profile.',
                });
            }
        } else if (!isAdminUser) {
            return res.status(403).json({ message: 'Access denied. Only admin can delete service records.' });
        }

        const serviceSubdoc = asset.services?.id?.(serviceId);
        if (!serviceSubdoc) {
            return res.status(404).json({ message: 'Service record not found' });
        }

        const removedServiceType = serviceSubdoc.serviceType || 'Service';
        const serviceSnapshot = serviceSubdoc.toObject ? serviceSubdoc.toObject() : { ...serviceSubdoc };

        await deleteDashboardActionsForVehicleService(asset._id, serviceId);

        serviceSubdoc.deleteOne();
        asset.markModified('services');

        if (
            asset.activeServiceWorkflow?.serviceRecordId &&
            String(asset.activeServiceWorkflow.serviceRecordId) === String(serviceId)
        ) {
            asset.activeServiceWorkflow = undefined;
            asset.markModified('activeServiceWorkflow');
        }

        await asset.save();

        scheduleManagementAdminDeletionEmail(req, {
            moduleName: 'Vehicle Service Record',
            recordId: asset.assetId || String(asset._id),
            details: `${removedServiceType} service (${serviceId})`,
            deletedPayload: {
                assetId: asset.assetId,
                mongoAssetId: asset._id,
                assetName: asset.name,
                service: serviceSnapshot,
            },
        });

        try {
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Service',
                performedBy: req.user.employeeObjectId || req.user._id,
                comments: `Service record deleted: ${removedServiceType}.`,
                details: { type: 'ServiceDelete', serviceId, serviceType: removedServiceType },
            });
        } catch (historyErr) {
        }

        return res.status(200).json({ message: 'Service record deleted successfully' });
    } catch (error) {
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Submit a previously saved draft service request (starts workflow)
// @route   POST /api/AssetItem/:id/service/:serviceId/submit-request
// @access  Private
export const updateAssetServiceDraft = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('typeId', 'name');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const service = asset.services?.id?.(serviceId);
        if (!service) return res.status(404).json({ message: 'Service record not found' });

        const remarkObj = (() => {
            try {
                return service.remark ? JSON.parse(service.remark) : {};
            } catch {
                return {};
            }
        })();
        const reqStatus = String(remarkObj?.requestStatus || '').toLowerCase();
        if (!['draft', 'pending'].includes(reqStatus)) {
            return res.status(400).json({ message: 'Only pending service requests can be updated.' });
        }

        const isVehicleAssetForServiceGate = () => {
            const plate = String(asset.plateNumber || '').trim();
            if (plate) return true;
            const name = (asset.typeId && typeof asset.typeId === 'object' && asset.typeId.name)
                ? String(asset.typeId.name)
                : '';
            const t = name.toLowerCase();
            return t.includes('vehicle') || t.includes('car') || t.includes('fleet') || t.includes('truck');
        };

        const actorFlags = await getActorPermissionFlagsForAsset(req.user, asset);
        const isOilServicePending =
            String(service.serviceType || '').trim() === 'Oil Service' &&
            ['draft', 'pending'].includes(String(remarkObj?.requestStatus || '').toLowerCase());
        const isVehicleServiceTabPending =
            isVehicleServiceTabRequestType(service.serviceType) &&
            ['draft', 'pending'].includes(String(remarkObj?.requestStatus || '').toLowerCase());
        const isTireChangePending =
            isTireChangeServiceType(service.serviceType) &&
            ['draft', 'pending'].includes(String(remarkObj?.requestStatus || '').toLowerCase());
        if (isTireChangePending) {
            const allowed = await actorMayCreateOrInitiateVehicleService(req.user);
            if (!allowed) {
                return res.status(403).json({
                    message: 'Access denied. Sign in to update this tire change request.',
                });
            }
        } else if (isOilServicePending || isVehicleServiceTabPending) {
            const allowed = await actorMayCreateOrInitiateVehicleService(req.user);
            if (!allowed) {
                return res.status(403).json({
                    message: 'Access denied. Sign in to update this service request.',
                });
            }
        } else if (!actorFlags.canAct) {
            return res.status(403).json({
                message: 'Access denied. Only Asset Controller/Admin, assigner, assigned user, or primary reportee can update service records.',
            });
        }

        const body = { ...(req.body || {}) };
        if (body.remark && typeof body.remark === 'string') {
            try {
                const parsed = JSON.parse(body.remark);
                const keepStatus = String(remarkObj?.requestStatus || 'pending').toLowerCase();
                if (['draft', 'pending'].includes(keepStatus)) {
                    parsed.requestStatus = keepStatus;
                } else if (keepStatus === 'submitted') {
                    parsed.requestStatus = 'submitted';
                }
                body.remark = JSON.stringify(parsed);
            } catch {
                /* keep as sent */
            }
        }

        await mergeWorkflowServiceRecord(asset, serviceId, body);

        if (isOilServicePending || isVehicleServiceTabPending) {
            const editorName = await getRequesterName(req.user);
            if (isOilServicePending) {
                appendOilServiceActivity(service, {
                    type: 'service_updated',
                    byName: editorName,
                    note: 'Assignment details updated',
                });
            }
            asset.markModified('services');
        }

        if (isTireChangePending) {
            const editorName = await getRequesterName(req.user);
            appendTireChangeActivity(service, {
                type: 'service_updated',
                byName: editorName,
                note: 'Assignment details updated',
            });
            asset.markModified('services');
        }

        if (isVehicleAssetForServiceGate() && body.serviceType === 'Oil Service' && body.date) {
            asset.oilChangeDate = new Date(body.date);
            asset.lastServiceDate = new Date(body.date);
        }

        await asset.save();

        const updated = asset.services.id(serviceId);
        const out = updated?.toObject ? updated.toObject() : updated;
        if (out?.invoice) out.invoice = await getSignedFileUrl(out.invoice);
        if (out?.attachment) out.attachment = await getSignedFileUrl(out.attachment);
        if (out?.quotation2) out.quotation2 = await getSignedFileUrl(out.quotation2);
        if (out?.quotation3) out.quotation3 = await getSignedFileUrl(out.quotation3);

        return res.json({ message: 'Service draft updated successfully', service: out });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to update service draft' });
    }
};

export const submitAssetServiceDraft = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('typeId', 'name');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        const service = asset.services?.id?.(serviceId);
        if (!service) return res.status(404).json({ message: 'Service record not found' });

        const remarkObj = (() => {
            try {
                return service.remark ? JSON.parse(service.remark) : {};
            } catch {
                return {};
            }
        })();
        const reqStatus = String(remarkObj?.requestStatus || '').toLowerCase();
        if (!['draft', 'pending'].includes(reqStatus)) {
            return res.status(400).json({ message: 'Only pending service requests can be submitted.' });
        }

        const allowed = await actorMayCreateOrInitiateVehicleService(req.user);
        if (!allowed) {
            return res.status(403).json({
                message: 'Access denied. Sign in to submit (initiate) this service request.',
            });
        }

        if (String(service.serviceType || '').trim() === 'Oil Service') {
            try {
                await submitOilServiceAssignment(asset, serviceId, req);
            } catch (oilErr) {
                return res.status(400).json({ message: oilErr.message || 'Could not submit oil service assignment.' });
            }
            const fresh = await AssetItem.findById(asset._id).lean();
            const out = fresh?.services?.find((s) => String(s._id) === String(service._id)) || service.toObject();
            return res.json({ message: 'Oil service assignment submitted', service: out, asset: fresh });
        }

        remarkObj.requestStatus = 'submitted';
        remarkObj.assignmentSubmittedAt = new Date().toISOString();
        if (String(service.serviceType || '').trim() === 'Car Wash') {
            remarkObj.carWashPaymentStatus = 'pending';
        }
        if (isTireChangeServiceType(service.serviceType)) {
            const requesterName = await getRequesterName(req.user);
            remarkObj.requestedByName = requesterName;
            service.remark = JSON.stringify(remarkObj);
            appendTireChangeActivity(service, {
                type: 'request_submitted',
                byName: requesterName,
                note: 'Tire change request submitted',
            });
        } else {
            service.remark = JSON.stringify(remarkObj);
        }
        asset.markModified('services');
        await asset.save();

        try {
            if (String(service.serviceType || '').trim() === 'Car Wash') {
                await maybeStartCarWashWorkflow(asset, {
                    serviceRecordId: service._id,
                    req,
                });
            } else {
                await maybeStartVehicleServiceWorkflow(asset, {
                    serviceRecordId: service._id,
                    serviceType: service.serviceType,
                    req,
                });
            }
        } catch (wfErr) {
        }

        const fresh = await AssetItem.findById(asset._id).lean();
        const out = fresh?.services?.find((s) => String(s._id) === String(service._id)) || service.toObject();
        return res.json({ message: 'Draft submitted successfully', service: out, asset: fresh });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Internal server error' });
    }
};

export const saveOilServiceDetailsDraftHandler = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const allowed = await actorMayManageOilServiceRequest(req.user, asset);
        if (!allowed) {
            return res.status(403).json({ message: 'Access denied.' });
        }

        await saveOilServiceDetailsDraft(asset, serviceId, req.body?.serviceUpdates || req.body);
        const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
        return res.json({ message: 'Service details saved', asset: fresh });
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Could not save service details' });
    }
};

export const submitOilServiceDetailsHandler = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const allowed = await actorMayManageOilServiceRequest(req.user, asset);
        if (!allowed) {
            return res.status(403).json({ message: 'Access denied.' });
        }

        const result = await submitOilServiceDetails(
            asset,
            serviceId,
            req.body?.serviceUpdates || req.body,
            req,
        );
        const freshAsset = result?.asset || result;
        const zohoBillSync = result?.zohoBillSync || null;
        const routedTo = result?.routedTo || '';
        const message =
            routedTo === 'pending_hr'
                ? 'Oil service ended. Cash payment sent to HR for approval, then Accounts will create the Zoho bill.'
                : zohoBillSync?.ok
                  ? `Oil service completed. ${zohoBillSync.message || 'Zoho bill created.'}`
                  : 'Oil service completed. Vehicle status restored.';
        return res.json({
            message,
            routedTo,
            zohoBillOk: Boolean(zohoBillSync?.ok),
            zohoBillMessage: zohoBillSync?.message || '',
            asset: freshAsset,
        });
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Could not submit service details' });
    }
};

export const updateTireChangeQuoteEmployeeRowsHandler = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        await updateTireChangeQuoteEmployeeRows(asset, serviceId, req.body?.employeeRows, req);
        const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
        return res.json({
            message: 'Employee liability rows saved',
            asset: fresh,
        });
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Could not save employee rows' });
    }
};

export const submitTireChangeGarageHandler = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        await submitTireChangeGarage(asset, serviceId, req.body || {}, req);
        const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
        return res.json({
            message: 'Garage details saved — sent to Accounts for approval',
            asset: fresh,
        });
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Could not update garage' });
    }
};

export const completeTireChangeHandler = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        await completeTireChangeService(asset, serviceId, req.body || {}, req);
        const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
        return res.json({
            message: 'Tire change completed',
            asset: fresh,
        });
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Could not complete tire change' });
    }
};

export const updateMechanicalWorkQuoteEmployeeRowsHandler = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        await updateMechanicalWorkQuoteEmployeeRows(asset, serviceId, req.body?.employeeRows, req);
        const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
        return res.json({
            message: 'Employee liability rows saved',
            asset: fresh,
        });
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Could not save employee rows' });
    }
};

export const submitMechanicalWorkGarageHandler = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        await submitMechanicalWorkGarage(asset, serviceId, req.body || {}, req);
        const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
        return res.json({
            message: 'Garage details saved — sent to Accounts for approval',
            asset: fresh,
        });
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Could not update garage' });
    }
};

export const completeMechanicalWorkHandler = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        await completeMechanicalWorkService(asset, serviceId, req.body || {}, req);
        const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
        return res.json({
            message: 'Mechanical work completed',
            asset: fresh,
        });
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Could not complete mechanical work' });
    }
};

export const updateBodyWorkQuoteEmployeeRowsHandler = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        await updateBodyWorkQuoteEmployeeRows(asset, serviceId, req.body?.employeeRows, req);
        const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
        return res.json({
            message: 'Employee liability rows saved',
            asset: fresh,
        });
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Could not save employee rows' });
    }
};

export const submitBodyWorkGarageHandler = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        await submitBodyWorkGarage(asset, serviceId, req.body || {}, req);
        const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
        return res.json({
            message: 'Garage details saved — sent to Accounts for approval',
            asset: fresh,
        });
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Could not update garage' });
    }
};

export const completeBodyWorkHandler = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        await completeBodyWorkService(asset, serviceId, req.body || {}, req);
        const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
        return res.json({
            message: 'Body work completed',
            asset: fresh,
        });
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Could not complete body work' });
    }
};

export const updateAccidentRepairQuoteEmployeeRowsHandler = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        await updateAccidentRepairQuoteEmployeeRows(asset, serviceId, req.body?.employeeRows, req);
        const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
        return res.json({
            message: 'Employee liability rows saved',
            asset: fresh,
        });
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Could not save employee rows' });
    }
};

export const submitAccidentRepairGarageHandler = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        await submitAccidentRepairGarage(asset, serviceId, req.body || {}, req);
        const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
        return res.json({
            message: 'Garage details saved — sent to Accounts for approval',
            asset: fresh,
        });
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Could not update garage' });
    }
};

export const completeAccidentRepairHandler = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        await completeAccidentRepairService(asset, serviceId, req.body || {}, req);
        const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
        return res.json({
            message: 'Accident repair completed',
            asset: fresh,
        });
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Could not complete accident repair' });
    }
};

/** Retry Zoho bill after Accounts approve when first sync failed (e.g. bill_number). */
export const retryGarageZohoBillHandler = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const { retryVehicleGarageZohoBill } = await import('../utils/retryVehicleGarageZohoBill.js');
        const result = await retryVehicleGarageZohoBill(asset, serviceId, {
            serviceTypeLabel: req.body?.serviceTypeLabel || '',
        });
        const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
        return res.json({
            message: result?.message || (result?.ok ? 'Zoho bill created.' : 'Zoho bill sync failed.'),
            zohoBillOk: Boolean(result?.ok),
            zohoBillId: result?.billId || '',
            zohoBillNumber: result?.billNumber || '',
            zohoBillMessage: result?.message || '',
            asset: fresh,
        });
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Could not create Zoho garage bill' });
    }
};

export const updateOilServiceDatesHandler = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const mayEditDates = await userMayEditOilServiceDates(req.user, asset, serviceId);
        if (!mayEditDates) {
            return res.status(403).json({
                message:
                    'Only the Admin Officer, assigned user (while scheduled), or Super User can update service dates.',
            });
        }

        const { serviceStartDate, serviceEndDate } = req.body || {};
        await updateOilServiceDates(asset, serviceId, { serviceStartDate, serviceEndDate }, req.user);
        const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
        return res.json({ message: 'Service dates updated', asset: fresh });
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Could not update service dates' });
    }
};

export const updateShopServiceExtendDateHandler = async (req, res) => {
    try {
        const { id, serviceId } = req.params;
        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const mayEdit = await userMayExtendServiceEndDate(req.user, asset, serviceId);
        if (!mayEdit) {
            return res.status(403).json({
                message: 'Only the Admin Officer, assigned user, or Super User can update the extend date.',
            });
        }

        const { serviceEndDate } = req.body || {};
        await updateShopServiceExtendDate(asset, serviceId, { serviceEndDate }, req.user);
        const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
        return res.json({ message: 'Extend date updated', asset: fresh });
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Could not update extend date' });
    }
};

// Transfer asset from one employee to another (requires approval)
export const transferAsset = async (req, res) => {
    try {
        const { assetId, fromEmployeeId, toEmployeeId, transferType } = req.body;

        // Validate input
        if (!assetId || !toEmployeeId) {
            return res.status(400).json({ message: 'Asset ID and target employee are required' });
        }

        // Find the asset
        const asset = await AssetItem.findById(assetId).populate('assignedTo');
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const onLeaveBlock = assertAssetNotOnLeaveForTransfer(asset);
        if (!onLeaveBlock.ok) {
            return res.status(400).json({ message: onLeaveBlock.message });
        }

        // Permission: asset controller/admin OR assignee
        // Also allow assigner (asset.assignedBy) + primary reportee delegation when assignee has NO companyEmail
        const actorFlags = await getActorPermissionFlagsForAsset(req.user, asset);
        if (!actorFlags.canAct) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller/Admin, assigner, assigned user, or delegated primary reportee can transfer assets.' });
        }

        const assetController = await getDepartmentHOD('assetcontroller');

        // Create transfer request for approval
        const transferRequest = {
            assetId: asset._id,
            assetName: asset.name,
            assetId: asset.assetId,
            fromEmployeeId: fromEmployeeId || asset.assignedTo?._id,
            toEmployeeId: toEmployeeId,
            requestedBy: req.user.employeeObjectId,
            transferType: transferType || 'individual',
            status: 'Pending',
            createdAt: new Date()
        };

        // Create a dashboard action for approval
        const DashboardAction = (await import('../models/DashboardAction.js')).default;
        await DashboardAction.create({
            moduleId: 'hrm_asset',
            actionType: 'asset_transfer',
            title: `Asset Transfer: ${asset.name}`,
            description: `Transfer ${asset.assetId} from ${fromEmployeeId || 'current'} to ${toEmployeeId}`,
            status: 'Pending',
            actionData: transferRequest,
            assignedTo: assetController ? assetController._id : null,
            createdBy: req.user.employeeObjectId
        });

        await notifyAssignedEmployeeIfController(req, asset, 'Transfer Asset', `Transfer request was initiated by Asset Controller to employee ${toEmployeeId}.`);

        res.status(200).json({
            message: 'Transfer request sent for approval',
            transferRequest
        });
    } catch (error) {
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// @desc    Transfer asset assignee to another employee (AC or current assignee initiates; new assignee approves)
// @route   PUT /api/AssetItem/:id/transfer-assignee
// @access  Private (Asset Controller or assigned user)
export const transferAssigneeAsset = async (req, res) => {
    try {
        const { id } = req.params;
        const { assignedTo: toEmployeeId } = req.body;

        if (!toEmployeeId) {
            return res.status(400).json({ message: 'Target employee is required.' });
        }

        const item = await AssetItem.findById(id)
            .populate('assignedTo', 'firstName lastName employeeId companyEmail workEmail')
            .populate('assignedCompany', 'name companyId');
        if (!item) return res.status(404).json({ message: 'Asset not found' });

        if (item.assignedToType !== 'Employee' || !item.assignedTo) {
            return res.status(400).json({ message: 'Assignee transfer is only available for employee-assigned assets.' });
        }
        if (item.status !== 'Assigned' && item.status !== 'Pending') {
            return res.status(400).json({ message: 'Asset must be assigned to transfer the assignee.' });
        }
        if (isLeaveActive(item)) {
            return res.status(400).json({ message: ON_LEAVE_TRANSFER_BLOCKED_MESSAGE });
        }
        if (item.acceptanceStatus === 'Pending' && item.actionRequiredBy) {
            return res.status(400).json({ message: 'Asset already has a pending assignment. Resolve it before transferring.' });
        }

        const oldAssigneeId = (item.assignedTo._id || item.assignedTo).toString();
        if (oldAssigneeId === String(toEmployeeId)) {
            return res.status(400).json({ message: 'Cannot transfer to the same employee.' });
        }

        const actingEmpObjectId = req.user.employeeObjectId?.toString?.();
        if (!actingEmpObjectId) {
            return res.status(403).json({ message: 'You are not linked to an employee profile.' });
        }

        const isAdminUser = isJwtSystemSuperUser(req.user);
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);
        const isCurrentAssignee = actingEmpObjectId === oldAssigneeId;

        if (!isAdminUser && !isAssetController && !isCurrentAssignee) {
            return res.status(403).json({
                message: 'Only Asset Controller or the current assigned user can transfer the assignee.',
            });
        }

        const initiatedBy = isAssetController && !isCurrentAssignee ? 'assetcontroller' : 'assignee';

        const initiator = await EmployeeBasic.findById(actingEmpObjectId);
        if (!initiator?.signature?.url) {
            return res.status(403).json({ message: 'Your digital signature is required before initiating assignee transfer.' });
        }

        const oldAssignee = await loadEmployeeWithReportee(oldAssigneeId);
        const newAssignee = await loadEmployeeWithReportee(toEmployeeId);
        if (!newAssignee) return res.status(404).json({ message: 'Target employee not found.' });

        const resolvedActors = await resolveEmployeeAssignmentActors(newAssignee, actingEmpObjectId);
        if (resolvedActors.autoAcceptOnAssign) {
            return res.status(400).json({
                message: 'Cannot transfer to an employee who cannot self-acknowledge without a company email delegate.',
            });
        }

        item.pendingActionDetails = {
            ...(item.pendingActionDetails || {}),
            assigneeTransferContext: {
                isAssigneeTransfer: true,
                oldAssignedTo: oldAssigneeId,
                oldAssignedBy: (item.assignedBy?._id || item.assignedBy)?.toString?.() || null,
                oldAssignmentType: item.assignmentType || null,
                oldAssignedDays: item.assignedDays ?? null,
                oldAssignedDate: item.assignedDate || null,
                oldTemporaryEndDate: item.temporaryEndDate || null,
                oldTemporaryReminderSentAt: item.temporaryReminderSentAt || null,
                oldTemporaryExpiredSentAt: item.temporaryExpiredSentAt || null,
                initiatedBy,
                requestedBy: actingEmpObjectId,
            },
        };

        item.assignedToType = 'Employee';
        item.assignedTo = newAssignee._id;
        item.assignedCompany = null;
        item.assignedBy = actingEmpObjectId;
        item.acceptanceStatus = 'Pending';
        item.actionRequiredBy = resolvedActors.pendingActionActorId;
        item.status = 'Pending';
        item.negotiationHistory = [];

        await item.save();

        const itemForEmail = await AssetItem.findById(item._id).populate('categoryId', 'name').lean();
        let handoverPdf = [];
        try {
            handoverPdf = await buildAssigneeTransferHandoverAttachments(req, item._id, {
                assigner: initiator,
                oldAssignee,
                newAssignee,
            });
        } catch (e) {
            /* non-fatal */
        }

        await sendAssigneeTransferRequestEmails({
            req,
            asset: itemForEmail || item,
            oldAssignee,
            newAssignee,
            initiator,
            attachments: handoverPdf,
        });

        const subjectName = `${newAssignee.firstName || ''} ${newAssignee.lastName || ''}`.trim();
        await DashboardAction.findOneAndUpdate(
            { requestId: item._id, requestType: 'Asset Assignment', status: 'Pending' },
            {
                assignedTo: resolvedActors.pendingActionActorId,
                assignedToEmpId: newAssignee.employeeId,
                requestId: item._id,
                requestType: 'Asset Assignment',
                subjectEmployeeId: newAssignee.employeeId,
                subjectName,
                requestedByName: `${initiator.firstName || ''} ${initiator.lastName || ''}`.trim(),
                extra1: `${item.assetId} — ${item.name}`,
                extra2: 'Assignee Transfer',
                status: 'Pending',
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );

        await AssetHistory.create({
            assetId: item._id,
            action: 'Comment',
            performedBy: actingEmpObjectId,
            comments: `Assignee transfer requested to ${subjectName} (${newAssignee.employeeId}). Awaiting new assignee approval.`,
            date: new Date(),
            details: { type: 'AssigneeTransferRequest', initiatedBy, oldAssignedTo: oldAssigneeId, newAssignedTo: String(newAssignee._id) },
        });

        res.status(200).json({
            message: `Transfer request sent to ${subjectName} for approval.`,
            asset: item,
        });
    } catch (error) {
        res.status(500).json({ message: error?.message || 'Internal server error' });
    }
};

// Helper: Remove accessory from all history snapshots of an asset
const removeAccessoryFromHistorySnapshots = async (assetId, accessoryId) => {
    try {
        const histories = await AssetHistory.find({
            assetId: assetId,
            'details.accessories': { $exists: true }
        });

        for (let history of histories) {
            if (history.details && Array.isArray(history.details.accessories)) {
                const initialLen = history.details.accessories.length;
                history.details.accessories = history.details.accessories.filter(
                    acc => (acc._id?.toString() !== accessoryId?.toString()) &&
                        (acc.accessoryId !== accessoryId)
                );

                if (history.details.accessories.length !== initialLen) {
                    history.markModified('details');
                    await history.save();
                }
            }
        }
    } catch (err) {
    }
};

// Helper: Update counts
const updateAssetTypeCounts = async (typeId) => {
    const total = await AssetItem.countDocuments({ typeId: typeId });
    const assigned = await AssetItem.countDocuments({ typeId: typeId, status: 'Assigned' });
    const pending = await AssetItem.countDocuments({ typeId: typeId, status: 'Pending' });
    const unassigned = total - assigned - pending;

    await AssetType.findByIdAndUpdate(typeId, {
        total,
        assigned,
        unassigned
    });
};

// @desc    Transfer accessory from one asset to another
// @route   PUT /api/AssetItem/:id/accessories/:accId/transfer
// @access  Private
export const transferAssetAccessory = async (req, res) => {
    try {
        const { id, accId } = req.params;
        const { targetAssetId } = req.body;

        const sourceAsset = await AssetItem.findById(id);
        const targetAsset = await AssetItem.findById(targetAssetId);

        if (!sourceAsset || !targetAsset) {
            return res.status(404).json({ message: 'Source or Target asset not found' });
        }

        const onLeaveBlock = assertAssetNotOnLeaveForTransfer(sourceAsset);
        if (!onLeaveBlock.ok) {
            return res.status(400).json({ message: onLeaveBlock.message });
        }

        // Permission: asset controller/admin OR assignee
        // Also allow assigner (asset.assignedBy) + primary reportee delegation
        const actorFlags = await getActorPermissionFlagsForAsset(req.user, sourceAsset);
        if (!actorFlags.canAct) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller/Admin, assigner, assigned user, or delegated primary reportee can transfer accessories.' });
        }

        const accessoryIndex = sourceAsset.accessories.findIndex(a => a._id.toString() === accId || a.accessoryId === accId);
        if (accessoryIndex === -1) {
            return res.status(404).json({ message: 'Accessory not found in source asset' });
        }

        const accessory = sourceAsset.accessories[accessoryIndex];

        // Remove from source
        sourceAsset.accessories.splice(accessoryIndex, 1);

        // Add to target with new accessoryId (to match targets prefix if needed, but lets keep name/amount)
        const newAccessory = {
            ...accessory.toObject(),
            status: 'Attached',
            _id: new mongoose.Types.ObjectId() // New ID for the new location
        };

        targetAsset.accessories.push(newAccessory);

        await sourceAsset.save();
        await targetAsset.save();
        await notifyAssignedEmployeeIfController(req, sourceAsset, 'Transfer Accessory', `Accessory "${accessory.name}" was transferred out by Asset Controller.`);
        await notifyAssignedEmployeeIfController(req, targetAsset, 'Transfer Accessory', `Accessory "${accessory.name}" was transferred into your asset by Asset Controller.`);

        // Log History for Source
        await AssetHistory.create({
            assetId: sourceAsset._id,
            action: 'Comment',
            performedBy: req.user.employeeObjectId,
            comments: `Accessory "${accessory.name}"(${accessory.accessoryId}) transfered to asset ${targetAsset.assetId} `
        });

        // Sync Source History (remove from previous handover docs/snapshots)
        await removeAccessoryFromHistorySnapshots(sourceAsset._id, accessory._id || accessory.accessoryId);

        // Log History for Target
        await AssetHistory.create({
            assetId: targetAsset._id,
            action: 'Comment',
            performedBy: req.user.employeeObjectId,
            comments: `Accessory "${accessory.name}" received from asset ${sourceAsset.assetId} `
        });

        res.status(200).json({ message: 'Accessory transfered successfully', sourceAsset, targetAsset });
    } catch (error) {
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Update accessory status (Lost, Damaged, EOL)
// @route   PUT /api/AssetItem/:id/accessories/:accId/status
// @access  Private
export const manageAccessoryStatus = async (req, res) => {
    try {
        const { id, accId } = req.params;
        const { status, comments } = req.body;

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const accessory = asset.accessories.find(a => a._id.toString() === accId || a.accessoryId === accId);
        if (!accessory) {
            return res.status(404).json({ message: 'Accessory not found' });
        }

        // Permission: asset controller/admin OR assignee
        // Also allow assigner + primary reportee delegation when assignee has NO companyEmail
        const actorFlags = await getActorPermissionFlagsForAsset(req.user, asset);
        if (!actorFlags.canAct) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller/Admin, assigner, assigned user, or delegated primary reportee can update accessory status.' });
        }

        accessory.status = status;
        await asset.save();
        try {
            await syncAllAccessoryInstancesForAsset(asset);
        } catch (syncErr) {
        }
        await notifyAssignedEmployeeIfController(
            req,
            asset,
            `${status} Accessory`,
            `Accessory "${accessory.name}" was marked as ${status} by Asset Controller.`
        );

        // Log History
        await AssetHistory.create({
            assetId: asset._id,
            action: 'Comment',
            performedBy: req.user.employeeObjectId,
            comments: `Accessory "${accessory.name}" marked as ${status}.Note: ${comments || 'No comments'} `
        });

        // Sync History (remove from previous handover docs/snapshots if Lost/Damaged/EOL)
        if (['Lost', 'Damaged', 'End of Life', 'Transfered'].includes(status)) {
            await removeAccessoryFromHistorySnapshots(asset._id, accessory._id || accessory.accessoryId);
        }

        res.status(200).json({ message: `Accessory marked as ${status} `, asset });
    } catch (error) {
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Helper to send EOL notification emails dynamically using nodemailer
const sendEolEmail = async ({ toEmployee, ccEmployees = [], subject, bodyHtml, requesterName = "Asset Management" }) => {
    try {
        const { resolveEmployeeEmailTargets } = await import('../utils/resolveEmployeeEmail.js');
        const nodemailer = (await import('nodemailer')).default;
        const { resolveFrontendBaseUrl } = await import('../utils/resolveFrontendBaseUrl.js');

        const { to: toEmail, cc: toCc } = resolveEmployeeEmailTargets(toEmployee);
        if (!toEmail) {
            return;
        }

        const ccEmails = [...toCc];
        for (const emp of ccEmployees) {
            if (emp) {
                const { to: empEmail } = resolveEmployeeEmailTargets(emp);
                if (empEmail && !ccEmails.includes(empEmail) && empEmail !== toEmail) {
                    ccEmails.push(empEmail);
                }
            }
        }

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;

        if (!emailUser || !emailPass) {
            return;
        }

        let smtpHost = process.env.SMTP_HOST || "smtp.office365.com";
        if (emailUser.includes('@gmail.com')) smtpHost = "smtp.gmail.com";

        const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: parseInt(process.env.SMTP_PORT) || 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass }
        });

        const finalHtml = `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #f8f9fa; padding: 20px; border-bottom: 1px solid #eaeaea;">
                    <h2 style="color: #dc3545; margin: 0;">Asset End of Life Workflow</h2>
                </div>
                <div style="padding: 20px;">
                    ${bodyHtml}
                </div>
                <div style="background-color: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #999; border-top: 1px solid #eaeaea;">
                    This is an automated system notification from VeRP.
                </div>
            </div>
        `;

        await transporter.sendMail({
            fromName: requesterName,
            to: toEmail,
            ...(ccEmails.length ? { cc: ccEmails } : {}),
            subject,
            html: finalHtml
        });

    } catch (error) {
    }
};

// @desc    Request Asset Action (End of Life, Loss & Damage, or Leave)
// @route   PUT /api/AssetItem/:id/request-action
// @access  Private
export const requestAssetAction = async (req, res) => {
    try {
        const { id } = req.params;
        let { actionType, reason, attachment, fineData } = req.body; // actionType: 'End of Life', 'End of Services', 'Loss and Damage', or 'Leave'

        if (!['End of Life', 'End of Services', 'Loss and Damage', 'Leave'].includes(actionType)) {
            return res.status(400).json({ message: 'Invalid action type' });
        }
        const originalActionType = actionType;
        // Normalize only for the "pendingAction" field, which uses the enum 'End of Life'
        // Keep `originalActionType` so we can differentiate "End of Services" => Unassigned.
        const pendingActionType = originalActionType === 'End of Services' ? 'End of Life' : originalActionType;
        const { duration, leaveDuration } = req.body; // Duration in days for Leave action
        const leaveDaysRaw = duration ?? leaveDuration;
        const leaveDays = leaveDaysRaw != null && leaveDaysRaw !== '' ? Number(leaveDaysRaw) : null;
        if (originalActionType === 'Leave') {
            if (!Number.isInteger(leaveDays) || leaveDays < 1 || leaveDays > MAX_ASSET_LEAVE_DAYS) {
                return res.status(400).json({ message: `Leave duration must be between 1 and ${MAX_ASSET_LEAVE_DAYS} days.` });
            }
        }

        const asset = await AssetItem.findById(id).populate({
            path: 'assignedTo',
            populate: { path: 'primaryReportee' }
        }).populate('assignedCompany');

        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        if (
            (originalActionType === 'Leave' || originalActionType === 'End of Services') &&
            hasActiveParkingContext(asset)
        ) {
            return res.status(400).json({ message: ON_LEAVE_TRANSFER_BLOCKED_MESSAGE });
        }

        const isTransferAction = originalActionType === 'Leave' || originalActionType === 'End of Services';
        const isAdminUser = isJwtSystemSuperUser(req.user);
        const isAssetControllerRequester = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);
        const currentEmpId = req.user.employeeObjectId?.toString();
        const assigneeId =
            asset.assignedTo?._id?.toString?.() ||
            (typeof asset.assignedTo === 'string' ? asset.assignedTo : asset.assignedTo?.toString?.());
        const isAssigneeRequester = !!(currentEmpId && assigneeId && currentEmpId === assigneeId);

        if (isTransferAction) {
            if (!isAdminUser && !isAssetControllerRequester && !isAssigneeRequester) {
                return res.status(403).json({
                    message: 'Access denied. Only Asset Controller or the assigned user can request asset transfer (Leave / End of Services).',
                });
            }
        } else {
            const actorFlags = await getActorPermissionFlagsForAsset(req.user, asset);
            if (!actorFlags.canAct) {
                return res.status(403).json({
                    message:
                        'Access denied. Only Asset Controller/Admin, flowchart Assigned User/Admin for company assets, assigner, assigned user, or delegated primary reportee can request this asset action.',
                });
            }
        }

        // Upload attachment if present
        let fileUrl = null;
        if (attachment && attachment.startsWith('data:')) {
            const uploadResult = await uploadDocumentToS3(attachment, 'asset-history');
            fileUrl = uploadResult.publicId;
        }

        const assetController = await getDepartmentHOD('assetcontroller');

        if (!assetController) {
            return res.status(400).json({ message: 'Asset Controller not found. Cannot request approval.' });
        }

        if (pendingActionType === 'Loss and Damage') {
            const emailCheck = await assertAssetActionStakeholderEmails({ asset, assetController });
            if (!emailCheck.ok) {
                return res.status(400).json({ message: emailCheck.message });
            }
            if (fineData) {
                const isAssetControllerRequester = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);
                if (!isAssetControllerRequester) {
                    return res.status(403).json({
                        message:
                            'Only Asset Controller can submit Loss & Damage with fine details. Assigned users may submit a request without fine data.',
                    });
                }
            }
        }

        // Store pending request in asset
        asset.pendingAction = pendingActionType;
        const requestedByRole =
            isAssetControllerRequester && !isAssigneeRequester
                ? 'assetcontroller'
                : isAssigneeRequester
                    ? 'assignee'
                    : 'admin';
        asset.pendingActionDetails = {
            reason: reason,
            attachment: fileUrl,
            fineData: fineData || null,
            duration: leaveDays || null,
            leaveDuration: leaveDays || null,
            originalActionType,
            requestedBy: req.user.employeeObjectId || req.user._id,
            requestedByRole,
        };

        let nextApprover = assetController;
        if (isTransferAction) {
            if (isAssetControllerRequester && !isAssigneeRequester) {
                let ownerEmp = asset.assignedTo;
                if (ownerEmp && !ownerEmp._id && typeof ownerEmp !== 'object') {
                    ownerEmp = await EmployeeBasic.findById(ownerEmp)
                        .select('_id employeeId firstName lastName companyEmail workEmail')
                        .lean();
                } else if (ownerEmp?._id && !ownerEmp.employeeId) {
                    ownerEmp = await EmployeeBasic.findById(ownerEmp._id)
                        .select('_id employeeId firstName lastName companyEmail workEmail')
                        .lean();
                }
                if (!ownerEmp?._id) {
                    return res.status(400).json({ message: 'Asset has no assigned owner to approve this transfer.' });
                }
                nextApprover = ownerEmp;
            } else {
                nextApprover = await resolveAssetControllerEmployee(assetController);
            }
        }

        if (pendingActionType === 'End of Life') {
            if (isAssigneeRequester) {
                // Flow B (Raised by Asset Owner) -> Goes to Asset Controller HOD
                nextApprover = assetController;
                asset.pendingActionDetails = {
                    ...asset.pendingActionDetails,
                    stage: 'pending_assetcontroller',
                    raisedBy: 'assetowner'
                };
            } else {
                // Flow A (Raised by Asset Controller / Admin) -> Goes to HR HOD
                const hrHOD = await getDepartmentHOD('hr');
                if (!hrHOD?._id) {
                    return res.status(400).json({ message: 'HR HOD not found. Cannot route End of Life request.' });
                }
                nextApprover = hrHOD;
                asset.pendingActionDetails = {
                    ...asset.pendingActionDetails,
                    stage: 'pending_hr',
                    raisedBy: 'assetcontroller'
                };
            }
        }

        // actionRequiredBy references EmployeeBasic, so use EmployeeBasic._id
        asset.actionRequiredBy = nextApprover._id;
        if (
            originalActionType === 'Leave' &&
            (isLeaveActive(asset) || isServiceActive(asset))
        ) {
            // Parking and on-service assets keep their operational status while leave is pending approval.
        } else {
            asset.status = 'Pending';
        }

        await asset.save();

        // Delete any old pending/rejected actions for this request first to keep inbox clean
        await DashboardAction.deleteMany({ requestId: asset._id });

        // Create Dashboard Action
        const dashboardRequestType = pendingActionType === 'End of Life' ? 'Asset End of Life' :
            pendingActionType === 'Leave' ? 'Asset Leave' : 'Asset Loss Damage';
        await DashboardAction.create({
            assignedTo: nextApprover._id, // actionRequiredBy references EmployeeBasic
            requestId: asset._id,
            requestType: dashboardRequestType,
            status: 'Pending',
            subjectEmployeeId: asset.assignedTo?.employeeId || (asset.assignedCompany ? asset.assignedCompany.companyId : 'UNASSIGNED'),
            subjectName: asset.assignedTo ? `${asset.assignedTo.firstName} ${asset.assignedTo.lastName}` : (asset.assignedCompany ? asset.assignedCompany.name : 'Unassigned Asset'),
            requestedByName: req.user.name || 'System',
            extra1: `${asset.assetId} — ${asset.name}`,
            extra2: pendingActionType
        });

        // Create history log for the request
        await AssetHistory.create({
            assetId: asset._id,
            action: 'Comment',
            performedBy: req.user._id,
            comments: `Requested ${actionType}. Reason: ${reason}`,
            file: fileUrl,
            date: new Date(),
            details: { type: 'ActionRequest', action: actionType }
        });

        const requesterName = req.user.name || (req.user.firstName && req.user.lastName ? `${req.user.firstName} ${req.user.lastName}` : 'User');

        let requestAttachments = [];
        try {
            requestAttachments = await buildAssetActionApprovalHandoverAttachments(req, asset);
        } catch (pdfErr) {
        }

        if (pendingActionType === 'Loss and Damage') {
            await notifyLossDamageRequestStakeholders({
                asset,
                actionType: pendingActionType,
                approver: nextApprover,
                requesterName,
                reason,
                attachments: requestAttachments,
            });
        } else {
            await sendAssetActionApprovalEmail(
                asset,
                pendingActionType,
                nextApprover,
                { name: requesterName },
                reason,
                requestAttachments,
            );
        }

        if (isTransferAction) {
            await notifyLeaveEosOwnerHod({
                asset,
                actionType: pendingActionType,
                requesterName,
                phase: 'requested',
                reason,
                attachments: requestAttachments,
            });
        }

        let approverLabel =
            isTransferAction && isAssetControllerRequester && !isAssigneeRequester
                ? 'asset owner'
                : 'Asset Controller';
        if (pendingActionType === 'End of Life') {
            if (isAssigneeRequester) {
                approverLabel = 'Asset Controller';
            } else {
                approverLabel = 'HR';
            }
        }

        res.status(200).json({
            message: `${pendingActionType} request sent to ${approverLabel} for approval`,
            asset,
        });
    } catch (error) {
        // Return the real message to help frontend/debug quickly (avoids generic 500).
        // (In production you can later hide details behind NODE_ENV if you prefer.)
        const msg = error?.message || 'Internal server error';
        res.status(500).json({ message: msg });
    }
};

// @desc    Bulk Request Asset Action (End of Life, Loss & Damage, or Leave)
// @route   PUT /api/AssetItem/bulk/request-action
// @access  Private
export const bulkRequestAssetAction = async (req, res) => {
    try {
        let { assetIds, actionType, reason, duration, leaveDuration } = req.body;

        if (!Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ message: 'Please provide at least one asset ID' });
        }

        if (!['End of Life', 'End of Services', 'Loss and Damage', 'Leave'].includes(actionType)) {
            return res.status(400).json({ message: 'Invalid action type' });
        }
        const originalActionType = actionType;
        if (actionType === 'End of Services') actionType = 'End of Life'; // Normalize for backend processing (pendingAction enum)
        const leaveDaysRaw = duration ?? leaveDuration;
        const leaveDays = leaveDaysRaw != null && leaveDaysRaw !== '' ? Number(leaveDaysRaw) : null;
        if (originalActionType === 'Leave') {
            if (!Number.isInteger(leaveDays) || leaveDays < 1 || leaveDays > MAX_ASSET_LEAVE_DAYS) {
                return res.status(400).json({ message: `Leave duration must be between 1 and ${MAX_ASSET_LEAVE_DAYS} days.` });
            }
        }

        const assets = await AssetItem.find({ _id: { $in: assetIds } }).populate({
            path: 'assignedTo',
            populate: { path: 'primaryReportee' }
        }).populate('assignedCompany');

        if (assets.length !== assetIds.length) {
            return res.status(404).json({ message: 'One or more assets not found' });
        }

        const assetController = await getDepartmentHOD('assetcontroller');
        if (!assetController) {
            return res.status(400).json({ message: 'Asset Controller not found. Cannot request approval.' });
        }
        if (!assetController._id) {
            return res.status(400).json({ message: 'Asset Controller is not properly linked to an employee record. Please update Settings > Flowchart.' });
        }

        const isTransferBulk = originalActionType === 'Leave' || originalActionType === 'End of Services';
        const isAdminUser = isJwtSystemSuperUser(req.user);
        const isAssetControllerRequester = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);
        const currentEmpId = req.user.employeeObjectId?.toString();
        const allCompanyAssigned = assets.every(
            (a) => a.assignedToType === 'Company' && a.assignedCompany,
        );
        const isCompanyCoordinatorRequester = await isUserActiveCompanyAssetCoordinator(
            req.user.employeeObjectId,
            req.user.employeeId,
        ).catch(() => false);
        const primaryAssigneeId =
            assets[0]?.assignedTo?._id?.toString?.() ||
            (typeof assets[0]?.assignedTo === 'string' ? assets[0].assignedTo : assets[0]?.assignedTo?.toString?.());
        const isAssigneeRequester = !!(currentEmpId && primaryAssigneeId && currentEmpId === primaryAssigneeId);

        if (isTransferBulk) {
            if (
                !isAdminUser &&
                !isAssetControllerRequester &&
                !isAssigneeRequester &&
                !(allCompanyAssigned && isCompanyCoordinatorRequester)
            ) {
                return res.status(403).json({
                    message: 'Access denied. Only Asset Controller or the assigned user can request bulk asset transfer.',
                });
            }
        }

        const resolvedAssetController = await resolveAssetControllerEmployee(assetController);
        let bulkTransferApprover = resolvedAssetController;
        if (isTransferBulk && allCompanyAssigned && isCompanyCoordinatorRequester) {
            bulkTransferApprover = resolvedAssetController;
        } else if (isTransferBulk && isAssetControllerRequester && allCompanyAssigned) {
            const coordRaw = await getCompanyAssetCoordinator();
            const coord = coordRaw ? await resolveAssetControllerEmployee(coordRaw) : null;
            if (!coord?._id) {
                return res.status(400).json({
                    message:
                        'No Assigned User or Admin in Flowchart. Company asset transfers require that role to approve.',
                });
            }
            bulkTransferApprover = coord;
        } else if (isTransferBulk && isAssetControllerRequester && !isAssigneeRequester && !allCompanyAssigned) {
            let ownerEmp = assets[0]?.assignedTo;
            if (ownerEmp?._id && !ownerEmp.employeeId) {
                ownerEmp = await EmployeeBasic.findById(ownerEmp._id)
                    .select('_id employeeId firstName lastName companyEmail workEmail')
                    .lean();
            }
            if (!ownerEmp?._id) {
                return res.status(400).json({ message: 'Bulk transfer requires an assigned asset owner for approval.' });
            }
            bulkTransferApprover = ownerEmp;
        }

        let companyCoordinator = null;
        if (actionType === 'Loss and Damage') {
            const hasCompanyAsset = assets.some((a) => a.assignedToType === 'Company' && a.assignedCompany);
            if (hasCompanyAsset) {
                companyCoordinator = await getCompanyAssetCoordinator();
                if (!companyCoordinator?._id) {
                    return res.status(400).json({
                        message:
                            'No Assigned User or Admin in Flowchart. Bulk loss/damage for company-assigned assets requires one of those roles.'
                    });
                }
            }
        }

        // Upload attachment if present (for bulk, we'll use the same attachment for all)
        let fileUrl = null;
        // Note: For bulk, attachment would need to be handled per asset if different

        const pdfIds = assetIds.map((id) => id.toString());
        let bulkActionAttachments = [];
        const requireHandoverPdf = pdfIds.length > 1 || actionType === 'Loss and Damage';
        try {
            bulkActionAttachments = await buildAssetActionApprovalHandoverAttachments(req, assets);
        } catch (pdfErr) {
            if (requireHandoverPdf) {
                return res.status(503).json({
                    message:
                        pdfErr?.message ||
                        'Could not generate the Asset Handover Form PDF. Request was not submitted.',
                });
            }
        }

        const results = [];
        const errors = [];
        const bulkAssetIds = [];
        let primaryApprover = null; // For single dashboard action

        const requestedByRole =
            allCompanyAssigned && isCompanyCoordinatorRequester
                ? 'companycoordinator'
                : isAssetControllerRequester && !isAssigneeRequester
                    ? 'assetcontroller'
                    : isAssigneeRequester
                        ? 'assignee'
                        : 'admin';

        for (const asset of assets) {
            try {
                if (isTransferBulk && hasActiveParkingContext(asset)) {
                    errors.push({ assetId: asset.assetId, message: ON_LEAVE_TRANSFER_BLOCKED_MESSAGE });
                    continue;
                }

                let nextApprover;
                if (actionType === 'Loss and Damage' && asset.assignedToType === 'Company' && asset.assignedCompany) {
                    nextApprover = companyCoordinator;
                } else if (isTransferBulk) {
                    nextApprover = bulkTransferApprover;
                } else {
                    nextApprover = resolvedAssetController;
                }
                if (!primaryApprover) primaryApprover = nextApprover;

                asset.pendingAction = actionType;
                const leaveDur = leaveDays;
                asset.pendingActionDetails = {
                    reason: reason,
                    attachment: fileUrl,
                    isBulk: true,
                    bulkAssetIds: assetIds,
                    fineData: null,
                    duration: leaveDur || null,
                    leaveDuration: leaveDur || null,
                    originalActionType,
                    requestedBy: req.user.employeeObjectId || req.user._id,
                    requestedByRole,
                };

                // actionRequiredBy references EmployeeBasic, so use EmployeeBasic._id
                asset.actionRequiredBy = nextApprover._id;
                asset.status = 'Pending';

                await asset.save();

                // NOTE: Do NOT create Dashboard Action per asset - we create ONE grouped action after the loop

                // Create history log for the request
                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Comment',
                    performedBy: req.user._id,
                    comments: `Bulk ${actionType} request submitted. Reason: ${reason || 'N/A'}`,
                    file: fileUrl,
                    date: new Date(),
                    details: { type: 'BulkActionRequest', action: actionType, bulkAssetIds: assetIds.map(id => id.toString()) }
                });

                bulkAssetIds.push(asset._id.toString());
                results.push({ assetId: asset._id, assetIdDisplay: asset.assetId, status: 'success', message: `${actionType} request submitted for approval` });
            } catch (error) {
                errors.push({ assetId: asset.assetId, message: error.message || 'Failed to process' });
            }
        }

        // Create ONE Dashboard Action for bulk (grouped) - asset controller sees single item
        if (results.length > 0 && assets.length > 0 && primaryApprover?._id) {
            const primaryAsset = assets[0];
            const dashboardRequestType = actionType === 'End of Life' ? 'Asset End of Life' :
                actionType === 'Leave' ? 'Asset Leave' : 'Asset Loss Damage';
            const assetSummary = assets.map(a => `${a.assetId} — ${a.name}`).join('; ');
            const extra1 = assets.length > 1
                ? `Bulk ${actionType} (${assets.length} assets): ${assetSummary.substring(0, 200)}${assetSummary.length > 200 ? '...' : ''}`
                : `${primaryAsset.assetId} — ${primaryAsset.name}`;
            if (assets.length > 1) {
                await supersedeOverlappingPendingBulkActionRows(
                    assetIds.map((id) => id.toString()),
                    dashboardRequestType,
                    req.user.employeeObjectId,
                );
            }
            await DashboardAction.create({
                assignedTo: primaryApprover._id,
                assignedToEmpId: primaryApprover.employeeId || null,
                requestId: primaryAsset._id, // Link to primary asset for approval flow
                requestType: dashboardRequestType,
                status: 'Pending',
                subjectEmployeeId: primaryAsset.assignedTo?.employeeId || (primaryAsset.assignedCompany ? primaryAsset.assignedCompany.companyId : 'UNASSIGNED'),
                subjectName: primaryAsset.assignedTo ? `${primaryAsset.assignedTo.firstName} ${primaryAsset.assignedTo.lastName}` : (primaryAsset.assignedCompany ? primaryAsset.assignedCompany.name : 'Unassigned Asset'),
                requestedByName: req.user.name || 'System',
                extra1,
                extra2: actionType,
                extra3: assets.length > 1 ? JSON.stringify({ isBulk: true, totalAssets: assets.length, assetIds: assetIds.map(id => id.toString()) }) : null
            });
        }

        // Send email notification to the same approver role as per-asset routing (must not use company coordinator for Leave/EOL).
        if (results.length > 0 && assets.length > 0) {
            const requesterName = req.user.name || (req.user.firstName && req.user.lastName ? `${req.user.firstName} ${req.user.lastName}` : 'User');
            const primaryAsset = assets[0];
            const approver =
                actionType === 'Loss and Damage' &&
                    primaryAsset.assignedToType === 'Company' &&
                    primaryAsset.assignedCompany &&
                    companyCoordinator?._id
                    ? companyCoordinator
                    : isTransferBulk
                        ? bulkTransferApprover
                        : resolvedAssetController;

            try {
                await sendAssetActionApprovalEmail(
                    { ...primaryAsset.toObject(), assetId: primaryAsset.assetId, name: `Bulk ${actionType} Request (${assets.length} assets)` },
                    actionType,
                    approver,
                    { name: requesterName },
                    `Bulk ${actionType} request for ${assets.length} asset(s). Reason: ${reason || 'N/A'}`,
                    bulkActionAttachments
                );
                if (isTransferBulk) {
                    await notifyLeaveEosOwnerHod({
                        asset: primaryAsset,
                        actionType,
                        requesterName,
                        phase: 'requested',
                        reason: reason || '',
                        attachments: bulkActionAttachments,
                    });
                }
            } catch (emailErr) {
            }
        }

        const successCount = results.length;
        const errorCount = errors.length;

        if (successCount === 0) {
            return res.status(400).json({
                message: errors[0]?.message || `No assets could be processed for ${actionType}.`,
                results,
                errors,
            });
        }

        const approverLabel =
            isTransferBulk && isAssetControllerRequester && !isAssigneeRequester
                ? 'asset owner'
                : 'Asset Controller';

        res.status(200).json({
            message: `${actionType} request submitted for ${successCount} asset(s)${errorCount > 0 ? `, ${errorCount} failed` : ''}. Awaiting ${approverLabel} approval.`,
            results,
            errors: errorCount > 0 ? errors : undefined,
            bulkAssetIds: bulkAssetIds
        });
    } catch (error) {
        const msg = process.env.NODE_ENV === 'development' ? (error.message || 'Internal server error') : 'Internal server error';
        res.status(500).json({ message: msg });
    }
};

const assetActionApprovalPopulate = () => ({
    path: 'assignedTo',
    populate: [{ path: 'primaryReportee' }, { path: 'company' }],
});

/** Bulk leave/EOL/return: URL asset may already be processed while siblings are still pending. */
const findBulkPeerWithPendingAction = async (assetMongoId) => {
    if (!assetMongoId) return null;
    return AssetItem.findOne({
        pendingAction: { $in: ['Return Asset', 'Leave', 'End of Life', 'Loss and Damage'] },
        'pendingActionDetails.isBulk': true,
        'pendingActionDetails.bulkAssetIds': assetMongoId,
    })
        .populate(assetActionApprovalPopulate())
        .populate('assignedCompany');
};

// @desc    Handle Asset Action Approval/Rejection
export const handleAssetActionApproval = async (req, res) => {
    try {
        const { id } = req.params;
        const { approve, comment, fineData, bulkAssetIdsToProcess, bulkDisposition } = req.body; // bulkDisposition: optional { [assetId]: 'leave'|'eos'|'return'|'reject' } for per-row AC decisions

        let asset = await AssetItem.findById(id)
            .populate(assetActionApprovalPopulate())
            .populate('assignedCompany');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (!asset.pendingAction) {
            const bulkPeer = await findBulkPeerWithPendingAction(asset._id);
            if (bulkPeer) asset = bulkPeer;
        }
        if (!asset.pendingAction) return res.status(400).json({ message: 'No pending action' });

        const actionType = asset.pendingAction;

        if (actionType === 'Reassign Asset') {
            const currentUserEmpId = req.user.employeeObjectId?.toString();
            const isAdminUser = isJwtSystemSuperUser(req.user);
            const isDesignatedApprover = asset.actionRequiredBy?.toString() === currentUserEmpId;
            const isHrApprover = await isUserInFlowchart(req.user, 'hr').catch(() => false);
            const isAuthorizedReassign = isDesignatedApprover || isAdminUser || isHrApprover;

            if (!isAuthorizedReassign) {
                return res.status(403).json({ message: 'Only HR can approve or reject this reassign request.' });
            }

            if (!approve) {
                asset.pendingAction = null;
                asset.pendingActionDetails = null;
                asset.actionRequiredBy = null;
                asset.status = 'Assigned';
                await asset.save();

                await DashboardAction.findOneAndUpdate(
                    { requestId: asset._id, requestType: 'Asset Reassign', status: 'Pending' },
                    {
                        status: 'Rejected',
                        actionedDate: new Date(),
                        actionedBy: req.user?.employeeObjectId || req.user?._id,
                        comment: String(comment || '').trim(),
                    },
                );

                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Comment',
                    performedBy: req.user.employeeObjectId || req.user._id,
                    comments: `HR rejected fleet vehicle reassign request. ${comment || ''}`.trim(),
                    date: new Date(),
                });

                return res.status(200).json({ message: 'Reassign request rejected.', asset });
            }

            const payload = asset.pendingActionDetails?.reassignmentPayload;
            if (!payload?.assignedTo) {
                return res.status(400).json({ message: 'Reassign details are missing from the pending request.' });
            }

            const hrApprover = await EmployeeBasic.findById(req.user.employeeObjectId).select('signature');
            if (!hrApprover?.signature?.url) {
                return res.status(403).json({
                    message: 'HR signature is required before approving a vehicle reassignment.',
                });
            }

            const employeeToAssign = await EmployeeBasic.findById(payload.assignedTo)
                .select(
                    'employeeId firstName lastName companyEmail workEmail personalEmail email primaryReportee department signature enablePortalAccess',
                )
                .populate({
                    path: 'primaryReportee',
                    select: '_id firstName lastName employeeId companyEmail workEmail',
                });
            if (!employeeToAssign) {
                return res.status(404).json({ message: 'Target employee for reassignment not found' });
            }

            const previousAssignee = asset.assignedTo;
            const resolvedActors = await resolveEmployeeAssignmentActors(
                employeeToAssign,
                req.user.employeeObjectId,
            );

            asset.pendingAction = null;
            asset.pendingActionDetails = null;
            asset.assignedToType = 'Employee';
            asset.assignedTo = employeeToAssign._id;
            asset.assignedCompany = null;
            asset.assignedBy = req.user.employeeObjectId;
            asset.assignmentType = payload.assignmentType || 'Permanent';
            if (payload.assignmentType === 'Temporary') {
                const parsedDays = Number(payload.assignedDays);
                if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 60) {
                    return res.status(400).json({ message: 'Temporary duration must be an integer between 1 and 60 days.' });
                }
                asset.assignedDays = parsedDays;
            } else {
                asset.assignedDays = null;
            }

            let actionRequiredBy = null;
            if (resolvedActors.autoAcceptOnAssign) {
                if (!employeeToAssign.signature?.url) {
                    return res.status(403).json({
                        message:
                            'Cannot reassign: The employee must have a digital signature on their profile before direct assignment.',
                    });
                }
                applyAcceptedAssignmentState(asset, employeeToAssign._id);
            } else {
                asset.acceptanceStatus = 'Pending';
                asset.actionRequiredBy = resolvedActors.pendingActionActorId;
                asset.status = 'Pending';
                actionRequiredBy = resolvedActors.pendingActionActorId;
            }
            asset.negotiationHistory = [];
            await asset.save();

            if (actionRequiredBy) {
                const subjectName = `${employeeToAssign.firstName || ''} ${employeeToAssign.lastName || ''}`.trim();
                await DashboardAction.findOneAndUpdate(
                    { requestId: asset._id, requestType: 'Asset Assignment', status: 'Pending' },
                    {
                        assignedTo: actionRequiredBy,
                        assignedToEmpId: employeeToAssign.employeeId,
                        requestId: asset._id,
                        requestType: 'Asset Assignment',
                        subjectEmployeeId: employeeToAssign.employeeId,
                        subjectName,
                        requestedByName: 'HR',
                        extra1: `${asset.assetId} — ${asset.name}`,
                        extra2: asset.assignmentType,
                        status: 'Pending',
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true },
                );
            }

            await AssetHistory.create({
                assetId: asset._id,
                action: 'Assigned',
                assignedTo: employeeToAssign._id,
                assignedToType: 'Employee',
                performedBy: req.user.employeeObjectId,
                comments: 'HR approved fleet vehicle reassign request.',
                date: new Date(),
            });

            if (previousAssignee) {
                try {
                    await sendAssetReassignmentEmail({
                        asset,
                        previousAssignee,
                        newAssignee: employeeToAssign,
                        previousAssigneeType: 'Employee',
                        newAssigneeType: 'Employee',
                        attachments: [],
                    });
                } catch (e) {
                    /* non-fatal */
                }
            }

            await DashboardAction.findOneAndUpdate(
                { requestId: asset._id, requestType: 'Asset Reassign', status: 'Pending' },
                {
                    status: 'Approved',
                    actionedDate: new Date(),
                    actionedBy: req.user?.employeeObjectId || req.user?._id,
                },
            );

            const refreshed = await AssetItem.findById(asset._id).populate(assetActionApprovalPopulate());
            return res.status(200).json({
                message: 'Reassignment approved. Awaiting assignee acknowledgment.',
                asset: refreshed || asset,
            });
        }

        if (actionType === 'End of Life' && asset.pendingActionDetails?.stage) {
            const stage = asset.pendingActionDetails.stage;
            const raisedBy = asset.pendingActionDetails.raisedBy;
            const isAdmin = isJwtSystemSuperUser(req.user);

            let isUserAuthorizedForStage = false;
            if (isAdmin) {
                isUserAuthorizedForStage = true;
            } else if (stage === 'pending_hr') {
                isUserAuthorizedForStage = await isUserInFlowchart(req.user, 'hr').catch(() => false);
            } else if (stage === 'pending_management') {
                isUserAuthorizedForStage = await isUserInFlowchart(req.user, 'management').catch(() => false);
            } else if (stage === 'pending_assetcontroller') {
                isUserAuthorizedForStage = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);
            }

            if (!isUserAuthorizedForStage) {
                return res.status(403).json({ message: 'Access denied. You are not authorized to act at this stage of the End of Life workflow.' });
            }

            const hrHOD = await getDepartmentHOD('hr');
            const managementHOD = await getDepartmentHOD('management');
            const assetControllerHOD = await getDepartmentHOD('assetcontroller');

            let requestedByEmp = null;
            if (asset.pendingActionDetails.requestedBy) {
                requestedByEmp = await EmployeeBasic.findById(asset.pendingActionDetails.requestedBy)
                    .select('_id employeeId firstName lastName companyEmail workEmail')
                    .lean();
            }

            const requesterName = requestedByEmp
                ? `${requestedByEmp.firstName} ${requestedByEmp.lastName}`
                : 'Asset Owner';

            const assetOwnerEmp = asset.assignedTo;

            if (approve) {
                if (stage === 'pending_assetcontroller' && raisedBy === 'assetowner') {
                    if (!hrHOD?._id) {
                        return res.status(400).json({ message: 'HR HOD not found. Cannot route to next stage.' });
                    }
                    asset.actionRequiredBy = hrHOD._id;
                    asset.pendingActionDetails.stage = 'pending_hr';
                    asset.markModified('pendingActionDetails');
                    await asset.save();

                    await DashboardAction.deleteMany({ requestId: asset._id });

                    await DashboardAction.create({
                        assignedTo: hrHOD._id,
                        requestId: asset._id,
                        requestType: 'Asset End of Life',
                        status: 'Pending',
                        subjectEmployeeId: assetOwnerEmp?.employeeId || 'UNASSIGNED',
                        subjectName: assetOwnerEmp ? `${assetOwnerEmp.firstName} ${assetOwnerEmp.lastName}` : 'Unassigned Asset',
                        requestedByName: requesterName,
                        extra1: `${asset.assetId} — ${asset.name}`,
                        extra2: 'End of Life'
                    });

                    await sendEolEmail({
                        toEmployee: hrHOD,
                        ccEmployees: [assetControllerHOD, assetOwnerEmp],
                        subject: `End of Life Approval Required: ${asset.assetId}`,
                        bodyHtml: `
                            <p>Dear ${hrHOD.firstName},</p>
                            <p>Asset Controller has approved the End of Life request for Asset <strong>${asset.assetId} - ${asset.name}</strong>. Your approval is now required.</p>
                            <p><strong>Reason:</strong> ${asset.pendingActionDetails.reason || 'N/A'}</p>
                            <p><strong>Previous Comment:</strong> ${comment || 'N/A'}</p>
                            <p><a href="${frontendBaseUrl()}/HRM/Asset/details/${asset._id}?authAction=eol" style="background-color: #2563eb; color: #fff; padding: 10px 20px; text-decoration: none; border-radius: 4px; font-weight: bold; display: inline-block; margin-top: 15px;">Review & Approve</a></p>
                        `
                    });

                    await AssetHistory.create({
                        assetId: asset._id,
                        action: 'Comment',
                        performedBy: req.user.employeeObjectId || req.user._id,
                        comments: `Asset Controller approved End of Life. Routed to HR HOD. Comment: ${comment || 'N/A'}`,
                        date: new Date()
                    });

                    return res.status(200).json({
                        message: 'End of Life request approved by Asset Controller. Routed to HR HOD.',
                        asset
                    });

                } else if (stage === 'pending_hr') {
                    if (!managementHOD?._id) {
                        return res.status(400).json({ message: 'Management HOD not found. Cannot route to next stage.' });
                    }
                    asset.actionRequiredBy = managementHOD._id;
                    asset.pendingActionDetails.stage = 'pending_management';
                    asset.markModified('pendingActionDetails');
                    await asset.save();

                    await DashboardAction.deleteMany({ requestId: asset._id });

                    await DashboardAction.create({
                        assignedTo: managementHOD._id,
                        requestId: asset._id,
                        requestType: 'Asset End of Life',
                        status: 'Pending',
                        subjectEmployeeId: assetOwnerEmp?.employeeId || 'UNASSIGNED',
                        subjectName: assetOwnerEmp ? `${assetOwnerEmp.firstName} ${assetOwnerEmp.lastName}` : 'Unassigned Asset',
                        requestedByName: requesterName,
                        extra1: `${asset.assetId} — ${asset.name}`,
                        extra2: 'End of Life'
                    });

                    await sendEolEmail({
                        toEmployee: managementHOD,
                        ccEmployees: [hrHOD, assetControllerHOD, assetOwnerEmp],
                        subject: `End of Life Approval Required: ${asset.assetId}`,
                        bodyHtml: `
                            <p>Dear ${managementHOD.firstName},</p>
                            <p>HR has approved the End of Life request for Asset <strong>${asset.assetId} - ${asset.name}</strong>. Your final approval is now required.</p>
                            <p><strong>Reason:</strong> ${asset.pendingActionDetails.reason || 'N/A'}</p>
                            <p><strong>Previous Comment:</strong> ${comment || 'N/A'}</p>
                            <p><a href="${frontendBaseUrl()}/HRM/Asset/details/${asset._id}?authAction=eol" style="background-color: #2563eb; color: #fff; padding: 10px 20px; text-decoration: none; border-radius: 4px; font-weight: bold; display: inline-block; margin-top: 15px;">Review & Approve</a></p>
                        `
                    });

                    await AssetHistory.create({
                        assetId: asset._id,
                        action: 'Comment',
                        performedBy: req.user.employeeObjectId || req.user._id,
                        comments: `HR approved End of Life. Routed to Management. Comment: ${comment || 'N/A'}`,
                        date: new Date()
                    });

                    return res.status(200).json({
                        message: 'End of Life request approved by HR. Routed to Management HOD.',
                        asset
                    });

                } else if (stage === 'pending_management') {
                    const finalStatus = 'End of Life';

                    asset.status = finalStatus;
                    if (!asset.lostAt) asset.lostAt = new Date();
                    asset.assignedTo = null;
                    asset.assignedCompany = null;
                    asset.assignedToType = null;
                    asset.assignmentType = null;
                    asset.assignedDate = null;
                    asset.pendingAction = null;
                    asset.pendingActionDetails = null;
                    asset.actionRequiredBy = null;
                    await asset.save();

                    await DashboardAction.deleteMany({ requestId: asset._id });

                    const ccList = [hrHOD, assetControllerHOD];
                    if (assetOwnerEmp) ccList.push(assetOwnerEmp);

                    await sendEolEmail({
                        toEmployee: assetControllerHOD,
                        ccEmployees: ccList.filter(e => e?._id?.toString() !== assetControllerHOD?._id?.toString()),
                        subject: `End of Life Request Approved: ${asset.assetId}`,
                        bodyHtml: `
                            <p>Dear Team,</p>
                            <p>Management has approved the End of Life request for Asset <strong>${asset.assetId} - ${asset.name}</strong>.</p>
                            <p>The asset status is now set to: <strong>${finalStatus === 'Lost' ? 'Loss and damage' : 'End of Life'}</strong>.</p>
                            <p><strong>Approved By Management Comment:</strong> ${comment || 'N/A'}</p>
                        `
                    });

                    await AssetHistory.create({
                        assetId: asset._id,
                        action: finalStatus === 'Lost' ? 'Lost' : 'End of Life',
                        performedBy: req.user.employeeObjectId || req.user._id,
                        comments: `Management approved End of Life. Status changed to ${finalStatus === 'Lost' ? 'Loss and damage' : 'End of Life'}. Comment: ${comment || 'N/A'}`,
                        date: new Date()
                    });

                    return res.status(200).json({
                        message: `End of Life request finalized. Asset status is now ${finalStatus === 'Lost' ? 'Loss and damage' : 'End of Life'}.`,
                        asset
                    });
                }
            } else {
                let taskTargetEmployeeId = null;
                let emailTo = null;
                let emailCc = [];
                let rejectionBy = '';

                if (stage === 'pending_assetcontroller') {
                    rejectionBy = 'Asset Controller';
                } else if (stage === 'pending_hr') {
                    rejectionBy = 'HR';
                } else if (stage === 'pending_management') {
                    rejectionBy = 'Management';
                }

                if (raisedBy === 'assetcontroller') {
                    if (stage === 'pending_hr') {
                        taskTargetEmployeeId = assetControllerHOD?._id;
                        emailTo = assetControllerHOD;
                    } else if (stage === 'pending_management') {
                        taskTargetEmployeeId = assetControllerHOD?._id;
                        emailTo = assetControllerHOD;
                        if (hrHOD) emailCc.push(hrHOD);
                    }
                } else {
                    if (stage === 'pending_assetcontroller') {
                        taskTargetEmployeeId = assetOwnerEmp?._id;
                        emailTo = assetOwnerEmp;
                    } else if (stage === 'pending_hr') {
                        taskTargetEmployeeId = assetOwnerEmp?._id;
                        emailTo = assetOwnerEmp;
                        if (assetControllerHOD) emailCc.push(assetControllerHOD);
                    } else if (stage === 'pending_management') {
                        taskTargetEmployeeId = assetOwnerEmp?._id;
                        emailTo = assetOwnerEmp;
                        if (hrHOD) emailCc.push(hrHOD);
                        if (assetControllerHOD) emailCc.push(assetControllerHOD);
                    }
                }

                asset.status = asset.assignedTo ? 'Assigned' : 'Unassigned';
                asset.pendingAction = null;
                asset.pendingActionDetails = null;
                asset.actionRequiredBy = null;
                await asset.save();

                await DashboardAction.deleteMany({ requestId: asset._id });

                if (taskTargetEmployeeId) {
                    await DashboardAction.create({
                        assignedTo: taskTargetEmployeeId,
                        requestId: asset._id,
                        requestType: 'Asset End of Life',
                        status: 'Pending',
                        subjectEmployeeId: assetOwnerEmp?.employeeId || 'UNASSIGNED',
                        subjectName: assetOwnerEmp ? `${assetOwnerEmp.firstName} ${assetOwnerEmp.lastName}` : 'Unassigned Asset',
                        requestedByName: requesterName,
                        extra1: `REJECTED: End of Life request for ${asset.assetId} — ${asset.name}. Reason: ${comment || 'N/A'}`,
                        extra2: 'End of Life',
                        extra3: JSON.stringify({ isRejectionNotification: true })
                    });
                }

                if (emailTo) {
                    await sendEolEmail({
                        toEmployee: emailTo,
                        ccEmployees: emailCc,
                        subject: `End of Life Request REJECTED: ${asset.assetId}`,
                        bodyHtml: `
                            <p>Dear Team,</p>
                            <p>The End of Life request for Asset <strong>${asset.assetId} - ${asset.name}</strong> was rejected by <strong>${rejectionBy}</strong>.</p>
                            <p><strong>Rejection Comment/Reason:</strong> ${comment || 'No reason provided'}</p>
                            <p>The asset status has reverted to: <strong>${asset.status}</strong>.</p>
                        `
                    });
                }

                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Comment',
                    performedBy: req.user.employeeObjectId || req.user._id,
                    comments: `End of Life request rejected by ${rejectionBy}. Status reverted to ${asset.status}. Reason: ${comment || 'N/A'}`,
                    date: new Date()
                });

                return res.status(200).json({
                    message: `End of Life request rejected by ${rejectionBy}. Notifications sent.`,
                    asset
                });
            }
        }

        // AUTH CHECK - actionRequiredBy references EmployeeBasic, so compare with employeeObjectId
        const currentUserEmpId = req.user.employeeObjectId?.toString();
        const isAdmin = isJwtSystemSuperUser(req.user);
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        const isHR = await isUserInFlowchart(req.user, 'hr');
        const isCompanyCoordinatorUser = await isUserCompanyAssetCoordinator(req.user);
        const isCompanyAsset = asset.assignedToType === 'Company' && (asset.assignedCompany?._id || asset.assignedCompany);


        const companyCoordEmp = await getCompanyAssetCoordinator();
        const isActionRequiredByCompanyCoordinator =
            companyCoordEmp?._id && asset.actionRequiredBy?.toString() === companyCoordEmp._id?.toString();

        const isTransferLeaveEos =
            actionType === 'Leave' ||
            (actionType === 'End of Life' && asset.pendingActionDetails?.originalActionType === 'End of Services');
        const isDesignatedApprover = asset.actionRequiredBy?.toString() === currentUserEmpId;

        const isAuthorized = isTransferLeaveEos
            ? isDesignatedApprover || isAdmin
            : asset.actionRequiredBy?.toString() === currentUserEmpId
            || isAdmin
            || isAssetController
            || (actionType === 'Loss and Damage' && isHR && !isCompanyAsset)
            || (actionType === 'Loss and Damage' && isCompanyAsset && isCompanyCoordinatorUser);

        const transferRequestMeta = isTransferLeaveEos
            ? {
                requestedBy: asset.pendingActionDetails?.requestedBy,
                requestedByRole: asset.pendingActionDetails?.requestedByRole,
                originalActionType: asset.pendingActionDetails?.originalActionType,
            }
            : null;

        const emailTransferRequester = async (approved, reasonText = '') => {
            if (!transferRequestMeta?.requestedBy) return;
            try {
                const requester = await EmployeeBasic.findById(transferRequestMeta.requestedBy)
                    .select('firstName lastName employeeId companyEmail workEmail')
                    .lean();
                const approver = await EmployeeBasic.findById(req.user.employeeObjectId)
                    .select('firstName lastName employeeId companyEmail workEmail')
                    .lean();
                if (!requester?._id || !approver?._id) return;
                if (requester._id.toString() !== approver._id.toString()) {
                    await sendAssetTransferDecisionEmail({
                        asset: {
                            _id: asset._id,
                            assetId: asset.assetId,
                            name: asset.name,
                            pendingActionDetails: transferRequestMeta,
                        },
                        actionType,
                        recipient: requester,
                        approver,
                        approved,
                        reason: reasonText,
                    });
                }
                const requesterName =
                    `${requester.firstName || ''} ${requester.lastName || ''}`.trim() ||
                    requester.employeeId ||
                    'User';
                await notifyLeaveEosOwnerHod({
                    asset: {
                        _id: asset._id,
                        assetId: asset.assetId,
                        name: asset.name,
                        assignedTo: asset.assignedTo,
                        assignedToType: asset.assignedToType,
                        pendingActionDetails: transferRequestMeta,
                    },
                    actionType,
                    requesterName,
                    phase: approved ? 'approved' : 'rejected',
                    approver,
                    approved,
                    reason: reasonText,
                });
            } catch (mailErr) {
            }
        };

        const emailLossDamageRequester = async (approved, reasonText = '') => {
            if (actionType !== 'Loss and Damage') return;
            const requestedBy = asset.pendingActionDetails?.requestedBy;
            if (!requestedBy) return;
            try {
                const requester = await EmployeeBasic.findById(requestedBy)
                    .select('firstName lastName employeeId companyEmail workEmail primaryReportee')
                    .populate('primaryReportee', 'firstName lastName companyEmail workEmail')
                    .lean();
                const approver = await EmployeeBasic.findById(req.user.employeeObjectId)
                    .select('firstName lastName employeeId companyEmail workEmail')
                    .lean();
                if (!requester?._id || !approver?._id) return;
                await notifyLossDamageDecisionToRequester({
                    asset,
                    requestedBy: requester,
                    approver,
                    approved,
                    reason: reasonText,
                });
            } catch (mailErr) {
            }
        };


        if (!isAuthorized) {
            if (isCompanyAsset && actionType === 'Loss and Damage') {
                return res.status(403).json({
                    message:
                        'Access denied. Only the flowchart Assigned User/Admin, Asset Controller, or Admin can approve loss and damage for company-assigned assets.'
                });
            }
            return res.status(403).json({
                message: isTransferLeaveEos
                    ? 'Access denied. Only the designated approver or Admin can approve or reject this transfer request.'
                    : 'Access denied. Only Asset Controller, Admin, or the assigned user can perform this operation.',
            });
        }

        if (approve) {
            const isAssetControllerApprowing = await isUserInFlowchart(req.user, 'assetcontroller');

            // Handle "Leave" and "End of Life" and "Return Asset" — designated approver (AC or asset owner)
            if (
                (actionType === 'Leave' || actionType === 'End of Life' || actionType === 'Return Asset') &&
                (isDesignatedApprover || isAdmin)
            ) {
                const approverEmp = await EmployeeBasic.findById(req.user.employeeObjectId).select(
                    'firstName lastName companyEmail workEmail signature employeeId department',
                );
                const assetControllerEmp = isAssetControllerApprowing
                    ? approverEmp
                    : await resolveAssetControllerEmployee(await getDepartmentHOD('assetcontroller'));

                // Check if this is a bulk transfer
                const isBulkTransfer = asset.pendingActionDetails?.isBulk === true;
                const bulkAssetIds = asset.pendingActionDetails?.bulkAssetIds || [];
                const allBulkIdStrs = (isBulkTransfer ? bulkAssetIds : []).map(String).filter(Boolean);
                const bulkDispositionMap =
                    bulkDisposition && typeof bulkDisposition === 'object' && !Array.isArray(bulkDisposition)
                        ? bulkDisposition
                        : null;

                const normalizeBulkDisposition = (raw, pendingKind) => {
                    const v = String(raw ?? '').toLowerCase().trim();
                    if (['reject', 'rejected', 'no', 'deny', 'denied'].includes(v)) return 'reject';
                    if (pendingKind === 'Return Asset') return v === 'reject' ? 'reject' : 'return';
                    if (['leave', 'onleave', 'on_leave', 'parking'].includes(v)) return 'leave';
                    if (['eos', 'endofservices', 'end_of_services', 'store', 'return_to_store'].includes(v)) return 'eos';
                    if (['eol', 'endoflife', 'end_of_life'].includes(v)) return 'eol';
                    return null;
                };

                let effectiveBulkAssetIds;
                const outcomeById = new Map();

                if (isBulkTransfer && bulkDispositionMap && Object.keys(bulkDispositionMap).length > 0 && allBulkIdStrs.length > 0) {
                    for (const bid of allBulkIdStrs) {
                        const raw = bulkDispositionMap[bid] ?? bulkDispositionMap[String(bid)];
                        let d = normalizeBulkDisposition(raw, actionType);
                        if (!d) {
                            if (actionType === 'Leave') d = 'leave';
                            else if (actionType === 'Return Asset') d = 'return';
                            else d = asset.pendingActionDetails?.originalActionType === 'End of Services' ? 'eos' : 'eol';
                        }
                        outcomeById.set(String(bid), d);
                    }
                    effectiveBulkAssetIds = allBulkIdStrs.filter((id) => outcomeById.get(String(id)) !== 'reject');
                } else {
                    const hasRequestedSubset = Array.isArray(bulkAssetIdsToProcess) && bulkAssetIdsToProcess.length > 0;
                    effectiveBulkAssetIds = (hasRequestedSubset ? bulkAssetIdsToProcess : bulkAssetIds)
                        .map(String)
                        .filter(Boolean);
                }

                // Always ensure current asset is included in processing when not using explicit per-row map.
                const currentIdStr = asset._id?.toString();
                if (!bulkDispositionMap && currentIdStr && !effectiveBulkAssetIds.includes(currentIdStr)) {
                    effectiveBulkAssetIds.unshift(currentIdStr);
                }

                const rejectedFromBulk =
                    approve && isBulkTransfer && allBulkIdStrs.length > 0
                        ? bulkDispositionMap && outcomeById.size
                            ? allBulkIdStrs.filter((id) => outcomeById.get(String(id)) === 'reject')
                            : allBulkIdStrs.filter((id) => !effectiveBulkAssetIds.includes(String(id)))
                        : [];

                const otherAssetIds = effectiveBulkAssetIds.filter((x) => x !== currentIdStr);

                /** Before assignee fields are cleared (EOL/Return), for bulk employee emails + PDF */
                let bulkEmailSnapshots = [];
                if (allBulkIdStrs.length > 0) {
                    const preRows = await AssetItem.find({ _id: { $in: allBulkIdStrs } })
                        .populate('assignedTo')
                        .populate('assignedCompany')
                        .lean();
                    const ord = new Map(allBulkIdStrs.map((id, i) => [String(id), i]));
                    preRows.sort((a, b) => (ord.get(String(a._id)) ?? 0) - (ord.get(String(b._id)) ?? 0));
                    bulkEmailSnapshots = preRows;
                }

                // Process current asset
                const processAsset = async (currentAsset, outcomeOverride = null) => {
                    let op = outcomeOverride;
                    if (!op) {
                        if (actionType === 'Return Asset') op = 'return';
                        else if (actionType === 'Leave') op = 'leave';
                        else {
                            const oat = currentAsset.pendingActionDetails?.originalActionType;
                            op = oat === 'End of Services' ? 'eos' : 'eol';
                        }
                    }

                    // Process "Return Asset" action
                    if (op === 'return') {
                        const prevAssignedTo = currentAsset.assignedTo;

                        clearParkingFlags(currentAsset);
                        currentAsset.status = 'Unassigned';
                        currentAsset.assignedTo = null;
                        currentAsset.assignedCompany = null;
                        currentAsset.assignedToType = null;
                        currentAsset.assignedBy = null;
                        currentAsset.acceptedBy = null;
                        currentAsset.ownership = null;
                        currentAsset.assignmentType = null;
                        currentAsset.assignedDays = null;
                        currentAsset.assignedDate = null;
                        currentAsset.acceptanceStatus = 'Accepted';
                        currentAsset.negotiationHistory = [];
                        currentAsset.onLeaveActive = false;
                        currentAsset.onLeaveStartDate = null;
                        currentAsset.onLeaveEndDate = null;
                        currentAsset.onLeaveDuration = null;
                        currentAsset.parkingExtendedDays = 0;
                        currentAsset.parkingReminderSentAt = null;

                        await AssetHistory.create({
                            assetId: currentAsset._id,
                            action: 'Returned',
                            assignedTo: prevAssignedTo || undefined,
                            performedBy: req.user._id,
                            comments: `Asset Controller approved "${actionType}"${isBulkTransfer ? ' (Bulk Transfer)' : ''}. Asset returned to store. ${comment || ''}`,
                            date: new Date(),
                            details: { status: 'ApprovedAndFinalized', originalAction: actionType, isBulk: isBulkTransfer }
                        });

                        // Notify the previously assigned employee (or their delegate) that AC returned it.
                        if (prevAssignedTo && !isBulkTransfer) {
                            try {
                                const employee = await EmployeeBasic.findById(prevAssignedTo)
                                    .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                                    .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
                                    .lean()
                                    .catch(() => null);
                                if (employee) {
                                    let returnApprovedPdf = [];
                                    try {
                                        returnApprovedPdf = await buildApprovedActionHandoverAttachments(
                                            req,
                                            currentAsset,
                                            'return-approved-handover',
                                        );
                                    } catch (e) {
                                        /* non-fatal */
                                    }
                                    await sendAssignedEmployeeActionEmail({
                                        asset: currentAsset,
                                        employee,
                                        action: 'Return Asset',
                                        performedBy: req.user.employeeId || 'Asset Controller',
                                        details: 'Your asset was returned to store by Asset Controller/Admin.',
                                        attachments: returnApprovedPdf
                                    });
                                }
                            } catch {
                                /* non-fatal */
                            }
                        }
                    }
                    // Process "Leave" action
                    else if (op === 'leave') {
                        const leaveDuration = currentAsset.pendingActionDetails?.duration || currentAsset.pendingActionDetails?.leaveDuration;
                        if (hasActiveParkingContext(currentAsset)) {
                            await AssetHistory.create({
                                assetId: currentAsset._id,
                                action: 'Comment',
                                performedBy: req.user._id,
                                comments: `Asset Controller approved "${actionType}"${isBulkTransfer ? ' (Bulk Transfer)' : ''}. Asset is already on leave; transfer not applied. ${comment || ''}`,
                                date: new Date(),
                                details: { status: 'OnLeaveUnchanged', originalAction: actionType, isBulk: isBulkTransfer }
                            });
                        } else {
                            applyParkingLeaveStatus(currentAsset, leaveDuration);

                            let ownerForPack = currentAsset.assignedTo;
                            if (ownerForPack && (!ownerForPack.primaryReportee || !ownerForPack.employeeId)) {
                                ownerForPack = await EmployeeBasic.findById(
                                    currentAsset.assignedTo?._id || currentAsset.assignedTo,
                                )
                                    .select('firstName lastName employeeId primaryReportee')
                                    .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail')
                                    .lean();
                            }
                            applyLeavePackToCustodian(currentAsset, {
                                hodEmployee: ownerForPack?.primaryReportee || null,
                                assetControllerEmployee: assetControllerEmp,
                            });

                            await AssetHistory.create({
                                assetId: currentAsset._id,
                                action: 'On Leave',
                                performedBy: req.user._id,
                                comments: `Asset Controller approved "${actionType}"${isBulkTransfer ? ' (Bulk Transfer)' : ''}. Asset placed on leave${leaveDuration ? ` for ${leaveDuration} day(s)` : ''}${isServiceActive(currentAsset) ? ' (on service unchanged)' : ''}. ${comment || ''}`,
                                date: new Date(),
                                details: { status: 'ApprovedAndFinalized', originalAction: actionType, isBulk: isBulkTransfer, duration: leaveDuration }
                            });
                        }
                    }
                    // Process "End of Life" / End of Services (store return)
                    else if (op === 'eos' || op === 'eol') {
                        const originalActionType = currentAsset.pendingActionDetails?.originalActionType;
                        const isEndOfServices = op === 'eos' || originalActionType === 'End of Services';
                        // For company allocations, HR needs notification, but End of Life clears assignment fields.
                        const wasCompanyAllocation = currentAsset.assignedToType === 'Company';
                        let companyNameForNotification =
                            (currentAsset.assignedCompany && typeof currentAsset.assignedCompany === 'object' ? currentAsset.assignedCompany.name : null) || null;
                        let companyIdForNotification =
                            (currentAsset.assignedCompany && typeof currentAsset.assignedCompany === 'object' ? currentAsset.assignedCompany.companyId : null) || null;

                        if (wasCompanyAllocation && (!companyNameForNotification || !companyIdForNotification) && typeof currentAsset.assignedCompany === 'string') {
                            const comp = await Company.findById(currentAsset.assignedCompany).select('name companyId nickName').lean().catch(() => null);
                            companyNameForNotification = companyNameForNotification || comp?.name || null;
                            companyIdForNotification = companyIdForNotification || comp?.companyId || null;
                        }

                        // End of Services => Unassigned (return to store)
                        if (isEndOfServices) {
                            await notifyAssignedEmployeeIfController(
                                req,
                                currentAsset,
                                'Return Asset',
                                'Asset returned to store after End of Services approval by Asset Controller.'
                            );
                            currentAsset.status = 'Unassigned';
                        } else {
                            currentAsset.status = 'Unassigned';
                        }

                        currentAsset.assignedTo = null;
                        currentAsset.assignedCompany = null;
                        currentAsset.assignedToType = null;
                        currentAsset.assignmentType = null;
                        currentAsset.assignedDate = null;

                        await AssetHistory.create({
                            assetId: currentAsset._id,
                            action: 'Unassigned',
                            performedBy: req.user._id,
                            comments: isEndOfServices
                                ? `Asset Controller approved "${actionType}" (original: End of Services)${isBulkTransfer ? ' (Bulk Transfer)' : ''}. Asset returned to store (Unassigned). ${comment || ''}`
                                : `Asset Controller approved "${actionType}"${isBulkTransfer ? ' (Bulk Transfer)' : ''}. Asset marked as End of Life and unassigned. ${comment || ''}`,
                            date: new Date(),
                            details: { status: 'ApprovedAndFinalized', originalAction: actionType, isBulk: isBulkTransfer }
                        });

                        // Notify flowchart company asset coordinator (Assigned User / Admin) for company allocations.
                        if (wasCompanyAllocation) {
                            try {
                                const companyCoordinatorNotify = await getCompanyAssetCoordinator();
                                if (!companyCoordinatorNotify?._id) {
                                } else {
                                    let eolHrPdf = [];
                                    try {
                                        eolHrPdf = await buildApprovedActionHandoverAttachments(
                                            req,
                                            currentAsset,
                                            'eol-company-approved-handover',
                                        );
                                    } catch (e) {
                                        /* non-fatal */
                                    }
                                    await sendAssignedEmployeeActionEmail({
                                        asset: currentAsset,
                                        employee: companyCoordinatorNotify,
                                        action,
                                        performedBy: req.user.employeeId || 'Asset Controller',
                                        details: isEndOfServices
                                            ? `End of Services was approved by Asset Controller. Asset returned to store (Unassigned). (Company: ${companyNameForNotification || 'Company allocation'})`
                                            : `End of Life was approved by Asset Controller. (Company: ${companyNameForNotification || 'Company allocation'})`,
                                        attachments: eolHrPdf
                                    });

                                    await DashboardAction.create({
                                        assignedTo: companyCoordinatorNotify._id,
                                        assignedToEmpId: companyCoordinatorNotify.employeeId,
                                        requestId: currentAsset._id,
                                        requestType: 'Asset End of Life',
                                        status: 'Approved',
                                        subjectEmployeeId: companyIdForNotification || 'UNASSIGNED',
                                        subjectName: companyNameForNotification || 'Company allocation',
                                        requestedByName: req.user.name || req.user.employeeId || 'Asset Controller',
                                        actionedDate: new Date(),
                                        actionedBy: req.user.employeeObjectId || req.user.id || null,
                                        extra1: `${currentAsset.assetId} — ${currentAsset.name || ''}`,
                                        extra2: 'End of Life (Company allocation)'
                                    });
                                }
                            } catch (mailErr) {
                            }
                        }
                    }

                    // Clean up pending action
                    currentAsset.pendingAction = null;
                    currentAsset.pendingActionDetails = null;
                    currentAsset.actionRequiredBy = null;

                    await currentAsset.save();

                    // Delete Dashboard Action for this asset
                    await DashboardAction.deleteMany({ requestId: currentAsset._id });
                };

                const processedAssets = [];

                if (!isBulkTransfer) {
                    if (currentIdStr && effectiveBulkAssetIds.includes(currentIdStr)) {
                        await processAsset(asset);
                        processedAssets.push(asset);
                    }
                } else if (approve) {
                    if (rejectedFromBulk.length > 0) {
                        const rejDocs = await AssetItem.find({
                            _id: { $in: rejectedFromBulk },
                            pendingAction: actionType,
                            'pendingActionDetails.isBulk': true
                        });
                        const byIdRej = new Map(rejDocs.map((a) => [a._id.toString(), a]));
                        for (const rid of rejectedFromBulk) {
                            const rejAsset = byIdRej.get(String(rid));
                            if (!rejAsset) continue;
                            if (isServiceActive(rejAsset)) {
                                // keep onServiceActive
                            } else if (isLeaveActive(rejAsset) || hasActiveParkingContext(rejAsset)) {
                                rejAsset.onLeaveActive = true;
                                rejAsset.status = rejAsset.assignedTo ? 'Assigned' : 'Unassigned';
                            } else {
                                rejAsset.status = rejAsset.assignedTo ? 'Assigned' : 'Unassigned';
                            }
                            rejAsset.pendingAction = null;
                            rejAsset.pendingActionDetails = null;
                            rejAsset.actionRequiredBy = null;
                            await AssetHistory.create({
                                assetId: rejAsset._id,
                                action: 'Comment',
                                performedBy: req.user._id,
                                comments: `Bulk "${actionType}" not approved for this asset. ${comment || ''}`,
                                date: new Date(),
                                details: { status: 'RejectedByAuthority', originalAction: actionType, bulkNotProcessed: true }
                            });
                            await DashboardAction.deleteMany({ requestId: rejAsset._id });
                            await rejAsset.save();
                        }
                    }

                    const orderedApproveIds = [...new Set(effectiveBulkAssetIds.map(String))].filter(Boolean);
                    for (const bid of orderedApproveIds) {
                        let doc = currentIdStr && bid === currentIdStr ? asset : null;
                        if (!doc) {
                            doc = await AssetItem.findOne({
                                _id: bid,
                                pendingAction: actionType,
                                'pendingActionDetails.isBulk': true
                            }).populate('assignedTo');
                        }
                        if (!doc) continue;
                        const oc = outcomeById.size ? outcomeById.get(String(bid)) : null;
                        if (oc === 'reject') continue;
                        await processAsset(doc, oc || null);
                        processedAssets.push(doc);
                    }
                }

                const bulkMessage = isBulkTransfer
                    ? `Bulk ${actionType} approved and processed successfully for ${processedAssets.length} asset(s).`
                    : `${actionType} approved and processed successfully.`;

                const refreshedAsset = await AssetItem.findById(asset._id)
                    .populate('assignedTo', 'firstName lastName employeeId companyEmail primaryReportee')
                    .populate('assignedCompany', 'name companyId')
                    .populate('actionRequiredBy', 'firstName lastName employeeId')
                    .lean();

                void (async () => {
                    // Send success emails to Asset Controller and assigned users (non-blocking)
                    try {
                        const { sendAssetActionApprovedEmail, sendAssetBulkActionApprovedEmail } = await import('../utils/sendAssetActionApprovedEmail.js');
                        const { sendAssetTransferSuccessEmail } = await import('../utils/sendAssetTransferSuccessEmail.js');

                        if (isBulkTransfer && approve && allBulkIdStrs.length > 0) {
                            const processedIdSet = new Set(processedAssets.map((a) => a._id.toString()));
                            const rejectedSet = new Set(rejectedFromBulk.map(String));
                            const fullRows = bulkEmailSnapshots.length
                                ? bulkEmailSnapshots
                                : await AssetItem.find({ _id: { $in: allBulkIdStrs } })
                                    .populate('assignedTo')
                                    .populate('assignedCompany')
                                    .lean();
                            const byAssignee = new Map();
                            for (const row of fullRows) {
                                if (row.assignedToType === 'Company') continue;
                                const aid = row.assignedTo?._id?.toString() || row.assignedTo?.toString();
                                if (!aid) continue;
                                if (!byAssignee.has(aid)) byAssignee.set(aid, []);
                                byAssignee.get(aid).push(row);
                            }
                            const approverName = assetControllerEmp
                                ? `${assetControllerEmp.firstName || ''} ${assetControllerEmp.lastName || ''}`.trim()
                                : 'Asset Controller';
                            const actLabel =
                                actionType === 'Return Asset'
                                    ? 'return to store'
                                    : actionType === 'Leave'
                                        ? 'leave / parking transfer'
                                        : 'end of life / services';

                            for (const [assigneeId, rows] of byAssignee) {
                                const allIdsForEmp = rows.map((r) => r._id.toString());
                                const processedForEmp = allIdsForEmp.filter((id) => processedIdSet.has(id));
                                const rejectedForEmp = allIdsForEmp.filter((id) => rejectedSet.has(id));
                                if (!processedForEmp.length && !rejectedForEmp.length) continue;
                                const employee = await EmployeeBasic.findById(assigneeId)
                                    .select(
                                        'firstName lastName employeeId companyEmail workEmail department signature primaryReportee',
                                    )
                                    .populate('primaryReportee', 'firstName lastName companyEmail workEmail')
                                    .lean();
                                if (!employee) continue;
                                let att = [];
                                if (processedForEmp.length) {
                                    try {
                                        att = await buildBulkActionHandoverEmailAttachments(req, processedForEmp, {
                                            assigner: assetControllerEmp,
                                            assignee: employee,
                                            filenameBase: 'bulk-ac-approved-handover',
                                        });
                                    } catch (e) {
                                        /* non-fatal */
                                    }
                                }
                                await sendAssetBulkDispositionResultEmail({
                                    employee,
                                    reportee: employee.primaryReportee,
                                    approverName,
                                    subjectLine: `Bulk ${actionType} — ${processedForEmp.length} processed, ${rejectedForEmp.length} unchanged`,
                                    introHtml: `<p>Your bulk <strong>${actLabel}</strong> request was reviewed by the Asset Controller.</p>
                                    <p><strong>${processedForEmp.length}</strong> asset(s) were updated. <strong>${rejectedForEmp.length}</strong> asset(s) were not changed and remain assigned to you.</p>`,
                                    attachments: att
                                });
                            }

                            if (assetControllerEmp) {
                                let acPdf = [];
                                try {
                                    const pIds = processedAssets.map((a) => a._id.toString());
                                    const acAssignee = asset.assignedTo
                                        ? await EmployeeBasic.findById(asset.assignedTo._id || asset.assignedTo)
                                            .select(
                                                'firstName lastName employeeId department signature primaryReportee',
                                            )
                                            .populate('primaryReportee', 'firstName lastName employeeId')
                                            .lean()
                                        : null;
                                    if (pIds.length && acAssignee) {
                                        acPdf = await buildBulkActionHandoverEmailAttachments(req, pIds, {
                                            assigner: assetControllerEmp,
                                            assignee: acAssignee,
                                            filenameBase: `ac-approved-${String(actionType).replace(/\s+/g, '-')}-handover`,
                                        });
                                    }
                                } catch (e) {
                                    /* non-fatal */
                                }
                                await sendAssetTransferSuccessEmail(
                                    {
                                        ...asset.toObject(),
                                        assetId: asset.assetId,
                                        name: `Bulk ${actionType} (${processedAssets.length} assets)`
                                    },
                                    actionType,
                                    assetControllerEmp,
                                    await EmployeeBasic.findById(asset.assignedTo?._id || asset.assignedTo).select('firstName lastName'),
                                    acPdf
                                );
                            }
                        } else {
                            let approvedHandoverPdf = [];

                            // Leave: processedAssets still have assignee. End of Life: use bulkEmailSnapshots (assignee cleared on save).
                            if (actionType === 'Leave') {
                                if (isBulkTransfer && processedAssets.length > 1) {
                                    const primaryAsset = processedAssets[0];
                                    if (primaryAsset.assignedTo) {
                                        const assignedUser = await EmployeeBasic.findById(
                                            primaryAsset.assignedTo._id || primaryAsset.assignedTo,
                                        )
                                            .select(
                                                'firstName lastName employeeId companyEmail workEmail email primaryReportee signature department',
                                            )
                                            .populate('primaryReportee', 'firstName lastName companyEmail workEmail')
                                            .lean();
                                        if (assignedUser) {
                                            try {
                                                approvedHandoverPdf = await buildBulkActionHandoverEmailAttachments(
                                                    req,
                                                    processedAssets.map((a) => a._id.toString()),
                                                    {
                                                        assigner: assetControllerEmp,
                                                        assignee: assignedUser,
                                                        filenameBase: 'approved-leave-handover',
                                                    },
                                                );
                                            } catch (pdfErr) {
                                            }
                                            await sendAssetBulkActionApprovedEmail(
                                                processedAssets,
                                                actionType,
                                                assignedUser,
                                                assignedUser.primaryReportee || null,
                                                assetControllerEmp || { firstName: 'Asset', lastName: 'Controller' },
                                                approvedHandoverPdf,
                                            );
                                        }
                                    }
                                } else {
                                    for (const processedAsset of processedAssets) {
                                        if (processedAsset.assignedTo) {
                                            const assignedUser = await EmployeeBasic.findById(processedAsset.assignedTo._id || processedAsset.assignedTo)
                                                .select('firstName lastName employeeId companyEmail workEmail email primaryReportee signature department')
                                                .populate('primaryReportee', 'firstName lastName companyEmail workEmail')
                                                .lean();
                                            if (assignedUser) {
                                                let handoverApprovedPdf = [];
                                                try {
                                                    handoverApprovedPdf = await buildApprovedActionHandoverAttachments(
                                                        req,
                                                        processedAsset,
                                                        `approved-${String(actionType).replace(/\s+/g, '-')}-handover`,
                                                    );
                                                } catch (e) {
                                                }
                                                await sendAssetActionApprovedEmail(
                                                    processedAsset,
                                                    actionType,
                                                    assignedUser,
                                                    assignedUser.primaryReportee || null,
                                                    assetControllerEmp || { firstName: 'Asset', lastName: 'Controller' },
                                                    handoverApprovedPdf,
                                                );
                                            }
                                        }
                                    }
                                }
                            } else if (actionType === 'End of Life') {
                                const employeeRows = (bulkEmailSnapshots.length ? bulkEmailSnapshots : []).filter(
                                    (r) => r.assignedTo && r.assignedToType !== 'Company'
                                );
                                if (employeeRows.length > 0) {
                                    if (isBulkTransfer && employeeRows.length > 1) {
                                        const firstRef = employeeRows[0].assignedTo;
                                        const firstId = firstRef?._id?.toString() || firstRef?.toString?.();
                                        const sameEmp =
                                            firstId &&
                                            employeeRows.every((r) => {
                                                const rid = r.assignedTo?._id?.toString() || r.assignedTo?.toString?.();
                                                return rid === firstId;
                                            });
                                        if (sameEmp) {
                                            const assignedUser = await EmployeeBasic.findById(firstId)
                                                .select(
                                                    'firstName lastName employeeId companyEmail workEmail email primaryReportee signature department',
                                                )
                                                .populate('primaryReportee', 'firstName lastName companyEmail workEmail')
                                                .lean();
                                            if (assignedUser) {
                                                let eolBulkHandoverPdf = [];
                                                try {
                                                    eolBulkHandoverPdf = await buildBulkActionHandoverEmailAttachments(
                                                        req,
                                                        employeeRows.map((r) => r._id.toString()),
                                                        {
                                                            assigner: assetControllerEmp,
                                                            assignee: assignedUser,
                                                            filenameBase: 'approved-eol-handover',
                                                        },
                                                    );
                                                } catch (e) {
                                                    /* non-fatal */
                                                }
                                                approvedHandoverPdf = eolBulkHandoverPdf;
                                                await sendAssetBulkActionApprovedEmail(
                                                    employeeRows,
                                                    actionType,
                                                    assignedUser,
                                                    assignedUser.primaryReportee || null,
                                                    assetControllerEmp || { firstName: 'Asset', lastName: 'Controller' },
                                                    eolBulkHandoverPdf,
                                                );
                                            }
                                        } else {
                                            for (const row of employeeRows) {
                                                const rid = row.assignedTo?._id || row.assignedTo;
                                                const assignedUser = await EmployeeBasic.findById(rid).populate('primaryReportee');
                                                if (assignedUser) {
                                                    let onePdf = [];
                                                    try {
                                                        onePdf = await buildApprovedActionHandoverAttachments(
                                                            req,
                                                            row,
                                                            'approved-eol-handover',
                                                        );
                                                    } catch (e) {
                                                        /* non-fatal */
                                                    }
                                                    await sendAssetActionApprovedEmail(
                                                        row,
                                                        actionType,
                                                        assignedUser,
                                                        assignedUser.primaryReportee || null,
                                                        assetControllerEmp || { firstName: 'Asset', lastName: 'Controller' },
                                                        onePdf
                                                    );
                                                }
                                            }
                                        }
                                    } else {
                                        for (const row of employeeRows) {
                                            const rid = row.assignedTo?._id || row.assignedTo;
                                            const assignedUser = await EmployeeBasic.findById(rid).populate('primaryReportee');
                                            if (assignedUser) {
                                                let onePdf = [];
                                                try {
                                                    onePdf = await buildApprovedActionHandoverAttachments(
                                                        req,
                                                        row,
                                                        'approved-eol-handover',
                                                    );
                                                } catch (e) {
                                                    /* non-fatal */
                                                }
                                                await sendAssetActionApprovedEmail(
                                                    row,
                                                    actionType,
                                                    assignedUser,
                                                    assignedUser.primaryReportee || null,
                                                    assetControllerEmp || { firstName: 'Asset', lastName: 'Controller' },
                                                    onePdf
                                                );
                                            }
                                        }
                                    }
                                }
                            }

                            // Send success email to Asset Controller (once for the bulk transfer)
                            if (assetControllerEmp) {
                                const primaryAsset = asset;
                                const approvalIds = processedAssets.map((a) => a._id.toString()).filter(Boolean);
                                let acSuccessHandoverPdf = approvedHandoverPdf;
                                if (!acSuccessHandoverPdf?.length && approvalIds.length) {
                                    const acAssignee = primaryAsset.assignedTo
                                        ? await EmployeeBasic.findById(primaryAsset.assignedTo._id || primaryAsset.assignedTo)
                                            .select(
                                                'firstName lastName employeeId department signature primaryReportee',
                                            )
                                            .populate('primaryReportee', 'firstName lastName employeeId')
                                            .lean()
                                        : null;
                                    if (acAssignee) {
                                        try {
                                            acSuccessHandoverPdf = await buildBulkActionHandoverEmailAttachments(
                                                req,
                                                approvalIds,
                                                {
                                                    assigner: assetControllerEmp,
                                                    assignee: acAssignee,
                                                    filenameBase: `ac-approved-${String(actionType).replace(/\s+/g, '-')}-handover`,
                                                },
                                            );
                                        } catch (e) {
                                            /* non-fatal */
                                        }
                                    }
                                }
                                const assignedUserObj = primaryAsset.assignedTo
                                    ? await EmployeeBasic.findById(primaryAsset.assignedTo._id || primaryAsset.assignedTo).select(
                                        'firstName lastName',
                                    )
                                    : null;
                                await sendAssetTransferSuccessEmail(
                                    {
                                        ...primaryAsset.toObject(),
                                        assetId: primaryAsset.assetId,
                                        name: isBulkTransfer
                                            ? `Bulk ${actionType} (${processedAssets.length} assets)`
                                            : primaryAsset.name,
                                    },
                                    actionType,
                                    assetControllerEmp,
                                    assignedUserObj,
                                    acSuccessHandoverPdf,
                                );
                            }
                        }
                    } catch (emailErr) {
                    }

                    if (!isBulkTransfer) {
                        for (const processedAsset of processedAssets) {
                            try {
                                await notifyAssignedEmployeeIfController(
                                    req,
                                    processedAsset,
                                    actionType,
                                    `${actionType} was approved by Asset Controller.`,
                                    { attachApprovedHandover: true },
                                );
                            } catch (notifyErr) {
                            }
                        }
                    }
                })();

                void emailTransferRequester(true, comment || '');

                return res.status(200).json({
                    message: bulkMessage,
                    asset: refreshedAsset,
                    processedCount: processedAssets.length,
                    isBulk: isBulkTransfer
                });
            }

            // Company-assigned loss/damage: flowchart coordinator approves first; Asset Controller enters fine details next.
            if (
                actionType === 'Loss and Damage' &&
                isCompanyAsset &&
                isCompanyCoordinatorUser &&
                !isAssetControllerApprowing &&
                !isAdmin &&
                asset.actionRequiredBy?.toString() === currentUserEmpId
            ) {
                const assetControllerFwd = await getDepartmentHOD('assetcontroller');
                if (!assetControllerFwd?._id) {
                    return res.status(400).json({
                        message: 'Asset Controller is not configured. Cannot route loss and damage after company approval.'
                    });
                }
                asset.actionRequiredBy = assetControllerFwd._id;
                await asset.save();

                await DashboardAction.findOneAndUpdate(
                    {
                        requestId: asset._id,
                        status: 'Pending',
                        requestType: 'Asset Loss Damage'
                    },
                    {
                        $set: {
                            assignedTo: assetControllerFwd._id,
                            assignedToEmpId: assetControllerFwd.employeeId
                        }
                    },
                    { new: true }
                ).catch(() => null);

                try {
                    const requesterName =
                        req.user.name ||
                        (req.user.firstName && req.user.lastName
                            ? `${req.user.firstName} ${req.user.lastName}`
                            : req.user.employeeId || 'User');
                    let ldPdf = [];
                    try {
                        ldPdf = await buildApprovedActionHandoverAttachments(
                            req,
                            asset,
                            'asset-ld-company-approved-handover',
                        );
                    } catch (e) {
                        /* non-fatal */
                    }
                    await sendAssetActionApprovalEmail(
                        { ...asset.toObject(), assetId: asset.assetId, name: asset.name },
                        actionType,
                        assetControllerFwd,
                        { name: requesterName },
                        'Company coordinator approved loss/damage. Asset Controller action required to complete fine details.',
                        ldPdf
                    );
                } catch (emailErr) {
                }

                void emailLossDamageRequester(true, comment || 'Company coordinator approved; pending Asset Controller fine details.');

                return res.status(200).json({
                    message:
                        'Approved by company coordinator. Pending Asset Controller to enter fine details and finalize loss and damage.',
                    asset,
                    forwardedToAssetController: true
                });
            }

            // For "Loss and Damage", Asset Controller / Admin approval creates a Fine with status "Pending HR"
            if ((isAssetControllerApprowing || isAdmin) && actionType === 'Loss and Damage') {
                // If fineData is provided in request body (from modal submission), update pendingActionDetails
                if (fineData) {
                    asset.pendingActionDetails = asset.pendingActionDetails || {};
                    asset.pendingActionDetails.fineData = fineData;
                    // Update attachment if provided in fineData
                    if (fineData.attachment?.data) {
                        const uploadResult = await uploadDocumentToS3(fineData.attachment.data, 'asset-history');
                        asset.pendingActionDetails.attachment = uploadResult.publicId;
                    }
                    // Update reason/description if provided
                    if (fineData.description) {
                        asset.pendingActionDetails.reason = fineData.description;
                    }
                    await asset.save();
                }

                // Check if fineData is available (either from pendingActionDetails or just set above)
                const fd = fineData || asset.pendingActionDetails?.fineData;
                if (!fd) {
                    // Return asset data so frontend can open modal for Asset Controller to fill fine data
                    return res.status(200).json({
                        message: 'Approval pending. Please fill in fine details.',
                        requiresFineData: true,
                        asset: {
                            _id: asset._id,
                            assetId: asset.assetId,
                            name: asset.name,
                            assignedTo: asset.assignedTo,
                            assignedCompany: asset.assignedCompany,
                            assignedToType: asset.assignedToType,
                            pendingActionDetails: asset.pendingActionDetails
                        }
                    });
                }

                // STEP 1 APPROVED (Asset Controller) -> Create Fine with status "Pending HR"
                if (fd) {
                    try {
                        const Fine = (await import('../models/Fine.js')).default;
                        const { getDepartmentHOD } = await import('../utils/getDepartmentHOD.js');
                        const User = (await import('../models/User.js')).default;
                        const { syncDashboardAction } = await import('../utils/syncDashboard.js');

                        const finePayload = fd || asset.pendingActionDetails?.fineData;
                        const uniqueFineId = await generateFineIdInternal();

                        // Validate full fine tracker flow before creating L&D fine
                        const trackerValidation = await validateFineTrackerFlowchart();
                        if (!trackerValidation.ok) {
                            return res.status(400).json({ message: trackerValidation.message });
                        }
                        const hrHOD = trackerValidation.hrHOD;

                        const hrUser = await User.findOne({ employeeId: hrHOD.employeeId });
                        const hrAssignmentId = hrUser ? hrUser._id : hrHOD._id;

                        const { employees, ...cleanFd } = finePayload;
                        const fineModel = new Fine({
                            ...cleanFd,
                            assignedEmployees: employees || finePayload.assignedEmployees || [],
                            company: asset.assignedTo?.company?._id || finePayload.company,
                            companyName: asset.assignedTo?.company?.name || finePayload.companyName || '',
                            fineId: uniqueFineId,
                            fineStatus: 'Pending HR', // Direct to Pending HR, not Draft
                            approvalStatus: 'Pending HR',
                            submittedTo: hrAssignmentId,
                            workflow: [{
                                role: 'HR',
                                assignedTo: hrAssignmentId,
                                status: 'Pending',
                                assignedAt: new Date()
                            }],
                            createdBy: req.user._id,
                            awardedDate: new Date(),
                            assetId: asset.assetId,
                            assetObjectId: asset._id,
                            attachment: asset.pendingActionDetails?.attachment ? {
                                url: asset.pendingActionDetails.attachment,
                                name: 'Loss and Damage.pdf',
                                mimeType: 'application/pdf'
                            } : finePayload.attachment
                        });
                        await fineModel.save();

                        // Sync Dashboard Action for Fine
                        const targetEmpId = fineModel.assignedEmployees?.[0]?.employeeId || asset.assignedTo?.employeeId;
                        if (targetEmpId) {
                            const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
                            const subjectEmp = await EmployeeBasic.findOne({ employeeId: targetEmpId });
                            await syncDashboardAction({
                                requestId: fineModel._id,
                                requestType: 'Fine',
                                assignedTo: hrAssignmentId,
                                status: 'Pending',
                                subjectEmployee: subjectEmp,
                                requestedByName: req.user.name || '',
                                extra1: fineModel.fineType || 'Loss & Damage',
                                extra2: `AED ${fineModel.fineAmount || 0}`
                            });
                        }

                        // Send fine approval email
                        try {
                            const { sendFineApprovalEmail } = await import('../utils/sendFineApprovalEmail.js');
                            await sendFineApprovalEmail(fineModel, fineModel.assignedEmployees || []);
                        } catch (emailErr) {
                        }


                        // Create history log
                        await AssetHistory.create({
                            assetId: asset._id,
                            action: 'Comment',
                            performedBy: req.user._id,
                            comments: `Asset Controller approved "${actionType}". Fine created (${uniqueFineId}) with status Pending HR. ${comment || ''}`,
                            date: new Date(),
                            details: { status: 'AssetControllerApproved', originalAction: actionType, fineId: uniqueFineId }
                        });

                        // Delete Dashboard Action for asset
                        const dashboardRequestType = 'Asset Loss Damage';
                        await DashboardAction.deleteMany({ requestId: asset._id, requestType: dashboardRequestType });

                        void emailLossDamageRequester(true, comment || '');

                        const lostAssignee =
                            asset.assignedTo && typeof asset.assignedTo === 'object'
                                ? asset.assignedTo
                                : asset.assignedTo
                                    ? await EmployeeBasic.findById(asset.assignedTo)
                                        .select('firstName lastName employeeId companyEmail workEmail')
                                        .lean()
                                        .catch(() => null)
                                    : null;

                        await applyMainAssetLossDamageAccessoryDisposition(asset, finePayload, req, uniqueFineId);
                        applyAssetLostFinalState(asset);

                        await AssetHistory.create({
                            assetId: asset._id,
                            action: 'Lost',
                            performedBy: req.user.employeeObjectId || req.user._id,
                            comments: `Loss and Damage finalized. Fine ${uniqueFineId} created (Pending HR). ${comment || ''}`,
                            date: new Date(),
                            details: { status: 'Lost', fineId: uniqueFineId, lastAssignee: lostAssignee?._id || null },
                        });

                        await asset.save();
                        try {
                            await syncAllAccessoryInstancesForAsset(asset);
                        } catch {
                            /* non-fatal */
                        }

                        if (lostAssignee) {
                            try {
                                const { sendAssetLostOwnerEmail } = await import('../utils/sendAssetLostOwnerEmail.js');
                                await sendAssetLostOwnerEmail({
                                    asset: { ...asset.toObject?.() || asset, assignedTo: lostAssignee },
                                    employee: lostAssignee,
                                    lossValue: fineModel.fineAmount,
                                    fineId: uniqueFineId,
                                });
                            } catch (mailErr) {
                            }
                        }

                        await notifyAssignedEmployeeIfController(req, asset, actionType, `${actionType} was approved by Asset Controller and moved to Pending HR.`);
                        return res.status(200).json({
                            message: `Approved by Asset Controller. Fine created (${uniqueFineId}) with status Pending HR.`,
                            asset,
                            fineId: uniqueFineId
                        });
                    } catch (fineErr) {
                        return res.status(500).json({ message: 'Failed to create fine. Please try again.', error: fineErr.message });
                    }
                } else {
                    return res.status(400).json({ message: 'Fine data not provided. Cannot create fine for Loss and Damage.' });
                }
            }

            // Note: Loss and Damage is now handled above (creates fine after Asset Controller approval)
            // This section handles other finalizations that may come through HR (legacy or edge cases)
            // For Loss and Damage, fine workflow handles the rest

        } else {
            // Rejected
            const isBulkTransfer = asset.pendingActionDetails?.isBulk === true;
            const bulkAssetIds = asset.pendingActionDetails?.bulkAssetIds || [];

            // Bulk subset rejection (Leave / End of Life / Return Asset) - Asset Controller authority.
            if (
                isBulkTransfer &&
                (isAssetController || isAdmin) &&
                (actionType === 'Leave' || actionType === 'End of Life' || actionType === 'Return Asset')
            ) {
                const hasRequestedSubset = Array.isArray(bulkAssetIdsToProcess) && bulkAssetIdsToProcess.length > 0;
                const effectiveBulkAssetIds = (hasRequestedSubset ? bulkAssetIdsToProcess : bulkAssetIds)
                    .map(String)
                    .filter(Boolean);

                const currentIdStr = asset._id?.toString();
                if (currentIdStr && !effectiveBulkAssetIds.includes(currentIdStr)) {
                    effectiveBulkAssetIds.unshift(currentIdStr);
                }

                const assetIdSet = new Set(effectiveBulkAssetIds);
                const orderedIds = [...new Set(effectiveBulkAssetIds)].filter((x) => assetIdSet.has(x));

                const assetsToReject = await AssetItem.find({
                    _id: { $in: orderedIds },
                    pendingAction: actionType,
                    'pendingActionDetails.isBulk': true
                });

                const byId = new Map(assetsToReject.map((a) => [a._id.toString(), a]));

                for (const rid of orderedIds) {
                    const currentAsset = byId.get(rid);
                    if (!currentAsset) continue;

                    currentAsset.status = currentAsset.assignedTo ? 'Assigned' : 'Unassigned';
                    currentAsset.pendingAction = null;
                    currentAsset.pendingActionDetails = null;
                    currentAsset.actionRequiredBy = null;

                    await AssetHistory.create({
                        assetId: currentAsset._id,
                        action: 'Comment',
                        performedBy: req.user._id,
                        comments: `Action "${actionType}" rejected/cancelled by authority (${req.user.employeeId || 'unknown'}). Reason: ${comment || 'N/A'}`,
                        date: new Date(),
                        details: { status: 'RejectedByAuthority', originalAction: actionType }
                    });

                    // Delete Dashboard Action (primary row uses requestId on this asset)
                    await DashboardAction.deleteMany({ requestId: currentAsset._id });
                    await currentAsset.save();
                }

                // Notify (non-fatal)
                try {
                    for (const rid of orderedIds) {
                        const currentAsset = byId.get(rid);
                        if (!currentAsset) continue;
                        await notifyAssignedEmployeeIfController(
                            req,
                            currentAsset,
                            actionType,
                            `${actionType} request was rejected by authority.`
                        );
                    }
                } catch (e) {
                    // non-fatal
                }

                void emailTransferRequester(false, comment || '');

                return res.status(200).json({
                    message: `Bulk ${actionType} request rejected`,
                    asset,
                    processedCount: orderedIds.length,
                    isBulk: true
                });
            }

            const lossDamageRejectRequesterId =
                actionType === 'Loss and Damage' ? asset.pendingActionDetails?.requestedBy : null;

            if (actionType === 'Return Asset') {
                // Return request rejected: restore to Assigned (assignee remains the same).
                asset.status = asset.assignedTo ? 'Assigned' : 'Unassigned';
            } else {
                asset.status = asset.assignedTo ? 'Assigned' : 'Unassigned';
            }
            asset.pendingAction = null;
            asset.pendingActionDetails = null;
            asset.actionRequiredBy = null;

            await AssetHistory.create({
                assetId: asset._id,
                action: 'Comment',
                performedBy: req.user._id,
                comments: `Action "${actionType}" rejected/cancelled by authority (${req.user.employeeId || 'unknown'}). Reason: ${comment || 'N/A'}`,
                date: new Date(),
                details: { status: 'RejectedByAuthority', originalAction: actionType }
            });

            // Delete Dashboard Action
            await DashboardAction.deleteMany({ requestId: asset._id });

            if (isTransferLeaveEos) {
                void emailTransferRequester(false, comment || '');
            }
            if (actionType === 'Loss and Damage') {
                void emailLossDamageRequester(false, comment || '');
                const rejectorId = req.user.employeeObjectId?.toString();
                const requesterIdStr = lossDamageRejectRequesterId?.toString?.();
                if (requesterIdStr && requesterIdStr !== rejectorId) {
                    const reviewerEmp = await EmployeeBasic.findById(req.user.employeeObjectId)
                        .select('firstName lastName employeeId')
                        .lean()
                        .catch(() => null);
                    const reviewerDisplayName = reviewerEmp
                        ? `${reviewerEmp.firstName || ''} ${reviewerEmp.lastName || ''}`.trim() || reviewerEmp.employeeId
                        : req.user.name || 'Asset Controller';
                    void notifyLossDamageRejectedToRequester({
                        asset,
                        requesterId: lossDamageRejectRequesterId,
                        reviewerDisplayName,
                        actionedBy: req.user.employeeObjectId || req.user._id,
                        rejectReason: comment || '',
                    });
                }
            }
        }

        await asset.save();
        await notifyAssignedEmployeeIfController(req, asset, actionType, approve ? `${actionType} was approved by authority.` : `${actionType} request was rejected by authority.`);
        const successMessage = approve
            ? (actionType === 'Return Asset'
                ? 'Return request approved. Asset is now Unassigned.'
                : 'Request approved and finalized.')
            : `${actionType} request rejected`;

        res.status(200).json({
            message: successMessage,
            asset
        });
    } catch (error) {
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Finalize Asset Action (Reportee Acknowledgement)
// @route   PUT /api/AssetItem/:id/finalize-action
// @access  Private (Assigned User)
export const finalizeAssetAction = async (req, res) => {
    try {
        const { id } = req.params;
        const { approve, comment } = req.body; // finalize/accept or decline

        const asset = await AssetItem.findById(id).populate('assignedTo');
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        if (!asset.pendingAction) {
            return res.status(400).json({ message: 'No pending action found for this asset' });
        }

        const actionType = asset.pendingAction;

        // Verify that the user is the one assigned - actionRequiredBy references EmployeeBasic
        const currentUserEmpId = req.user.employeeObjectId?.toString();
        if (asset.actionRequiredBy && asset.actionRequiredBy.toString() !== currentUserEmpId) {
            return res.status(403).json({ message: 'You are not authorized to finalize this action' });
        }

        if (approve) {
            const isLossDamage = actionType === 'Loss and Damage';

            await AssetHistory.create({
                assetId: asset._id,
                action: isLossDamage ? 'Lost' : 'Out of Service',
                performedBy: req.user.employeeObjectId,
                comments: `Finalized ${actionType} by Reportee. ${comment || ''}`,
                file: asset.pendingActionDetails?.attachment,
                date: new Date(),
                details: { status: 'Finalized', originalAction: actionType },
            });

            if (isLossDamage) {
                const lossFineData = asset.pendingActionDetails?.fineData;
                if (lossFineData) {
                    await applyMainAssetLossDamageAccessoryDisposition(asset, lossFineData, req);
                }
                applyAssetLostFinalState(asset);
            } else {
                asset.status = 'Out of Service';
                asset.assignedTo = null;
                asset.assignmentType = null;
                asset.pendingAction = null;
                asset.pendingActionDetails = null;
                asset.actionRequiredBy = null;
            }

        } else {
            // Declined — return to manager or restore?
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Comment',
                performedBy: req.user.employeeObjectId,
                comments: `Reportee declined/questioned ${actionType}. Reason: ${comment || ''}`,
                date: new Date(),
                details: { status: 'DeclinedByReportee', originalAction: actionType }
            });
            // Restoring status to Assigned if declined
            asset.status = 'Assigned';
            asset.pendingAction = null;
            asset.pendingActionDetails = null;
            asset.actionRequiredBy = null;
        }

        await asset.save();
        res.status(200).json({
            message: approve
                ? actionType === 'Loss and Damage'
                    ? 'Asset marked as Lost'
                    : 'Asset marked as Out of Service'
                : 'Action declined/restored',
            asset
        });
    } catch (error) {
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Mark Asset as End of Life (Legacy direct call - potentially redirecting to requestAction)
export const endOfLifeAsset = requestAssetAction;

// @desc    Upload Accessories Tab Attachment
// @route   PUT /api/AssetItem/:id/accessories-attachment
// @access  Private
export const uploadAccessoriesAttachment = async (req, res) => {
    try {
        const { id } = req.params;
        const { attachment } = req.body;

        const asset = await AssetItem.findById(id);
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        if (attachment && attachment.startsWith('data:')) {
            const uploadResult = await uploadDocumentToS3(attachment, 'asset-accessories');
            asset.accessoriesAttachment = uploadResult.publicId;
        }

        await asset.save();
        res.status(200).json({ message: 'Attachment uploaded', asset });
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// ACCESSORY-LEVEL ACTION WORKFLOW
// These functions handle Transfer / Loss & Damage / Unattach for individual
// accessories WITHOUT touching the main asset's status field.
// ─────────────────────────────────────────────────────────────────────────────

// @desc    Request an action on a single accessory (Transfer / L&D / Unattach)
// @route   PUT /api/AssetItem/:id/accessories/:accId/request-action
// @access  Private
export const requestAccessoryAction = async (req, res) => {
    try {
        const { id, accId } = req.params;
        const { actionType, reason, attachment, targetAssetId, fineData } = req.body;

        if (actionType === 'End of Life') {
            return res.status(400).json({ message: 'End of Life is not available for accessories.' });
        }
        if (!['Transfer', 'Loss and Damage', 'Unattach'].includes(actionType)) {
            return res.status(400).json({ message: 'Invalid accessory action type' });
        }

        const asset = await AssetItem.findById(id).populate({
            path: 'assignedTo',
            populate: { path: 'primaryReportee' }
        }).populate('assignedCompany');

        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const accessory = asset.accessories.find(a => a._id.toString() === accId || a.accessoryId === accId);
        if (!accessory) return res.status(404).json({ message: 'Accessory not found' });
        if (accessory.pendingAction) {
            return res.status(400).json({ message: `This accessory already has a pending "${accessory.pendingAction}" request.` });
        }

        if (actionType === 'Transfer') {
            const onLeaveBlock = assertAssetNotOnLeaveForTransfer(asset);
            if (!onLeaveBlock.ok) {
                return res.status(400).json({ message: onLeaveBlock.message });
            }
        }

        const actorFlags = await getActorPermissionFlagsForAsset(req.user, asset);

        // Unattach: Asset Controller or Admin only (not assignee / assigner / delegated reportee).
        if (actionType === 'Unattach') {
            const isAdm = isJwtSystemSuperUser(req.user);
            const isAC = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);
            const currentEmpId = req.user.employeeObjectId?.toString();
            const acId = asset?.assetControllerId?.toString?.();
            const isAssetLinkedAC = !!(currentEmpId && acId && currentEmpId === acId);
            if (!isAdm && !isAC && !isAssetLinkedAC) {
                return res.status(403).json({ message: 'Access denied. Only Asset Controller or Admin can unattach accessories.' });
            }
        } else if (!actorFlags.canAct) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller/Admin, assigner, assigned user, or delegated primary reportee can request accessory actions.' });
        }

        // Resolve requester name from employee record (req.user doesn't carry firstName/lastName)
        const requesterEmp = await EmployeeBasic.findById(req.user.employeeObjectId).select('firstName lastName');
        const requesterName = requesterEmp ? `${requesterEmp.firstName} ${requesterEmp.lastName}` : req.user.employeeId || 'System';

        const assetController = await getDepartmentHOD('assetcontroller');
        if (!assetController) {
            return res.status(400).json({ message: 'Asset Controller not found. Cannot request approval.' });
        }

        let companyCoordinator = null;
        if (actionType === 'Loss and Damage' && asset.assignedToType === 'Company' && asset.assignedCompany) {
            companyCoordinator = await getCompanyAssetCoordinator();
            if (!companyCoordinator?._id) {
                return res.status(400).json({
                    message:
                        'No Assigned User or Admin in Flowchart. Cannot request loss and damage approval for company-assigned assets.'
                });
            }
        }

        const requesterId = (req.user.employeeObjectId || req.user._id).toString();
        const isAssetControllerRequester = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);
        const isControllerOrAdmin =
            requesterId === assetController?._id?.toString() ||
            isAssetControllerRequester ||
            isJwtSystemSuperUser(req.user);
        const currentEmpId = req.user.employeeObjectId?.toString();
        const assigneeId =
            asset.assignedToType === 'Employee' && asset.assignedTo
                ? (typeof asset.assignedTo === 'object' ? asset.assignedTo._id?.toString() : String(asset.assignedTo))
                : null;
        const isAssigneeRequester = !!(assigneeId && currentEmpId && assigneeId === currentEmpId);

        // Asset Controller/Admin can directly unattach without approval workflow.
        if (actionType === 'Unattach' && isControllerOrAdmin) {
            const accIndex = asset.accessories.findIndex(a => a._id.toString() === accId || a.accessoryId === accId);
            if (accIndex < 0) return res.status(404).json({ message: 'Accessory not found' });

            const accToMove = asset.accessories[accIndex].toObject();
            asset.accessories.splice(accIndex, 1);

            let catalogId = accToMove.accessoryId;
            let catalogRow = null;
            if (catalogId) {
                catalogRow = await AssetAccessoryCatalog.findOne({
                    recordType: 'catalog',
                    accessoryCatalogId: catalogId
                });
            }

            if (catalogRow) {
                catalogRow.status = 'Unattached';
                catalogRow.isActive = true;
                catalogRow.assetItemId = null;
                catalogRow.assetIdRef = '';
                catalogRow.history.push({
                    at: new Date(),
                    action: 'unattached',
                    message: `Returned to catalog from asset ${asset.assetId} — ${asset.name}`,
                    assetId: asset.assetId,
                    assetName: asset.name,
                    assetObjectId: asset._id
                });
                await catalogRow.save();
            } else {
                catalogId = catalogId || (await generateAccessoryCatalogId());
                await AssetAccessoryCatalog.create({
                    recordType: 'catalog',
                    accessoryCatalogId: catalogId,
                    name: accToMove.name,
                    price: accToMove.amount || 0,
                    description: accToMove.description || '',
                    status: 'Unattached',
                    isActive: true,
                    history: [{
                        at: new Date(),
                        action: 'unattached',
                        message: `Returned to catalog from asset ${asset.assetId} — ${asset.name}`,
                        assetId: asset.assetId,
                        assetName: asset.name,
                        assetObjectId: asset._id
                    }]
                });
            }

            asset.actionRequiredBy = null;
            asset.markModified('accessories');
            await asset.save();

            try {
                await markCatalogInstancesDetachedFromAsset(asset._id, [accToMove.accessoryId]);
                await syncAllAccessoryInstancesForAsset(asset);
            } catch (syncErr) {
            }

            await AssetHistory.create({
                assetId: asset._id,
                action: 'Accepted',
                performedBy: req.user.employeeObjectId || req.user._id,
                comments: `Accessory "${accToMove.name}" (${accToMove.accessoryId}) directly detached by Asset Controller/Admin and returned to catalog (${catalogId}). ${reason || ''}`,
                date: new Date(),
                details: { status: 'UnattachedDirect', accessoryId: accToMove.accessoryId, catalogId }
            });
            await removeAccessoryFromHistorySnapshots(asset._id, accToMove._id || accToMove.accessoryId);
            await notifyAssignedEmployeeIfController(req, asset, 'Unattach Accessory', `Accessory "${accToMove.name}" was directly detached by Asset Controller/Admin.`);

            return res.status(200).json({
                message: `Accessory "${accToMove.name}" detached and returned to catalog.`,
                asset
            });
        }

        let finalApprover;
        if (actionType === 'Unattach') {
            finalApprover = assetController;
        } else if (actionType === 'Loss and Damage' && asset.assignedToType === 'Company' && asset.assignedCompany) {
            finalApprover = companyCoordinator;
        } else {
            finalApprover = assetController;
        }

        let targetAssigneeForEmail = null;
        if (actionType === 'Transfer' && targetAssetId) {
            const targetAssetRow = await AssetItem.findById(targetAssetId)
                .populate({ path: 'assignedTo', populate: { path: 'primaryReportee' } })
                .select('assetId name assignedTo')
                .lean();
            targetAssigneeForEmail = targetAssetRow?.assignedTo || null;
        }

        if (actionType === 'Loss and Damage' || actionType === 'Transfer') {
            const emailCheck = await assertAssetActionStakeholderEmails({
                asset,
                assetController,
                companyCoordinator,
                targetAssignee: targetAssigneeForEmail,
            });
            if (!emailCheck.ok) {
                return res.status(400).json({ message: emailCheck.message });
            }
        }


        // Upload attachment if present
        let fileUrl = null;
        if (attachment && attachment.startsWith('data:')) {
            const uploadResult = await uploadDocumentToS3(attachment, 'asset-accessories');
            fileUrl = uploadResult.publicId;
        }

        // Store the pending request ON THE ACCESSORY
        accessory.pendingAction = actionType;
        accessory.pendingActionDetails = {
            reason: reason || null,
            attachment: fileUrl,
            fineData: fineData || null,
            targetAssetId: targetAssetId || null,
            requestedBy: req.user.employeeObjectId || req.user._id,
            requestedByRole:
                isAssetControllerRequester && !isAssigneeRequester
                    ? 'assetcontroller'
                    : isAssigneeRequester
                        ? 'assignee'
                        : 'admin',
            requestedAt: new Date(),
            isManagerApproved: false, // For multi-step Transfer
        };

        // actionRequiredBy references EmployeeBasic, so use EmployeeBasic._id
        asset.actionRequiredBy = finalApprover._id;
        asset.markModified('accessories');
        await asset.save();
        // Create Dashboard Action
        const accDashType = actionType === 'Transfer' ? 'Asset Transfer' :
            actionType === 'Unattach' ? 'Asset Accessory Unattach' :
                'Asset Loss Damage';
        await DashboardAction.create({
            assignedTo: finalApprover._id, // actionRequiredBy references EmployeeBasic
            requestId: asset._id,
            requestType: accDashType,
            status: 'Pending',
            subjectEmployeeId: asset.assignedTo?.employeeId || (asset.assignedCompany ? asset.assignedCompany.companyId : 'UNASSIGNED'),
            subjectName: asset.assignedTo ? `${asset.assignedTo.firstName} ${asset.assignedTo.lastName}` : (asset.assignedCompany ? asset.assignedCompany.name : 'Unassigned Asset (Accessory Action)'),
            requestedByName: requesterName,
            extra1: `${asset.assetId} — Accessory: ${accessory.name}`,
            extra2: actionType
        });

        // Log history
        await AssetHistory.create({
            assetId: asset._id,
            action: 'Comment',
            performedBy: req.user._id,
            comments: `Accessory "${accessory.name}" (${accessory.accessoryId}): "${actionType}" requested. Reason: ${reason || 'N/A'}`,
            date: new Date(),
            details: { type: 'AccessoryActionRequest', action: actionType, accessoryId: accessory.accessoryId }
        });

        // Send email (non-blocking — errors here won't crash the response)
        const emailActionLabel = actionType === 'Unattach' ? 'Unattach Accessory' : actionType;
        const accessoryLabel = `${accessory.name} (${accessory.accessoryId})`;
        try {
            let accAttachments = [];
            try {
                if (actionType === 'Transfer' && targetAssetId) {
                    const targetAssetRow = await AssetItem.findById(targetAssetId)
                        .populate({ path: 'assignedTo', populate: { path: 'primaryReportee', select: 'firstName lastName employeeId' } })
                        .select('assetId name assignedTo')
                        .lean();
                    const targetAssignee = targetAssetRow?.assignedTo;
                    const assignerForTransfer = await EmployeeBasic.findById(req.user.employeeObjectId)
                        .select('firstName lastName employeeId signature department')
                        .lean()
                        .catch(() => null);
                    const pdfAssetIds = [asset._id.toString(), String(targetAssetId)].filter(Boolean);
                    accAttachments = await buildAssignmentHandoverEmailAttachments(req, pdfAssetIds, {
                        assigneeName: targetAssignee
                            ? `${targetAssignee.firstName || ''} ${targetAssignee.lastName || ''}`.trim()
                            : 'Employee',
                        employeeCode: targetAssignee?.employeeId || '—',
                        department: (targetAssignee?.department && String(targetAssignee.department).trim()) || '—',
                        hodName: hodDisplayFromEmployee(targetAssignee),
                        assigner: assignerForTransfer,
                        filenameBase: 'accessory-transfer-request-handover',
                    });
                } else {
                    accAttachments = await buildApprovedActionHandoverAttachments(
                        req,
                        asset,
                        'asset-accessory-request-handover',
                    );
                }
            } catch (pdfErr) {
            }

            if (actionType === 'Loss and Damage' || actionType === 'Transfer') {
                await notifyLossDamageRequestStakeholders({
                    asset,
                    actionType: emailActionLabel,
                    approver: finalApprover,
                    requesterName,
                    reason: reason || 'No reason provided',
                    attachments: accAttachments,
                    accessoryLabel,
                    targetAssignee: targetAssigneeForEmail,
                });
            } else {
                await sendAssetActionApprovalEmail(
                    { ...asset.toObject(), assetId: asset.assetId, name: `${asset.name} - Accessory: ${accessoryLabel}` },
                    emailActionLabel,
                    finalApprover,
                    { name: requesterName },
                    reason || 'No reason provided',
                    accAttachments
                );
            }
        } catch (emailErr) {
        }

        res.status(200).json({
            message: `"${actionType}" request for accessory "${accessory.name}" sent to Asset Controller for approval.`,
            asset
        });
    } catch (error) {
        res.status(500).json({ message: 'Internal server error', detail: error.message });
    }
};

// @desc    Reportee responds to an accessory action (Accept or Reject)
// @route   PUT /api/AssetItem/:id/accessories/:accId/respond-action
// @access  Private
export const respondAccessoryAction = async (req, res) => {
    try {
        const { id, accId } = req.params;
        const { approve, comment, attachment, fineData } = req.body; // fineData can be provided when Asset Controller fills modal

        let fileUrl = null;
        if (approve && attachment && attachment.startsWith('data:')) {
            const uploadResult = await uploadDocumentToS3(attachment, 'asset-accessories');
            fileUrl = uploadResult.publicId;
        }

        const asset = await AssetItem.findById(id).populate({
            path: 'assignedTo',
            populate: [{ path: 'primaryReportee' }, { path: 'company' }]
        }).populate('assignedCompany');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const accessory = asset.accessories.find(a => a._id.toString() === accId || a.accessoryId === accId);
        if (!accessory) return res.status(404).json({ message: 'Accessory not found' });
        if (!accessory.pendingAction) return res.status(400).json({ message: 'No pending action on this accessory' });

        const { pendingAction, pendingActionDetails } = accessory;

        // Permission enforcement for accessory approvals:
        // - Transfer: assignee/assigner/delegated primaryReportee (actorFlags.canAct)
        // - Add (catalog): only the designated asset.actionRequiredBy (assignee or AC) or Admin
        // - Loss and Damage + End of Life + Unattach: only Asset Controller/Admin (workflow needs Fine creation)
        const actorFlags = await getActorPermissionFlagsForAsset(req.user, asset);
        const isAdmin = isJwtSystemSuperUser(req.user);
        const isAssetControllerApproving = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);
        const currentUserEmpIdEarly = req.user.employeeObjectId?.toString();
        const actionRequiredById =
            asset.actionRequiredBy?._id?.toString?.() || asset.actionRequiredBy?.toString?.() || null;
        const isDesignatedApprover = !!(currentUserEmpIdEarly && actionRequiredById && actionRequiredById === currentUserEmpIdEarly);

        const addApprovalKind = pendingActionDetails?.addApprovalKind || 'AssetController';
        const flowchartAssetController = await getDepartmentHOD('assetcontroller').catch(() => null);
        const normEmpId = (v) => String(v || '').trim().toLowerCase();
        const isDeptAssetController = !!(
            flowchartAssetController?._id &&
            currentUserEmpIdEarly &&
            flowchartAssetController._id.toString() === currentUserEmpIdEarly
        ) || !!(
            flowchartAssetController?.employeeId &&
            req.user?.employeeId &&
            normEmpId(flowchartAssetController.employeeId) === normEmpId(req.user.employeeId)
        );
        const canApproveTransfer = pendingAction === 'Transfer' && (isAdmin || isAssetControllerApproving || isDeptAssetController);
        const canApproveAddForAssignee =
            pendingAction === 'Add' &&
            addApprovalKind === 'Assignee' &&
            isDesignatedApprover &&
            (actorFlags.isAssignee || actorFlags.isPrimaryReporteeDelegate);
        const canApproveAddForAssetController =
            pendingAction === 'Add' &&
            addApprovalKind !== 'Assignee' &&
            (isAdmin || isAssetControllerApproving || isDeptAssetController);
        const canApproveAddPending = canApproveAddForAssignee || canApproveAddForAssetController;
        const canApproveByAuthority =
            (pendingAction === 'Loss and Damage' || pendingAction === 'End of Life' || pendingAction === 'Unattach') &&
            (isAdmin || isAssetControllerApproving || isDeptAssetController);

        const canApproveDesignatedLossDamage =
            pendingAction === 'Loss and Damage' && isDesignatedApprover;

        if (!canApproveTransfer && !canApproveAddPending && !canApproveByAuthority && !canApproveDesignatedLossDamage) {
            return res.status(403).json({
                message:
                    pendingAction === 'Add'
                        ? 'Access denied. Only the designated approver (or an administrator) can approve or reject this accessory addition.'
                        : 'Access denied. Only Asset Controller/Admin or the designated approver can approve or reject this accessory action.'
            });
        }

        const emailAccessoryDecisionToRequester = async (approved, reasonText = '') => {
            const requestedBy = pendingActionDetails?.requestedBy;
            if (!requestedBy) return;
            if (pendingAction !== 'Loss and Damage' && pendingAction !== 'Transfer') return;
            try {
                const requester = await EmployeeBasic.findById(requestedBy)
                    .select('firstName lastName employeeId companyEmail workEmail primaryReportee')
                    .populate('primaryReportee', 'firstName lastName companyEmail workEmail')
                    .lean();
                const approver = await EmployeeBasic.findById(req.user.employeeObjectId)
                    .select('firstName lastName employeeId companyEmail workEmail')
                    .lean();
                if (!requester?._id || !approver?._id) return;
                const accessoryLabel = `${accessory.name} (${accessory.accessoryId})`;
                if (pendingAction === 'Loss and Damage') {
                    await notifyLossDamageDecisionToRequester({
                        asset,
                        requestedBy: requester,
                        approver,
                        approved,
                        reason: reasonText,
                        accessoryLabel,
                    });
                } else if (pendingAction === 'Transfer') {
                    const { sendAssetLossDamageDecisionEmail } = await import('../utils/sendAssetLossDamageDecisionEmail.js');
                    await sendAssetLossDamageDecisionEmail({
                        asset,
                        recipient: requester,
                        approver,
                        approved,
                        reason: reasonText,
                        accessoryLabel,
                        displayAction: 'Transfer',
                    });
                }
            } catch (mailErr) {
            }
        };

        if (approve) {
            // If fineData is provided in request body (from modal submission), update pendingActionDetails
            if (fineData) {
                accessory.pendingActionDetails = accessory.pendingActionDetails || {};
                accessory.pendingActionDetails.fineData = fineData;
                // Update attachment if provided in fineData
                if (fineData.attachment?.data) {
                    const uploadResult = await uploadDocumentToS3(fineData.attachment.data, 'asset-accessories');
                    accessory.pendingActionDetails.attachment = uploadResult.publicId;
                }
                // Update reason/description if provided
                if (fineData.description) {
                    accessory.pendingActionDetails.reason = fineData.description;
                }
                asset.markModified('accessories');
                await asset.save();
            }
            const assetController = await getDepartmentHOD('assetcontroller');

            // Resolve current user's employee ObjectId and name
            // actionRequiredBy references EmployeeBasic, so use EmployeeBasic ObjectId for comparison
            const currentUserEmpId = currentUserEmpIdEarly;
            const actorEmp = await EmployeeBasic.findById(req.user.employeeObjectId).select('firstName lastName employeeId');
            const actorName = actorEmp ? `${actorEmp.firstName} ${actorEmp.lastName}` : req.user.employeeId || 'System';

            // --- SPECIAL LOGIC FOR TRANSFER ---
            // Transfer now only requires Asset Controller approval (no reportee/target employee acknowledgment)
            if (pendingAction === 'Transfer') {
                // Actor permission already validated via actorFlags above.
                // Transfer is allowed for assigner/assignee/delegated primary reportee too.

                const targetAssetId = pendingActionDetails?.targetAssetId;
                const targetAsset = await AssetItem.findById(targetAssetId).populate('assignedTo');

                if (!targetAsset || !targetAsset.assignedTo) {
                    return res.status(400).json({ message: 'Target asset or assigned employee not found for transfer.' });
                }

                // Execute the transfer immediately (no target employee acknowledgment needed)
                const accIndex = asset.accessories.findIndex(a => a._id.toString() === accId || a.accessoryId === accId);
                const accToMove = asset.accessories[accIndex].toObject();

                asset.accessories.splice(accIndex, 1);
                const { pendingAction: _pa, pendingActionDetails: _pad, _id: _oldId, ...cleanAcc } = accToMove;
                targetAsset.accessories.push({
                    ...cleanAcc,
                    status: 'Attached',
                    pendingAction: null,
                    pendingActionDetails: null,
                    _id: new mongoose.Types.ObjectId()
                });

                await targetAsset.save();

                // Capture snapshots for history records
                const sourceSnapshot = await AssetItem.findById(asset._id)
                    .populate('categoryId typeId acceptedBy accessories')
                    .populate({ path: 'assignedTo', populate: { path: 'primaryReportee' } })
                    .populate({ path: 'assignedBy', select: 'firstName lastName employeeId signature' });

                const targetSnapshot = await AssetItem.findById(targetAsset._id)
                    .populate('categoryId typeId acceptedBy accessories')
                    .populate({ path: 'assignedTo', populate: { path: 'primaryReportee' } })
                    .populate({ path: 'assignedBy', select: 'firstName lastName employeeId signature' });

                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Transfer',
                    performedBy: req.user.employeeObjectId,
                    comments: `Accessory "${accToMove.name}" transfer approved and finalized by Asset Controller (${actorName}). ${comment || ''}`,
                    date: new Date(),
                    details: { ...sourceSnapshot.toObject(), actionType: 'Transfer', accessoryName: accToMove.name }
                });

                // Log on target asset too
                await AssetHistory.create({
                    assetId: targetAsset._id,
                    action: 'Accepted',
                    performedBy: req.user.employeeObjectId,
                    comments: `Accessory "${accToMove.name}" received via transfer from ${asset.assetId}.`,
                    date: new Date(),
                    details: { ...targetSnapshot.toObject(), actionType: 'ReceivedTransfer', accessoryName: accToMove.name }
                });

                // Clean up source asset
                accessory.pendingAction = null;
                accessory.pendingActionDetails = null;
                asset.actionRequiredBy = null;
                await DashboardAction.deleteMany({ requestId: asset._id, requestType: 'Asset Transfer' });

                asset.markModified('accessories');
                await asset.save();

                try {
                    await markCatalogInstancesDetachedFromAsset(asset._id, [accToMove.accessoryId]);
                    await syncAllAccessoryInstancesForAsset(asset);
                    await syncAllAccessoryInstancesForAsset(targetAsset);
                } catch (syncErr) {
                }

                try {
                    await notifyAccessoryTransferApprovedEmails({
                        asset: sourceSnapshot || asset,
                        targetAsset: targetSnapshot || targetAsset,
                        accessoryName: accToMove.name,
                        performedBy: actorName,
                    });
                    if (targetAsset.assignedTo) {
                        const targetAssignee = await EmployeeBasic.findById(targetAsset.assignedTo)
                            .select('firstName lastName employeeId companyEmail workEmail email primaryReportee department')
                            .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail')
                            .lean();
                        const targetForEmail = await AssetItem.findById(targetAsset._id).populate('categoryId', 'name');
                        await sendAssetTransferHandoverEmails({
                            req,
                            asset: targetForEmail || targetAsset,
                            assetIds: [targetAsset._id.toString()],
                            targetEmployee: targetAssignee,
                            senderEmployeeId: req.user.employeeObjectId,
                            assignedToType: 'Employee',
                        });
                    }
                } catch (accTransferMailErr) {
                }

                void emailAccessoryDecisionToRequester(true, comment || '');

                return res.status(200).json({ message: `Transfer approved and finalized by Asset Controller. Accessory assigned to ${targetAsset.assetId}.`, asset });
            }

            // --- UNATTACH (Asset Controller / Admin): remove from asset, return row to catalog ---
            if (pendingAction === 'Unattach') {
                const accIndex = asset.accessories.findIndex(a => a._id.toString() === accId || a.accessoryId === accId);
                const accToMove = asset.accessories[accIndex].toObject();
                asset.accessories.splice(accIndex, 1);

                let catalogId = accToMove.accessoryId;
                let catalogRow = null;
                if (catalogId) {
                    catalogRow = await AssetAccessoryCatalog.findOne({
                        recordType: 'catalog',
                        accessoryCatalogId: catalogId
                    });
                }

                if (catalogRow) {
                    catalogRow.status = 'Unattached';
                    catalogRow.isActive = true;
                    catalogRow.assetItemId = null;
                    catalogRow.assetIdRef = '';
                    catalogRow.history.push({
                        at: new Date(),
                        action: 'unattached',
                        message: `Returned to catalog from asset ${asset.assetId} — ${asset.name}`,
                        assetId: asset.assetId,
                        assetName: asset.name,
                        assetObjectId: asset._id
                    });
                    await catalogRow.save();
                } else {
                    catalogId = catalogId || (await generateAccessoryCatalogId());
                    await AssetAccessoryCatalog.create({
                        recordType: 'catalog',
                        accessoryCatalogId: catalogId,
                        name: accToMove.name,
                        price: accToMove.amount || 0,
                        description: accToMove.description || '',
                        status: 'Unattached',
                        isActive: true,
                        history: [{
                            at: new Date(),
                            action: 'unattached',
                            message: `Returned to catalog from asset ${asset.assetId} — ${asset.name}`,
                            assetId: asset.assetId,
                            assetName: asset.name,
                            assetObjectId: asset._id
                        }]
                    });
                }

                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Accepted',
                    performedBy: req.user.employeeObjectId,
                    comments: `Accessory "${accToMove.name}" (${accToMove.accessoryId}) detached and returned to accessories catalog (${catalogId}). ${comment || ''}`,
                    date: new Date(),
                    details: { status: 'UnattachedToCatalog', accessoryId: accToMove.accessoryId, catalogId }
                });

                await removeAccessoryFromHistorySnapshots(asset._id, accToMove._id || accToMove.accessoryId);
                asset.actionRequiredBy = null;
                await DashboardAction.deleteMany({ requestId: asset._id, requestType: 'Asset Accessory Unattach' });
                asset.markModified('accessories');
                await asset.save();
                try {
                    await markCatalogInstancesDetachedFromAsset(asset._id, [accToMove.accessoryId]);
                    await syncAllAccessoryInstancesForAsset(asset);
                } catch (syncErr) {
                }

                // Exclude accessory from any active pending/draft fines associated with this asset
                try {
                    const Fine = (await import("../../models/Fine.js")).default;
                    const finesToUpdate = await Fine.find({
                        assetObjectId: asset._id,
                        fineStatus: { $in: ['Pending', 'Pending HR', 'Pending Review', 'Pending Accounts', 'Pending Finance', 'Pending Authorization', 'Draft'] }
                    });

                    for (const f of finesToUpdate) {
                        let fineModified = false;
                        let accAmtToRemove = 0;

                        // Check breakdownItems
                        if (f.breakdownItems && f.breakdownItems.length > 0) {
                            f.breakdownItems = f.breakdownItems.filter(item => {
                                const match = item.accessoryObjectId?.toString() === accToMove._id?.toString() ||
                                    item.accessoryId === accToMove.accessoryId;
                                if (match) {
                                    accAmtToRemove += parseFloat(item.amount || 0) || 0;
                                    fineModified = true;
                                }
                                return !match;
                            });
                        }

                        // Add to excludedAccessoryIds
                        if (fineModified) {
                            f.excludedAccessoryIds = Array.from(new Set([
                                ...(f.excludedAccessoryIds || []),
                                String(accToMove._id || accToMove.accessoryId)
                            ]));
                            f.accessoryExcludedAt = new Date();

                            // Recalculate fine amounts
                            if (accAmtToRemove > 0) {
                                const totalBase = (f.employeeAmount || 0) + (f.companyAmount || 0);
                                if (totalBase > 0) {
                                    const empRatio = (f.employeeAmount || 0) / totalBase;
                                    const compRatio = (f.companyAmount || 0) / totalBase;

                                    f.employeeAmount = Math.max(0, f.employeeAmount - (accAmtToRemove * empRatio));
                                    f.companyAmount = Math.max(0, f.companyAmount - (accAmtToRemove * compRatio));
                                } else {
                                    f.employeeAmount = 0;
                                    f.companyAmount = 0;
                                }

                                f.fineAmount = (f.employeeAmount || 0) + (f.companyAmount || 0) + (f.serviceCharge || 0);
                                f.totalFineAmount = f.fineAmount;

                                if (f.assignedEmployees && f.assignedEmployees.length > 0) {
                                    for (const emp of f.assignedEmployees) {
                                        if (emp.employeeId === 'VEGA-HR-0000') {
                                            emp.employeeAmount = f.companyAmount;
                                            emp.individualAmount = f.companyAmount;
                                            emp.fineAmount = f.companyAmount;
                                        } else {
                                            emp.employeeAmount = f.employeeAmount;
                                            emp.individualAmount = f.employeeAmount + (f.serviceCharge || 0);
                                            emp.fineAmount = f.employeeAmount + (f.serviceCharge || 0);
                                        }
                                    }
                                }
                            }

                            await f.save();
                            console.log(`[Unattach Accessory] Excluded accessory ${accToMove.accessoryId} from fine ${f.fineId}`);
                        }
                    }
                } catch (fineErr) {
                    console.error("Error updating associated fines on accessory unattach:", fineErr);
                }

                await notifyAssignedEmployeeIfController(req, asset, 'Unattach Accessory', `Accessory "${accToMove.name}" was detached and added to the accessories catalog.`);

                return res.status(200).json({
                    message: `Accessory "${accToMove.name}" detached and returned to the accessories catalog.`,
                    asset
                });
            }

            // --- SPECIAL LOGIC FOR ADD APPROVAL (catalog attach) — approver is asset.actionRequiredBy (assignee or AC) ---
            if (pendingAction === 'Add') {
                const catalogItemId = accessory?.pendingActionDetails?.catalogItemId;
                const addKindForEmail = pendingActionDetails?.addApprovalKind;
                const addRequestedByForEmail = pendingActionDetails?.requestedBy;
                // Keep catalog ACC ID as canonical accessoryId everywhere in asset flows.
                if ((!accessory.accessoryId || !String(accessory.accessoryId).trim()) && catalogItemId) {
                    const catalogDoc = await AssetAccessoryCatalog.findById(catalogItemId)
                        .select('accessoryCatalogId')
                        .lean()
                        .catch(() => null);
                    if (catalogDoc?.accessoryCatalogId) {
                        accessory.accessoryId = String(catalogDoc.accessoryCatalogId).trim();
                    }
                }
                accessory.status = 'Attached';
                accessory.pendingAction = null;
                accessory.pendingActionDetails = null;

                const approvedByLabel = isAssetControllerApproving ? 'Asset Controller' : 'assigned employee';
                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Accepted',
                    performedBy: req.user.employeeObjectId,
                    comments: `New accessory "${accessory.name}" addition approved by ${approvedByLabel} (${actorName}). ${comment || ''}`,
                    date: new Date(),
                    details: { status: 'Attached', action: 'AddApproval', accessoryId: accId }
                });
                if (catalogItemId) {
                    await AssetAccessoryCatalog.findByIdAndUpdate(
                        catalogItemId,
                        {
                            $set: { isActive: false, status: 'Attached' },
                            $push: {
                                history: {
                                    at: new Date(),
                                    action: 'attached',
                                    message: `Attached to asset ${asset.assetId} — ${asset.name}`,
                                    assetId: asset.assetId,
                                    assetName: asset.name,
                                    assetObjectId: asset._id
                                }
                            }
                        }
                    ).catch(() => null);
                }

                // Check if any other accessories on this asset still have 'Add' pending
                const otherPendingAdds = asset.accessories.some(a => a.pendingAction === 'Add');
                if (!otherPendingAdds) {
                    asset.actionRequiredBy = null;
                    await DashboardAction.deleteMany({ requestId: asset._id, requestType: 'Asset Accessory Approval' });
                }

                asset.markModified('accessories');
                await asset.save();

                try {
                    await syncAllAccessoryInstancesForAsset(asset);
                } catch (syncErr) {
                }

                try {
                    if (addKindForEmail === 'Assignee' && addRequestedByForEmail) {
                        const requesterEmp = await EmployeeBasic.findById(addRequestedByForEmail)
                            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                            .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
                            .lean();
                        if (requesterEmp) {
                            await sendAssignedEmployeeActionEmail({
                                asset,
                                employee: requesterEmp,
                                action: 'Add Accessory',
                                performedBy: actorName,
                                details: `Assigned user approved accessory "${accessory.name}"; it is now attached to the asset.`,
                                customIntro: 'The holder accepted the accessory addition you initiated:'
                            });
                        }
                    } else if (asset.assignedTo) {
                        const assigneeEmp = await EmployeeBasic.findById(asset.assignedTo._id || asset.assignedTo)
                            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                            .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
                            .lean();
                        if (assigneeEmp) {
                            await sendAssignedEmployeeActionEmail({
                                asset,
                                employee: assigneeEmp,
                                action: 'Add Accessory',
                                performedBy: actorName,
                                details: `Accessory "${accessory.name}" was added and is now attached.`,
                                customIntro: 'The accessory addition was approved. Your asset was updated:'
                            });
                        }
                    }
                } catch (e) {
                }

                return res.status(200).json({
                    message: `Accessory "${accessory.name}" added successfully.`,
                    asset
                });
            }

            // --- EXISTING LOGIC FOR L&D / EOL ---
            // (isAssetControllerApproving is already resolved above; do not redeclare here — it shadows and TDZ-breaks the Add branch.)
            const isCompanyAsset = asset.assignedToType === 'Company' && asset.assignedCompany;
            const isCompanyCoordinatorUserAccessoryLd = await isUserCompanyAssetCoordinator(req.user).catch(() => false);

            if (
                pendingAction === 'Loss and Damage' &&
                isCompanyAsset &&
                isCompanyCoordinatorUserAccessoryLd &&
                !isAssetControllerApproving &&
                !isAdmin &&
                isDesignatedApprover
            ) {
                const assetControllerFwd = await getDepartmentHOD('assetcontroller');
                if (!assetControllerFwd?._id) {
                    return res.status(400).json({
                        message: 'Asset Controller is not configured. Cannot route accessory loss/damage after company approval.'
                    });
                }
                asset.actionRequiredBy = assetControllerFwd._id;
                asset.markModified('accessories');
                await asset.save();

                await DashboardAction.findOneAndUpdate(
                    {
                        requestId: asset._id,
                        status: 'Pending',
                        requestType: 'Asset Loss Damage'
                    },
                    {
                        $set: {
                            assignedTo: assetControllerFwd._id,
                            assignedToEmpId: assetControllerFwd.employeeId
                        }
                    },
                    { new: true }
                ).catch(() => null);

                try {
                    let accFwdPdf = [];
                    try {
                        accFwdPdf = await buildApprovedActionHandoverAttachments(
                            req,
                            asset,
                            'accessory-ld-company-approved-handover',
                        );
                    } catch (pdfErr) {
                    }
                    await sendAssetActionApprovalEmail(
                        {
                            ...asset.toObject(),
                            assetId: asset.assetId,
                            name: `${asset.name} - Accessory: ${accessory.name} (${accessory.accessoryId})`
                        },
                        pendingAction,
                        assetControllerFwd,
                        { name: actorName },
                        `Company coordinator approved accessory loss/damage. Asset Controller must complete fine details for "${accessory.name}".`,
                        accFwdPdf
                    );
                } catch (e) {
                }

                void emailAccessoryDecisionToRequester(true, comment || 'Company coordinator approved; pending Asset Controller fine details.');

                return res.status(200).json({
                    message:
                        'Approved by company coordinator. Pending Asset Controller to enter fine details for this accessory loss/damage.',
                    asset,
                    forwardedToAssetController: true
                });
            }

            // For "Loss and Damage", Asset Controller approval creates Fine with status "Pending HR"
            if (isAssetControllerApproving && pendingAction === 'Loss and Damage') {
                // Check if fineData is provided - if not, return accessory data for modal
                if (!pendingActionDetails?.fineData) {
                    // Return accessory data so frontend can open modal for Asset Controller to fill fine data
                    return res.status(200).json({
                        message: 'Approval pending. Please fill in fine details.',
                        requiresFineData: true,
                        accessory: {
                            _id: accessory._id,
                            accessoryId: accessory.accessoryId,
                            name: accessory.name,
                            amount: accessory.amount,
                            pendingActionDetails: accessory.pendingActionDetails
                        },
                        asset: {
                            _id: asset._id,
                            assetId: asset.assetId,
                            name: asset.name,
                            assignedTo: asset.assignedTo,
                            assignedCompany: asset.assignedCompany,
                            assignedToType: asset.assignedToType
                        }
                    });
                }

                if (pendingActionDetails?.fineData) {
                    try {
                        const Fine = (await import('../models/Fine.js')).default;
                        const User = (await import('../models/User.js')).default;
                        const { syncDashboardAction } = await import('../utils/syncDashboard.js');
                        const fd = pendingActionDetails.fineData;
                        const uniqueFineId = await generateFineIdInternal();

                        // Validate full fine tracker flow before creating L&D fine
                        const trackerValidation = await validateFineTrackerFlowchart();
                        if (!trackerValidation.ok) {
                            return res.status(400).json({ message: trackerValidation.message });
                        }
                        const hrHOD = trackerValidation.hrHOD;

                        const hrUser = await User.findOne({ employeeId: hrHOD.employeeId });
                        const hrAssignmentId = hrUser ? hrUser._id : hrHOD._id;

                        const { employees, ...cleanFd } = fd;
                        const fineModel = new Fine({
                            ...cleanFd,
                            assignedEmployees: employees || fd.assignedEmployees || [],
                            company: asset.assignedTo?.company?._id || fd.company,
                            companyName: asset.assignedTo?.company?.name || fd.companyName || '',
                            fineId: uniqueFineId,
                            fineStatus: 'Pending HR',
                            approvalStatus: 'Pending HR',
                            submittedTo: hrAssignmentId,
                            workflow: [{
                                role: 'HR',
                                assignedTo: hrAssignmentId,
                                status: 'Pending',
                                assignedAt: new Date()
                            }],
                            createdBy: req.user._id,
                            awardedDate: new Date(),
                            assetId: asset.assetId,
                            assetObjectId: asset._id,
                            // Store accessory identity so Fine pages can show accessory-specific fines
                            accessoryId: accessory.accessoryId,
                            accessoryName: accessory.name,
                            accessoryObjectId: accessory._id,
                            attachment: fileUrl ? { url: fileUrl, name: 'L&D Photo.pdf', mimeType: 'application/pdf' } : (pendingActionDetails.attachment ? { url: pendingActionDetails.attachment, name: 'L&D Photo.pdf', mimeType: 'application/pdf' } : fd.attachment)
                        });
                        await fineModel.save();

                        // Sync Dashboard Action for Fine
                        const targetEmpId = fineModel.assignedEmployees?.[0]?.employeeId || asset.assignedTo?.employeeId;
                        if (targetEmpId) {
                            const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
                            const subjectEmp = await EmployeeBasic.findOne({ employeeId: targetEmpId });
                            await syncDashboardAction({
                                requestId: fineModel._id,
                                requestType: 'Fine',
                                assignedTo: hrAssignmentId,
                                status: 'Pending',
                                subjectEmployee: subjectEmp,
                                requestedByName: req.user.name || '',
                                extra1: fineModel.fineType || 'Loss & Damage',
                                extra2: `AED ${fineModel.fineAmount || 0}`
                            });
                        }

                        // Send fine approval email
                        try {
                            const { sendFineApprovalEmail } = await import('../utils/sendFineApprovalEmail.js');
                            await sendFineApprovalEmail(fineModel, fineModel.assignedEmployees || []);
                        } catch (emailErr) {
                        }


                        // Create history log
                        await AssetHistory.create({
                            assetId: asset._id,
                            action: 'Comment',
                            performedBy: req.user.employeeObjectId,
                            comments: `Asset Controller approved accessory "${accessory.name}" "${pendingAction}". Fine created (${uniqueFineId}) with status Pending HR. ${comment || ''}`,
                            date: new Date(),
                            details: { status: 'AssetControllerApproved', originalAction: pendingAction, accessoryId: accessory.accessoryId, fineId: uniqueFineId }
                        });

                        // Detach accessory from asset (lost / L&D finalized). Fine + catalog carry the record forward.
                        const accIdx = asset.accessories.findIndex(
                            (a) => a._id?.toString() === accId || a.accessoryId === accId
                        );
                        if (accIdx < 0) {
                            return res.status(404).json({ message: 'Accessory not found' });
                        }
                        const accToDetach = asset.accessories[accIdx].toObject();

                        if (asset.assignedTo) {
                            try {
                                const { sendAssetLostOwnerEmail } = await import('../utils/sendAssetLostOwnerEmail.js');
                                await sendAssetLostOwnerEmail({
                                    asset,
                                    employee: asset.assignedTo,
                                    lossValue: fineModel.fineAmount,
                                    accessoryName: accToDetach.name,
                                    fineId: uniqueFineId,
                                });
                            } catch (mailErr) {
                            }
                        }

                        asset.accessories.splice(accIdx, 1);
                        asset.actionRequiredBy = null;

                        asset.lostDetachedAccessories = asset.lostDetachedAccessories || [];
                        asset.lostDetachedAccessories.push({
                            accessoryId: accToDetach.accessoryId || '',
                            name: accToDetach.name || '',
                            amount: accToDetach.amount || 0,
                            fineId: uniqueFineId,
                            detachedAt: new Date()
                        });

                        await AssetAccessoryCatalog.updateMany(
                            { recordType: 'instance', assetItemId: asset._id, assetAccessoryId: accToDetach.accessoryId },
                            { $set: { status: 'Lost', assetItemId: null, assetIdRef: '' } }
                        ).catch(() => null);

                        let catalogId = accToDetach.accessoryId;
                        let catalogRow = null;
                        if (catalogId) {
                            catalogRow = await AssetAccessoryCatalog.findOne({
                                recordType: 'catalog',
                                accessoryCatalogId: catalogId
                            });
                        }

                        if (catalogRow) {
                            catalogRow.status = 'Lost';
                            catalogRow.isActive = false;
                            catalogRow.assetItemId = null;
                            catalogRow.assetIdRef = '';
                            catalogRow.history.push({
                                at: new Date(),
                                action: 'removed',
                                message: `Loss and damage — detached from asset ${asset.assetId} — ${asset.name} (fine ${uniqueFineId})`,
                                assetId: asset.assetId,
                                assetName: asset.name,
                                assetObjectId: asset._id
                            });
                            await catalogRow.save();
                        } else {
                            catalogId = catalogId || (await generateAccessoryCatalogId());
                            await AssetAccessoryCatalog.create({
                                recordType: 'catalog',
                                accessoryCatalogId: catalogId,
                                name: accToDetach.name,
                                price: accToDetach.amount || 0,
                                description: accToDetach.description || '',
                                status: 'Lost',
                                isActive: false,
                                history: [{
                                    at: new Date(),
                                    action: 'removed',
                                    message: `Loss and damage — detached from asset ${asset.assetId} — ${asset.name} (fine ${uniqueFineId})`,
                                    assetId: asset.assetId,
                                    assetName: asset.name,
                                    assetObjectId: asset._id
                                }]
                            });
                        }

                        // Delete Dashboard Action for accessory
                        await DashboardAction.deleteMany({ requestId: asset._id, requestType: 'Asset Loss Damage' });

                        asset.markModified('accessories');
                        asset.markModified('lostDetachedAccessories');
                        await asset.save();
                        try {
                            await syncAllAccessoryInstancesForAsset(asset);
                        } catch (syncErr) {
                        }
                        await notifyAssignedEmployeeIfController(req, asset, 'Loss and Damage Accessory', `Accessory "${accToDetach.name}" loss and damage was approved by Asset Controller and moved to Pending HR.`);

                        void emailAccessoryDecisionToRequester(true, comment || '');

                        // Sync History (remove from previous handover docs/snapshots)
                        await removeAccessoryFromHistorySnapshots(asset._id, accToDetach._id || accToDetach.accessoryId);

                        return res.status(200).json({
                            message: `Approved by Asset Controller. Fine created (${uniqueFineId}) with status Pending HR.`,
                            asset,
                            fineId: uniqueFineId
                        });
                    } catch (fineErr) {
                        return res.status(500).json({ message: 'Failed to create fine. Please try again.', error: fineErr.message });
                    }
                } else {
                    return res.status(400).json({ message: 'Fine data not provided. Cannot create fine for Loss and Damage.' });
                }
            }

            // For End of Life, Asset Controller approval is final
            if (isAssetControllerApproving && pendingAction === 'End of Life') {
                const accName = accessory.name;
                const accCode = accessory.accessoryId;
                accessory.status = 'End of Life';
                if (!accessory.lostAt) accessory.lostAt = new Date();
                accessory.pendingAction = null;
                accessory.pendingActionDetails = null;
                asset.actionRequiredBy = null;

                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'End of Life',
                    performedBy: req.user.employeeObjectId,
                    comments: `Accessory "${accName}" (${accCode}) End of Life finalized by Asset Controller. ${comment || ''}`,
                    date: new Date(),
                    details: { status: 'ApprovedAndFinalized', originalAction: pendingAction, accessoryId: accessory.accessoryId }
                });

                await DashboardAction.deleteMany({ requestId: asset._id, requestType: 'Asset End of Life' });
                asset.markModified('accessories');
                await asset.save();
                await notifyAssignedEmployeeIfController(req, asset, 'End of Life Accessory', `Accessory "${accName}" was marked End of Life by Asset Controller.`);

                // Sync History (remove from previous handover docs/snapshots)
                await removeAccessoryFromHistorySnapshots(asset._id, accessory._id || accessory.accessoryId);

                return res.status(200).json({ message: `Accessory "${accName}" marked as End of Life.`, asset });
            }

            // Legacy HR approval step (for edge cases or company assets) - removed for Loss and Damage
            // STEP 2 APPROVED (HR) or single step finalization (for EOL only now)
            if (pendingAction !== 'Transfer' && pendingAction !== 'Loss and Damage') {
                // Execute the action (EOL) immediately
                const accName = accessory.name;
                const accCode = accessory.accessoryId;

                if (pendingAction === 'End of Life') {
                    accessory.status = 'End of Life';
                    if (!accessory.lostAt) accessory.lostAt = new Date();
                    accessory.pendingAction = null;
                    accessory.pendingActionDetails = null;
                    asset.actionRequiredBy = null;

                    await AssetHistory.create({
                        assetId: asset._id,
                        action: 'End of Life',
                        performedBy: req.user.employeeObjectId,
                        comments: `Accessory "${accName}" (${accCode}) End of Life finalized by HR. ${comment || ''}`,
                        date: new Date(),
                        details: { status: 'ApprovedAndFinalized', originalAction: pendingAction, accessoryId: accessory.accessoryId }
                    });

                    await DashboardAction.deleteMany({ requestId: asset._id, requestType: 'Asset End of Life' });
                    asset.markModified('accessories');
                    await asset.save();
                    await notifyAssignedEmployeeIfController(req, asset, 'End of Life Accessory', `Accessory "${accName}" was marked End of Life by authority.`);
                    return res.status(200).json({ message: `Accessory "${accName}" marked as End of Life.`, asset });
                }
            }
        } else {
            // Rejected
            if (pendingAction === 'Add') {
                const catalogItemId = accessory?.pendingActionDetails?.catalogItemId;
                const addKindReject = accessory?.pendingActionDetails?.addApprovalKind;
                const addRequestedByReject = accessory?.pendingActionDetails?.requestedBy;
                const accIndex = asset.accessories.findIndex(
                    (a) => (a._id && a._id.toString() === accId) || a.accessoryId === accId
                );
                const accName = accessory.name;
                if (accIndex >= 0) {
                    asset.accessories.splice(accIndex, 1);
                }
                if (catalogItemId) {
                    await AssetAccessoryCatalog.findByIdAndUpdate(
                        catalogItemId,
                        {
                            $set: { status: 'Unattached' },
                            $push: {
                                history: {
                                    at: new Date(),
                                    action: 'attach_rejected',
                                    message: `Attach request rejected (asset ${asset.assetId} — ${asset.name})`,
                                    assetId: asset.assetId,
                                    assetName: asset.name,
                                    assetObjectId: asset._id
                                }
                            }
                        }
                    ).catch(() => null);
                }
                const rejectByLabel = isAssetControllerApproving ? 'Asset Controller' : 'assigned employee';
                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Comment',
                    performedBy: req.user.employeeObjectId || req.user._id,
                    comments: `New accessory "${accName}" addition rejected by ${rejectByLabel}. Reason: ${comment || 'N/A'}`,
                    date: new Date(),
                    details: { action: 'AddRejection', accessoryId: accId }
                });
                const otherPendingAdds = asset.accessories.some((a) => a.pendingAction === 'Add');
                if (!otherPendingAdds) {
                    asset.actionRequiredBy = null;
                    await DashboardAction.deleteMany({ requestId: asset._id, requestType: 'Asset Accessory Approval' });
                }
                asset.markModified('accessories');
                await asset.save();

                try {
                    const actorEmpReject = await EmployeeBasic.findById(req.user.employeeObjectId)
                        .select('firstName lastName employeeId')
                        .lean();
                    const rejectActorName = actorEmpReject
                        ? `${actorEmpReject.firstName || ''} ${actorEmpReject.lastName || ''}`.trim()
                        : req.user.employeeId || 'System';

                    if (addKindReject === 'Assignee' && addRequestedByReject) {
                        const requesterEmp = await EmployeeBasic.findById(addRequestedByReject)
                            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                            .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
                            .lean();
                        if (requesterEmp) {
                            await sendAssignedEmployeeActionEmail({
                                asset,
                                employee: requesterEmp,
                                action: 'Add Accessory',
                                performedBy: rejectActorName,
                                details: `Accessory "${accName}" was rejected by the assigned user. Reason: ${comment || 'N/A'}`,
                                customIntro: 'The holder did not accept this accessory addition:'
                            });
                        }
                    } else if (asset.assignedTo) {
                        const assigneeEmp = await EmployeeBasic.findById(asset.assignedTo._id || asset.assignedTo)
                            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                            .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
                            .lean();
                        if (assigneeEmp) {
                            await sendAssignedEmployeeActionEmail({
                                asset,
                                employee: assigneeEmp,
                                action: 'Add Accessory',
                                performedBy: rejectActorName,
                                details: `Accessory "${accName}" addition was rejected. Reason: ${comment || 'N/A'}`,
                                customIntro: 'The accessory addition was not approved:'
                            });
                        }
                    }
                } catch (e) {
                }

                return res.status(200).json({
                    message: `Accessory addition rejected and removed.`,
                    asset
                });
            }

            accessory.pendingAction = null;
            accessory.pendingActionDetails = null;
            asset.actionRequiredBy = null;
            const dashTypeByPending = {
                Transfer: 'Asset Transfer',
                'Loss and Damage': 'Asset Loss Damage',
                'End of Life': 'Asset End of Life',
                Unattach: 'Asset Accessory Unattach',
                Add: 'Asset Accessory Approval'
            };
            const accessoryLossDamageRejectRequesterId =
                pendingAction === 'Loss and Damage' ? pendingActionDetails?.requestedBy : null;
            const accessoryRejectLabel =
                pendingAction === 'Loss and Damage'
                    ? `${accessory.name} (${accessory.accessoryId})`
                    : '';

            const rt = dashTypeByPending[pendingAction];
            if (rt) {
                await DashboardAction.deleteMany({ requestId: asset._id, requestType: rt });
            } else {
                await DashboardAction.deleteMany({ requestId: asset._id });
            }

            await AssetHistory.create({
                assetId: asset._id,
                action: 'Comment',
                performedBy: req.user._id,
                comments: `Accessory action "${pendingAction}" for "${accessory.name}" rejected by authority (${req.user.employeeId || 'unknown'}). Reason: ${comment || 'N/A'}`,
                date: new Date(),
                details: { status: 'RejectedByAuthority', originalAction: pendingAction, accessoryId: accId }
            });

            void emailAccessoryDecisionToRequester(false, comment || '');

            if (accessoryLossDamageRejectRequesterId) {
                const rejectorId = req.user.employeeObjectId?.toString();
                const requesterIdStr = accessoryLossDamageRejectRequesterId?.toString?.();
                if (requesterIdStr && requesterIdStr !== rejectorId) {
                    const reviewerEmp = await EmployeeBasic.findById(req.user.employeeObjectId)
                        .select('firstName lastName employeeId')
                        .lean()
                        .catch(() => null);
                    const reviewerDisplayName = reviewerEmp
                        ? `${reviewerEmp.firstName || ''} ${reviewerEmp.lastName || ''}`.trim() || reviewerEmp.employeeId
                        : req.user.name || 'Asset Controller';
                    void notifyLossDamageRejectedToRequester({
                        asset,
                        requesterId: accessoryLossDamageRejectRequesterId,
                        reviewerDisplayName,
                        actionedBy: req.user.employeeObjectId || req.user._id,
                        rejectReason: comment || '',
                        accessoryLabel: accessoryRejectLabel,
                    });
                }
            }
        }

        asset.markModified('accessories');
        await asset.save();
        await notifyAssignedEmployeeIfController(req, asset, `${pendingAction} Accessory`, approve ? `Accessory action "${pendingAction}" was approved.` : `Accessory action "${pendingAction}" was rejected.`);

        res.status(200).json({
            message: approve ? `Action approved and finalized.` : `Action rejected`,
            asset
        });
    } catch (error) {
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Finalize Accessory Action (Reportee Acknowledgement)
// @route   PUT /api/AssetItem/:id/accessories/:accId/finalize-action
// @access  Private (Assigned User)
export const finalizeAccessoryAction = respondAccessoryAction;

/**
 * @desc    Save Loss & Damage fine form as draft (asset flow; no workflow started)
 * @route   PUT /api/AssetItem/:id/loss-damage-fine-draft
 * @access  Private (same actors as request-action)
 */
export const saveLossDamageFineDraft = async (req, res) => {
    try {
        const { id } = req.params;
        const { fineData, accessoryObjectId } = req.body;

        if (!fineData || typeof fineData !== 'object') {
            return res.status(400).json({ message: 'Fine form data is required.' });
        }

        const asset = await AssetItem.findById(id).populate({
            path: 'assignedTo',
            populate: { path: 'primaryReportee' }
        }).populate('assignedCompany');

        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        if (asset.pendingAction) {
            return res.status(400).json({
                message: `Cannot save a draft while "${asset.pendingAction}" is pending approval.`
            });
        }

        const actorFlags = await getActorPermissionFlagsForAsset(req.user, asset);
        if (!actorFlags.isAssetController) {
            return res.status(403).json({
                message: 'Only Asset Controller can save Loss & Damage fine drafts.',
            });
        }

        const draftPayload = {
            ...fineData,
            savedAt: new Date(),
            savedBy: req.user.employeeObjectId || req.user._id
        };

        if (accessoryObjectId) {
            const accessory = asset.accessories.find(
                (a) => a._id?.toString() === String(accessoryObjectId) || a.accessoryId === accessoryObjectId
            );
            if (!accessory) {
                return res.status(404).json({ message: 'Accessory not found' });
            }
            if (accessory.pendingAction) {
                return res.status(400).json({
                    message: `Cannot save a draft while accessory "${accessory.name}" has a pending "${accessory.pendingAction}" request.`
                });
            }
            accessory.lossDamageFineDraft = draftPayload;
        } else {
            asset.lossDamageFineDraft = draftPayload;
        }

        await asset.save();

        return res.json({
            message: 'Loss & Damage form saved as draft.',
            asset
        });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to save Loss & Damage draft.' });
    }
};

/**
 * @desc    Submit a saved draft for creation approval (notify Asset Controller)
 * @route   PUT /api/AssetItem/:id/submit-creation
 * @access  Private (Creator or Admin)
 */
export const submitDraftForCreationApproval = async (req, res) => {
    try {
        const { id } = req.params;
        const item = await AssetItem.findById(id);
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const canSubmitFrom =
            (item.status === 'Draft' || item.status === 'Rejected') && !item.actionRequiredBy;
        if (!canSubmitFrom) {
            return res.status(400).json({
                message:
                    'Only a saved draft, or a rejected creation that is not awaiting approval, can be submitted again.'
            });
        }

        const currentUserId = req.user._id?.toString() || req.user.id?.toString();
        const isCreator = item.createdBy?.toString() === currentUserId;
        const isJwtAdmin = isJwtSystemSuperUser(req.user);
        const isSysAdmin = await isUserAdministrator(req.user?.id);
        if (!isCreator && !isJwtAdmin && !isSysAdmin) {
            return res.status(403).json({ message: 'Only the asset creator or an administrator can submit this draft.' });
        }

        const fleetVehicle = isFleetVehicleAssetFields({ plateNumber: item.plateNumber });
        const previousStatusForHistory = item.status;

        if (fleetVehicle) {
            item.status = 'Unassigned';
            item.actionRequiredBy = null;
            item.creationReturnedToDraftAt = null;
            if (!item.vehicleProfileActivationStatus) {
                item.vehicleProfileActivationStatus = 'inactive';
            }
            await item.save();

            await AssetHistory.create({
                assetId: item._id,
                action: 'Comment',
                performedBy: req.user.employeeObjectId || req.user._id,
                comments: 'Vehicle draft published to fleet list (no creation approval required).',
                details: { previousStatus: previousStatusForHistory, newStatus: 'Unassigned' },
                date: new Date(),
            });

            return res.status(200).json(item);
        }

        const approverLabel = creationApproverRoleLabel({ plateNumber: item.plateNumber });
        const creationApprover = await resolveAssetCreationApproverEmployee({ plateNumber: item.plateNumber });
        if (!creationApprover?._id) {
            return res.status(400).json({ message: `${approverLabel} is not configured in Flowchart.` });
        }

        item.status = 'Submitted for Approval';
        item.actionRequiredBy = creationApprover._id;
        item.creationReturnedToDraftAt = null;
        await item.save();

        const requesterDisplayName = await getAssetRequesterDisplayName(req);

        const creatorEmp = await resolveAssetCreatorEmployee(item.createdBy);

        if (creatorEmp?._id) {
            await DashboardAction.updateMany(
                {
                    requestId: item._id,
                    requestType: 'Asset Approval',
                    status: 'Rejected',
                    assignedTo: creatorEmp._id,
                },
                {
                    status: 'Approved',
                    actionedDate: new Date(),
                    actionedBy: req.user?.employeeObjectId || req.user?._id,
                    comment: 'Creator resubmitted for approval',
                },
            );
        }

        await DashboardAction.findOneAndUpdate(
            { requestId: item._id, requestType: 'Asset Approval', status: 'Pending' },
            {
                assignedTo: creationApprover._id,
                assignedToEmpId: creationApprover.employeeId,
                requestId: item._id,
                requestType: 'Asset Approval',
                subjectEmployeeId: req.user.employeeId,
                subjectName: requesterDisplayName,
                requestedByName: requesterDisplayName,
                extra1: `${item.assetId} — ${item.name}`,
                extra2: fleetVehicle
                    ? `Vehicle creation — HR review (${requesterDisplayName})`
                    : `Asset creation — requested by ${requesterDisplayName}`,
                extra3: JSON.stringify({
                    isFleetVehicle: fleetVehicle,
                    vehicleMongoId: fleetVehicle ? String(item._id) : undefined,
                }),
                status: 'Pending'
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        let creationAttachments = [];
        try {
            const requester = req.user.employeeObjectId
                ? await EmployeeBasic.findById(req.user.employeeObjectId)
                    .select('firstName lastName signature employeeId department')
                    .lean()
                : null;
            creationAttachments = await buildCreationRequestHandoverAttachments(req, [item._id.toString()], {
                assigner: requester,
                assignerName: requesterDisplayName,
            });
        } catch (pdfErr) {
        }
        await sendAssetCreationApprovalEmail({
            asset: item,
            recipient: creationApprover,
            creatorName: requesterDisplayName,
            attachments: creationAttachments
        });

        await AssetHistory.create({
            assetId: item._id,
            action: 'Comment',
            performedBy: req.user.employeeObjectId || req.user._id,
            comments:
                previousStatusForHistory === 'Rejected'
                    ? 'Rejected asset resubmitted for creation approval.'
                    : 'Draft submitted for creation approval.',
            details: { previousStatus: previousStatusForHistory, newStatus: 'Submitted for Approval' },
            date: new Date()
        });

        res.status(200).json(item);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

/**
 * @desc    Delete an asset item
 * @route   DELETE /api/AssetItem/:id
 * @access  Private (Asset Controller, Admin, or Creator before approval)
 */
export const deleteAssetItem = async (req, res) => {
    try {
        const { id } = req.params;

        const asset = await AssetItem.findById(id).populate('typeId', 'name');
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const {
            canHardDeleteFleetVehicle,
            performVehicleHardDelete,
            userHasVehicleDeletePermission,
            isReqAdmin,
        } = await import('./vehicleDeleteController.js');
        const { isFleetVehicleAsset } = await import('../utils/assetApprovalHelpers.js');

        if (isFleetVehicleAsset(asset)) {
            const gate = await canHardDeleteFleetVehicle(req, asset);
            if (!gate.ok) {
                if (gate.reason === 'needs_hr_approval') {
                    return res.status(403).json({
                        message:
                            'Active vehicles require HR approval to delete. Submit a delete request instead.',
                        needsHrApproval: true,
                        useRequestDelete: true,
                    });
                }
                return res.status(403).json({
                    message: 'You do not have permission to delete this vehicle.',
                });
            }
            try {
                const result = await performVehicleHardDelete(req, asset);
                return res.status(200).json(result);
            } catch (err) {
                return res.status(err.statusCode || 500).json({
                    message: err.message || 'Server Error',
                    ...(err.accessoriesCount != null ? { accessoriesCount: err.accessoriesCount } : {}),
                });
            }
        }

        // Non-fleet (tools) assets — keep prior admin/controller path.
        const isAdminUser = await isReqUserAdmin(req.user);
        const hasDelete =
            (await userHasVehicleDeletePermission(req.user)) || (await isReqAdmin(req.user));
        if (!isAdminUser && !hasDelete) {
            // Creator of draft may still delete via middleware; allow if Draft
            const creatorId = asset.createdBy?.toString();
            const userId = req.user?._id?.toString();
            const creatorMay =
                creatorId &&
                userId &&
                creatorId === userId &&
                ['Draft', 'Pending', 'Rejected', 'Submitted for Approval'].includes(asset.status);
            if (!creatorMay) {
                return res.status(403).json({ message: 'Access denied.' });
            }
        }

        const {
            shouldBlockAssetDeleteBecauseOfAccessories,
            accessoryDeleteBlockMessage,
        } = await import('../utils/assetDeleteAccessoriesRule.js');
        if (shouldBlockAssetDeleteBecauseOfAccessories(asset, { isAdmin: isAdminUser })) {
            return res.status(400).json({
                message: accessoryDeleteBlockMessage(asset),
                accessoriesCount: asset.accessories.length,
            });
        }

        let adminNotificationEmail = null;
        if (isAdminUser) {
            adminNotificationEmail = await getAssetControllerNotificationEmail();
            const itemForEmail = await AssetItem.findById(id)
                .populate({
                    path: 'assignedTo',
                    select: 'firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee',
                    populate: {
                        path: 'primaryReportee',
                        select: 'firstName lastName companyEmail workEmail personalEmail email'
                    }
                })
                .populate('assignedCompany', 'name companyId')
                .lean();
            if (itemForEmail) {
                await notifyAdminDeletedWholeAsset(req, itemForEmail);
            }
        }

        await cleanupDashboardActionsForDeletedAsset(asset._id);

        // Delete associated History
        await AssetHistory.deleteMany({ assetId: asset._id });

        // Finally delete the asset
        await AssetItem.findByIdAndDelete(id);

        // Update counts for the type
        if (asset.typeId) {
            await updateAssetTypeCounts(asset.typeId);
        }

        res.status(200).json({
            message: 'Asset deleted successfully',
            ...(adminNotificationEmail ? { assetControllerEmail: adminNotificationEmail } : {})
        });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

/**
 * @desc    Pending asset dashboard actions assigned to the logged-in user (by EmployeeBasic id or employee code). Not a global queue.
 * @route   GET /api/AssetItem/dashboard/pending-inbox
 * @access  Private
 */
export const getPendingAssetDashboardInbox = async (req, res) => {
    try {
        const currentUser = req.user;
        if (!currentUser) return res.status(401).json({ message: 'Unauthorized' });

        const ctx = await resolveDashboardAssigneeContext(req);
        if (!ctx.ok) {
            return res.status(ctx.status || 401).json({ message: ctx.message || 'Unauthorized' });
        }

        const manager = ctx.employee;
        const relevantIds = ctx.relevantIds;
        const targetEmployeeId = ctx.employeeIdCode;
        // Role-aware fallbacks must belong to the employee whose inbox we are building
        // (own session or team target) — never the manager's roles when viewing a report.
        const roleUser = ctx.isTargeted ? (ctx.portalUser || currentUser) : currentUser;

        const scope = String(req.query.scope || '').trim().toLowerCase();
        let requestTypeFilter;
        if (scope === 'vehicle') {
            requestTypeFilter = { $in: VEHICLE_DASHBOARD_INBOX_TYPES };
        } else if (scope === 'tools') {
            requestTypeFilter = { $in: ASSET_TOOLS_INBOX_TYPES };
        } else {
            requestTypeFilter = { $in: ASSET_DASHBOARD_INBOX_TYPES };
        }

        // Tools / all: move stuck Accept tasks off employees with no ERP User onto primary reportee.
        if (scope !== 'vehicle') {
            await healMisroutedAssignmentInboxTasks();
        }

        const match = {
            status: 'Pending',
            requestType: requestTypeFilter
        };

        // Inbox + badge: only actions assigned to this user (not company-wide queues for Admin / Asset Controller).
        const assigneeClauses = buildAssigneeClauses(relevantIds, targetEmployeeId);

        // Role-aware fallback: a freshly-appointed HR (or AC) should see in-flight Asset Approvals
        // even when DashboardAction.assignedTo is still the previous role holder (until the boot
        // re-route runs). Match by role + fleet flag stored on extra3 (set at creation time).
        const [isHrRoleHolder, isAcRoleHolder, isAccountsRoleHolder, isManagementRoleHolder, isAdminOfficerHolder] =
            await Promise.all([
            isUserActiveInFlowchart(roleUser, 'hr'),
            isUserActiveInFlowchart(roleUser, 'assetcontroller'),
            isUserActiveInFlowchart(roleUser, 'accounts'),
            isUserInFlowchart(roleUser, 'management').catch(() => false),
            isUserActiveInFlowchart(roleUser, 'admincontroller'),
        ]);
        if (isHrRoleHolder) {
            assigneeClauses.push({
                requestType: 'Asset Approval',
                extra3: { $regex: '"isFleetVehicle"\\s*:\\s*true', $options: 'i' },
            });
            assigneeClauses.push({
                requestType: 'Vehicle Inspection',
                extra3: { $regex: '"inspectionReview"\\s*:\\s*true', $options: 'i' },
            });
            assigneeClauses.push({
                requestType: 'Vehicle Inspection',
                extra3: { $regex: '"activationViewerRole"\\s*:\\s*"flowchart_hr"', $options: 'i' },
            });
            assigneeClauses.push({ requestType: 'Vehicle Profile Activation' });
            assigneeClauses.push({ requestType: 'Vehicle Profile Edit' });
            assigneeClauses.push({ requestType: 'Vehicle Mortgage Close' });
            assigneeClauses.push({ requestType: 'Vehicle Delete Request' });
            assigneeClauses.push({ requestType: 'Utility Entry Status Change' });
            assigneeClauses.push({
                requestType: 'Asset Assignment',
                extra3: {
                    $regex: '"isFleetVehicle"\\s*:\\s*true.*"handoverViewerRole"\\s*:\\s*"actor"',
                    $options: 'i',
                },
            });
        }
        if (isAdminOfficerHolder) {
            assigneeClauses.push({
                requestType: 'Vehicle Inspection',
                extra3: { $regex: '"inspectionFormTask"\\s*:\\s*true', $options: 'i' },
            });
            assigneeClauses.push({
                requestType: 'Vehicle Inspection',
                extra3: { $regex: '"activationViewerRole"\\s*:\\s*"inspection_assignee"', $options: 'i' },
            });
            assigneeClauses.push({
                requestType: 'Asset Assignment',
                extra3: { $regex: '"handoverViewerRole"\\s*:\\s*"adminOfficer"', $options: 'i' },
            });
        }
        if (isAcRoleHolder) {
            assigneeClauses.push({
                requestType: 'Asset Approval',
                extra3: { $not: { $regex: '"isFleetVehicle"\\s*:\\s*true', $options: 'i' } },
            });
        }

        if (assigneeClauses.length === 0) {
            return res.json({ count: 0, items: [] });
        }
        match.$or = assigneeClauses;

        const skipSync =
            ctx.isTargeted ||
            ['1', 'true', 'yes'].includes(String(req.query.skipSync || '').trim().toLowerCase());
        if (!skipSync) {
            await syncPendingAssignmentDashboardRowsForUser(relevantIds, targetEmployeeId);
            await healStaleOilServicePendingDashboardActions();
        }

        const parseExtra3 = (raw) => {
            if (raw == null || raw === '') return null;
            if (typeof raw === 'object') return raw;
            if (typeof raw !== 'string') return null;
            try {
                return JSON.parse(raw);
            } catch {
                return null;
            }
        };

        const dashboardPendingItems = await DashboardAction.find(match).sort({ requestedDate: -1 }).limit(200).lean();

        let creatorOutcomeItems = [];
        if (assigneeClauses.length) {
            const creatorMatch = {
                status: 'Rejected',
                requestType: 'Asset Approval',
                $or: assigneeClauses,
            };
            const rejectedRows = await DashboardAction.find(creatorMatch).sort({ actionedDate: -1 }).limit(50).lean();
            creatorOutcomeItems = rejectedRows.filter((da) => {
                const meta = parseExtra3(da.extra3);
                if (meta?.assetCreationViewerRole !== 'creator' || meta?.outcome !== 'reject') return false;
                const isFleet = meta?.isFleetVehicle === true;
                if (scope === 'vehicle') return isFleet;
                if (scope === 'tools') return !isFleet;
                return true;
            });
        }

        const seen = new Set();
        const unique = [];
        for (const it of [...dashboardPendingItems, ...creatorOutcomeItems]) {
            const k = `${it._id?.toString()}-${it.requestId?.toString()}-${it.requestType}-${it.status}-${it.extra1 || ''}`;
            if (seen.has(k)) continue;
            seen.add(k);
            unique.push(it);
        }

        const hrInspectionSeen = new Set();
        const dedupedInspectionHr = [];
        for (const it of unique) {
            if (it.requestType !== 'Vehicle Inspection') {
                dedupedInspectionHr.push(it);
                continue;
            }
            const meta = parseExtra3(it.extra3);
            const isHrReview =
                meta?.inspectionReview === true || meta?.activationViewerRole === 'flowchart_hr';
            if (!isHrReview) {
                dedupedInspectionHr.push(it);
                continue;
            }
            const assetKey = it.requestId?.toString();
            if (assetKey && hrInspectionSeen.has(assetKey)) continue;
            if (assetKey) hrInspectionSeen.add(assetKey);
            dedupedInspectionHr.push(it);
        }
        unique.length = 0;
        unique.push(...dedupedInspectionHr);

        const assignmentRequestIds = [
            ...new Set(
                unique
                    .filter((it) => it.requestType === 'Asset Assignment' && it.requestId)
                    .map((it) => it.requestId.toString()),
            ),
        ];
        if (assignmentRequestIds.length) {
            await Promise.all(
                assignmentRequestIds.map((rid) => healDuplicatePendingAssignmentDashboardRows(rid).catch(() => null)),
            );
        }
        const dedupedAssignmentRows = dedupeAssignmentDashboardInboxRows(unique, parseExtra3);
        unique.length = 0;
        unique.push(...dedupedAssignmentRows);

        const oidStr = (x) => String(x ?? '').trim();
        const validOid = (id) => mongoose.Types.ObjectId.isValid(oidStr(id));

        /** IDs listed on DashboardAction.extra3 only (used for first DB pass). */
        const resolveBulkIdsFromExtra3 = (da) => {
            const parsed = parseExtra3(da.extra3);
            if (parsed?.isBulkAssignment === true && Array.isArray(parsed.bulkAssetIds) && parsed.bulkAssetIds.length > 1) {
                return {
                    isBulk: true,
                    bulkKind: 'assignment',
                    bulkAssetIds: [...new Set(parsed.bulkAssetIds.map((x) => oidStr(x)))].filter(validOid)
                };
            }
            if (parsed?.isBulkCreation && Array.isArray(parsed.bulkAssetIds) && parsed.bulkAssetIds.length > 1) {
                return {
                    isBulk: true,
                    bulkKind: 'creation',
                    bulkAssetIds: parsed.bulkAssetIds.map((x) => oidStr(x)).filter(validOid)
                };
            }
            if (parsed?.isBulk === true) {
                const ids = parsed.assetIds || parsed.bulkAssetIds;
                if (Array.isArray(ids) && ids.length > 1) {
                    let kind = 'action';
                    if (da.requestType === 'Asset Return') kind = 'return';
                    return {
                        isBulk: true,
                        bulkKind: kind,
                        bulkAssetIds: [...new Set(ids.map((x) => oidStr(x)))].filter(validOid)
                    };
                }
            }
            return { isBulk: false, bulkKind: null, bulkAssetIds: [] };
        };

        const allIdSet = new Set();
        for (const da of unique) {
            if (da.requestType === 'Asset Owner On Duty' || da.requestType === 'Asset On Duty Request') {
                const meta = parseExtra3(da.extra3);
                const ids = meta?.requestedAssetIds || meta?.parkingAssetIds;
                if (Array.isArray(ids)) {
                    ids.forEach((id) => {
                        const s = oidStr(id);
                        if (validOid(s)) allIdSet.add(s);
                    });
                }
                if (da.requestId) allIdSet.add(da.requestId.toString());
                continue;
            }
            if (da.requestId) allIdSet.add(da.requestId.toString());
            const { isBulk, bulkAssetIds } = resolveBulkIdsFromExtra3(da);
            if (isBulk && bulkAssetIds.length) {
                bulkAssetIds.forEach((id) => allIdSet.add(id));
            }
        }

        const allIds = [...allIdSet].filter(Boolean);
        const assets = await AssetItem.find({ _id: { $in: allIds } })
            .select(
                'assetId name status plateNumber assignedTo assignedToType assignedCompany pendingAction actionRequiredBy accessories acceptanceStatus pendingActionDetails'
            )
            .populate('assignedTo', 'firstName lastName employeeId')
            .populate('assignedCompany', 'name companyId')
            .lean();

        const assetById = Object.fromEntries(assets.map((a) => [a._id.toString(), a]));

        // Load any bulk members referenced on the primary AssetItem but missing from extra3 / invalid in extra3.
        const supplementIds = new Set();
        for (const da of unique) {
            const primary = assetById[da.requestId?.toString()];
            const pb = primary?.pendingActionDetails?.bulkAssetIds;
            if (!Array.isArray(pb)) continue;
            for (const id of pb) {
                const s = oidStr(id);
                if (validOid(s) && !assetById[s]) supplementIds.add(s);
            }
        }
        if (supplementIds.size > 0) {
            const more = await AssetItem.find({ _id: { $in: [...supplementIds] } })
                .select(
                    'assetId name status assignedTo assignedToType assignedCompany pendingAction actionRequiredBy accessories acceptanceStatus pendingActionDetails'
                )
                .populate('assignedTo', 'firstName lastName employeeId')
                .populate('assignedCompany', 'name companyId')
                .lean();
            for (const a of more) {
                assetById[a._id.toString()] = a;
            }
        }

        const isOperationalExpiryDashboardRow = (da) => {
            const parsed = parseExtra3(da?.extra3);
            return parsed?.focusCard === 'operationalExpiry';
        };

        /** Canonical bulk list: prefer pendingActionDetails.bulkAssetIds on primary (DB) over extra3 JSON. */
        const resolveBulkForInboxItem = (da) => {
            const parsed = parseExtra3(da.extra3);
            if (isOperationalExpiryDashboardRow(da)) {
                return { isBulk: false, bulkKind: null, bulkAssetIds: [] };
            }
            if (parsed?.isBulkAssignment === true && Array.isArray(parsed.bulkAssetIds) && parsed.bulkAssetIds.length > 1) {
                const bulkAssetIds = [...new Set(parsed.bulkAssetIds.map((x) => oidStr(x)))].filter(validOid);
                if (bulkAssetIds.length > 1) {
                    return { isBulk: true, bulkKind: 'assignment', bulkAssetIds };
                }
            }
            if (parsed?.isBulkCreation && Array.isArray(parsed.bulkAssetIds) && parsed.bulkAssetIds.length > 1) {
                const bulkAssetIds = [...new Set(parsed.bulkAssetIds.map((x) => oidStr(x)))].filter(validOid);
                if (bulkAssetIds.length > 1) {
                    return { isBulk: true, bulkKind: 'creation', bulkAssetIds };
                }
            }

            const aid = da.requestId?.toString();
            const primary = aid ? assetById[aid] : null;
            const pb = primary?.pendingActionDetails?.bulkAssetIds;
            if (primary?.pendingActionDetails?.isBulk === true && Array.isArray(pb) && pb.length > 1) {
                const bulkAssetIds = [...new Set(pb.map((x) => oidStr(x)))].filter(validOid);
                if (bulkAssetIds.length > 1) {
                    let kind = 'action';
                    if (da.requestType === 'Asset Return') kind = 'return';
                    return { isBulk: true, bulkKind: kind, bulkAssetIds };
                }
            }

            if (parsed?.isBulk === true) {
                const ids = parsed.assetIds || parsed.bulkAssetIds;
                if (Array.isArray(ids) && ids.length > 1) {
                    const bulkAssetIds = [...new Set(ids.map((x) => oidStr(x)))].filter(validOid);
                    if (bulkAssetIds.length > 1) {
                        let kind = 'action';
                        if (da.requestType === 'Asset Return') kind = 'return';
                        return { isBulk: true, bulkKind: kind, bulkAssetIds };
                    }
                }
            }

            return { isBulk: false, bulkKind: null, bulkAssetIds: [] };
        };

        const formatAsset = (asset) => {
            if (!asset) return null;
            const accList = asset.accessories || [];
            const pendingAccessories = accList.filter((x) => x.pendingAction);
            return {
                _id: asset._id,
                assetId: asset.assetId,
                name: asset.name,
                plateNumber: asset.plateNumber || '',
                status: asset.status,
                acceptanceStatus: asset.acceptanceStatus,
                actionRequiredBy: asset.actionRequiredBy,
                pendingAction: asset.pendingAction,
                assignedTo: asset.assignedTo,
                fleetHandoverActive: Boolean(asset.pendingActionDetails?.vehicleHandoverFlow?.historyId),
                bulkAssignmentGroupId: asset.pendingActionDetails?.bulkAssignment?.groupId || null,
                accessories: accList.map((ac) => ({
                    _id: ac._id,
                    accessoryId: ac.accessoryId,
                    name: ac.name,
                    status: ac.status,
                    pendingAction: ac.pendingAction
                })),
                pendingAccessoriesCount: pendingAccessories.length
            };
        };

        let items = unique.map((da) => {
            const aid = da.requestId?.toString();
            const asset = assetById[aid] || null;
            const { isBulk, bulkKind, bulkAssetIds } = resolveBulkForInboxItem(da);

            let bulkAssets = [];
            if (isBulk && bulkAssetIds.length) {
                bulkAssets = bulkAssetIds.map((id) => {
                    const raw = assetById[id];
                    if (!raw) {
                        return {
                            _id: id,
                            assetId: '—',
                            name: 'Asset not found',
                            status: null,
                            pendingAction: null,
                            assignedTo: null,
                            accessories: [],
                            pendingAccessoriesCount: 0
                        };
                    }
                    return formatAsset(raw);
                });
            }

            const meta = parseExtra3(da.extra3);
            return {
                dashboardActionId: da._id,
                requestType: da.requestType,
                requestedDate: da.requestedDate,
                actionedDate: da.actionedDate,
                dashboardStatus: da.status,
                requestedByName: da.requestedByName,
                subjectName: da.subjectName,
                extra1: da.extra1,
                extra2: da.extra2,
                extra3: da.extra3,
                requestObjectId: da.requestId,
                primaryAssetId: aid,
                isBulk,
                bulkKind,
                bulkAssetIds,
                bulkAssets,
                isCreatorOutcome: meta?.assetCreationViewerRole === 'creator',
                asset: formatAsset(asset)
            };
        });

        // Drop stale leave-approval bell rows when assets are already on leave (operational expiry rows replace them).
        items = items.filter((row) => {
            if (row.requestType !== 'Asset Leave') return true;
            if (isOperationalExpiryDashboardRow(row)) return true;
            if (row.isBulk && Array.isArray(row.bulkAssets) && row.bulkAssets.length) {
                return row.bulkAssets.some((a) => String(a?.pendingAction || '').trim() === 'Leave');
            }
            return String(row.asset?.pendingAction || '').trim() === 'Leave';
        });

        // One inbox row per leave-expiry event — merge per-asset operational expiry tasks for the same message.
        const operationalExpiryLeaveGroups = new Map();
        const inboxAfterExpiryMerge = [];
        for (const row of items) {
            if (row.requestType !== 'Asset Leave' || !isOperationalExpiryDashboardRow(row)) {
                inboxAfterExpiryMerge.push(row);
                continue;
            }
            const groupKey = String(row.extra2 || '').trim();
            if (!groupKey) {
                inboxAfterExpiryMerge.push(row);
                continue;
            }
            if (!operationalExpiryLeaveGroups.has(groupKey)) {
                operationalExpiryLeaveGroups.set(groupKey, []);
            }
            operationalExpiryLeaveGroups.get(groupKey).push(row);
        }
        for (const group of operationalExpiryLeaveGroups.values()) {
            if (group.length === 1) {
                inboxAfterExpiryMerge.push(group[0]);
                continue;
            }
            const bulkAssetIds = [...new Set(group.map((r) => oidStr(r.primaryAssetId)).filter(validOid))];
            const bulkAssets = bulkAssetIds.map((id) => {
                const fromGroup = group.find((r) => oidStr(r.primaryAssetId) === id);
                if (fromGroup?.asset) return fromGroup.asset;
                const raw = assetById[id];
                return raw ? formatAsset(raw) : null;
            }).filter(Boolean);
            const assetSummary = bulkAssets.map((a) => `${a.assetId} — ${a.name}`).join('; ');
            const primary = group[0];
            inboxAfterExpiryMerge.push({
                ...primary,
                isBulk: bulkAssetIds.length > 1,
                bulkKind: bulkAssetIds.length > 1 ? 'action' : primary.bulkKind,
                bulkAssetIds,
                bulkAssets,
                extra1:
                    bulkAssetIds.length > 1
                        ? `On Leave expiry (${bulkAssetIds.length} assets): ${assetSummary.substring(0, 240)}${assetSummary.length > 240 ? '...' : ''}`
                        : primary.extra1,
            });
        }
        items = inboxAfterExpiryMerge;
        items = dedupePendingBulkInboxItems(items);

        // Hide stale owner on-duty review bells when no parked assets remain for the request.
        const ownerOnDutyStaleIds = [];
        const itemsAfterOwnerOnDutyFilter = [];
        for (const row of items) {
            if (row.requestType !== OWNER_ON_DUTY_REQUEST_TYPE) {
                itemsAfterOwnerOnDutyFilter.push(row);
                continue;
            }
            const da = unique.find((x) => String(x._id) === String(row.dashboardActionId));
            const parkingAssets = da ? await resolveOwnerOnDutyParkingAssetsForDashboard(da) : [];
            if (!parkingAssets.length) {
                if (row.dashboardActionId) ownerOnDutyStaleIds.push(row.dashboardActionId);
                continue;
            }
            itemsAfterOwnerOnDutyFilter.push(row);
        }
        items = itemsAfterOwnerOnDutyFilter;
        if (ownerOnDutyStaleIds.length) {
            await Promise.all(
                ownerOnDutyStaleIds.map((id) => closeStaleOwnerOnDutyDashboardAction(id)),
            );
        }

        // Hide completed bulk-assignment and single-assignment bells when nothing is left to acknowledge.
        const staleBulkGroupIds = new Set();
        const staleAssignmentDashboardIds = new Set();
        const itemsAfterCompletedFilter = [];
        for (const row of items) {
            const meta = parseExtra3(row.extra3);
            const isBulkAssign =
                row.bulkKind === 'assignment' && row.isBulk && meta?.isBulkAssignment === true;

            if (isBulkAssign) {
                const pendingCount = await countPendingBulkAssignmentBatch(meta, row.bulkAssetIds);
                if (pendingCount === 0) {
                    if (meta?.bulkAssignmentGroupId) {
                        staleBulkGroupIds.add(String(meta.bulkAssignmentGroupId));
                    } else if (row.dashboardActionId) {
                        staleAssignmentDashboardIds.add(String(row.dashboardActionId));
                    }
                    continue;
                }
                itemsAfterCompletedFilter.push(row);
                continue;
            }

            if (row.requestType === 'Asset Assignment' || row.requestType === 'Asset') {
                if (meta?.isBulkAssignment === true) {
                    itemsAfterCompletedFilter.push(row);
                    continue;
                }
                const isFleetHandover = isFleetHandoverDashboardMeta(meta);
                const viewerRole = String(meta?.handoverViewerRole || '').trim();
                if (isFleetHandover && isFleetHandoverTrackingViewerRole(viewerRole)) {
                    if (!isAssignmentAcknowledgmentStillPending(row.asset)) {
                        if (row.dashboardActionId) {
                            staleAssignmentDashboardIds.add(String(row.dashboardActionId));
                        }
                        continue;
                    }
                    itemsAfterCompletedFilter.push(row);
                    continue;
                }
                if (!isAssignmentAcknowledgmentStillPending(row.asset)) {
                    if (row.dashboardActionId) {
                        staleAssignmentDashboardIds.add(String(row.dashboardActionId));
                    }
                    continue;
                }
            }

            itemsAfterCompletedFilter.push(row);
        }
        items = itemsAfterCompletedFilter;
        for (const gid of staleBulkGroupIds) {
            await markBulkAssignmentDashboardRowComplete(
                gid,
                null,
                'Auto-closed: bulk assignment batch completed.',
            );
        }
        for (const dashboardId of staleAssignmentDashboardIds) {
            await closeStaleAssignmentDashboardAction(dashboardId);
        }

        // Hide completed return-request bells when no assets still await AC approval.
        const staleReturnDashboardIds = [];
        const itemsAfterReturnFilter = [];
        for (const row of items) {
            if (row.requestType !== 'Asset Return') {
                itemsAfterReturnFilter.push(row);
                continue;
            }
            const da = unique.find((x) => String(x._id) === String(row.dashboardActionId));
            const meta = parseExtra3(row.extra3);
            const bulkIds = [
                ...new Set(
                    []
                        .concat(Array.isArray(meta?.bulkAssetIds) ? meta.bulkAssetIds : [])
                        .concat(Array.isArray(meta?.assetIds) ? meta.assetIds : [])
                        .concat(Array.isArray(row.bulkAssetIds) ? row.bulkAssetIds : [])
                        .map((x) => String(x).trim())
                        .filter((x) => validOid(x)),
                ),
            ];
            let pendingReturnCount = 0;
            if (bulkIds.length > 1) {
                pendingReturnCount = await AssetItem.countDocuments({
                    _id: { $in: bulkIds },
                    pendingAction: 'Return Asset',
                });
            } else {
                const rid = da?.requestId || row.primaryAssetId;
                if (rid && validOid(String(rid))) {
                    pendingReturnCount = await AssetItem.countDocuments({
                        _id: rid,
                        pendingAction: 'Return Asset',
                    });
                }
            }
            if (pendingReturnCount === 0) {
                if (row.dashboardActionId) staleReturnDashboardIds.push(row.dashboardActionId);
                continue;
            }
            itemsAfterReturnFilter.push(row);
        }
        items = itemsAfterReturnFilter;
        if (staleReturnDashboardIds.length) {
            await DashboardAction.updateMany(
                {
                    _id: { $in: staleReturnDashboardIds },
                    status: 'Pending',
                    requestType: 'Asset Return',
                },
                {
                    $set: {
                        status: 'Approved',
                        actionedDate: new Date(),
                        comment: 'Auto-closed: return request completed.',
                    },
                },
            );
        }

        items.sort((a, b) => new Date(b.requestedDate || 0) - new Date(a.requestedDate || 0));

        if (scope === 'vehicle') {
            items = items.filter((row) => {
                if (row.requestType === 'Asset Approval') {
                    const plate = String(row.asset?.plateNumber || '').trim();
                    if (plate) return true;
                    try {
                        const meta = typeof row.extra3 === 'string' ? JSON.parse(row.extra3) : row.extra3;
                        return meta?.isFleetVehicle === true;
                    } catch {
                        return false;
                    }
                }
                if (row.requestType === 'Asset Assignment') {
                    try {
                        const meta = typeof row.extra3 === 'string' ? JSON.parse(row.extra3) : row.extra3;
                        return isFleetVehicleInboxAsset(row.asset, meta);
                    } catch {
                        return isFleetVehicleInboxAsset(row.asset, null);
                    }
                }
                if (row.requestType === 'Asset Return') {
                    return isFleetVehicleInboxAsset(row.asset, null);
                }
                return true;
            });
        }

        // Inverse of vehicle scope — Tools must never show Vehicle* or fleet shared rows.
        if (scope === 'tools') {
            items = items.filter((row) => {
                const type = String(row.requestType || '').trim();
                if (type.startsWith('Vehicle')) return false;
                if (row.requestType === 'Asset Approval') {
                    const plate = String(row.asset?.plateNumber || '').trim();
                    if (plate) return false;
                    try {
                        const meta = typeof row.extra3 === 'string' ? JSON.parse(row.extra3) : row.extra3;
                        return meta?.isFleetVehicle !== true;
                    } catch {
                        return true;
                    }
                }
                if (row.requestType === 'Asset Assignment') {
                    try {
                        const meta = typeof row.extra3 === 'string' ? JSON.parse(row.extra3) : row.extra3;
                        return !isFleetVehicleInboxAsset(row.asset, meta);
                    } catch {
                        return !isFleetVehicleInboxAsset(row.asset, null);
                    }
                }
                if (row.requestType === 'Asset Return') {
                    return !isFleetVehicleInboxAsset(row.asset, null);
                }
                return true;
            });
        }

        // Sold / Total loss: Accounts and Management each have their own bell row (parallel).
        // Only show the row that matches the viewer's flowchart role so one approval does not
        // imply the other role's task disappeared from their inbox incorrectly.
        items = items.filter((row) => {
            if (row.requestType !== 'Vehicle Disposition Request') return true;
            let meta = null;
            try {
                meta = typeof row.extra3 === 'string' ? JSON.parse(row.extra3) : row.extra3;
            } catch {
                meta = null;
            }
            let viewerRole = meta?.dispositionViewerRole
                ? String(meta.dispositionViewerRole).toLowerCase()
                : '';
            if (!viewerRole) {
                const e1 = String(row.extra1 || '').trim();
                if (/\(\s*Accounts\s*\)\s*$/i.test(e1)) viewerRole = 'accounts';
                else if (/\(\s*Management\s*\)\s*$/i.test(e1)) viewerRole = 'management';
                else if (/\(HR review\)\s*$/i.test(e1)) viewerRole = 'hr';
                else return false;
            }
            if (viewerRole === 'hr') return isHrRoleHolder;
            if (viewerRole === 'accounts') return isAccountsRoleHolder;
            if (viewerRole === 'management') return isManagementRoleHolder;
            return false;
        });

        const assignmentInboxSeen = new Set();
        items = items.filter((row) => {
            if (row.requestType !== 'Asset Assignment' || row.isBulk) return true;
            let meta = null;
            try {
                meta = typeof row.extra3 === 'string' ? JSON.parse(row.extra3) : row.extra3;
            } catch {
                meta = null;
            }
            if (meta?.isBulkAssignment === true) return true;
            const assetKey = String(row.primaryAssetId || row.requestObjectId || '');
            if (!assetKey) return true;
            if (assignmentInboxSeen.has(assetKey)) return false;
            assignmentInboxSeen.add(assetKey);
            return true;
        });

        res.json({ count: items.length, items });
    } catch (error) {
        res.status(500).json({ message: 'Failed to load pending asset requests' });
    }
};

/**
 * @desc    Remove one pending asset dashboard notification for the current user (inbox dismiss only).
 * @route   DELETE /api/AssetItem/dashboard/pending-inbox/:id
 * @access  Private (assignee only, same scope as GET pending-inbox)
 */
export const deletePendingAssetDashboardInboxItem = async (req, res) => {
    try {
        const currentUser = req.user;
        if (!currentUser) return res.status(401).json({ message: 'Unauthorized' });

        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid notification id' });
        }

        const isAdminUser = isJwtSystemSuperUser(currentUser);

        const manager = await EmployeeBasic.findOne({
            $or: [
                ...(currentUser.employeeObjectId ? [{ _id: currentUser.employeeObjectId }] : []),
                ...(currentUser.employeeId ? [{ employeeId: currentUser.employeeId }] : [])
            ]
        });

        const relevantIds = [manager?._id, currentUser.employeeObjectId, currentUser?._id].filter(Boolean);
        const targetEmployeeId = currentUser.employeeId || manager?.employeeId;

        const da = await DashboardAction.findById(id);
        if (!da) return res.status(404).json({ message: 'Notification not found' });
        if (da.status === 'Dismissed') {
            return res.status(200).json({ message: 'Notification removed' });
        }
        if (da.status !== 'Pending') {
            let meta = null;
            try {
                meta = typeof da.extra3 === 'string' ? JSON.parse(da.extra3) : da.extra3;
            } catch {
                meta = null;
            }
            const isCreatorRejectOutcome =
                da.status === 'Rejected' &&
                meta?.assetCreationViewerRole === 'creator' &&
                meta?.outcome === 'reject';
            if (!isCreatorRejectOutcome) {
                return res.status(400).json({ message: 'Only pending notifications can be removed' });
            }
        }
        if (!ASSET_DASHBOARD_INBOX_TYPES.includes(da.requestType)) {
            return res.status(400).json({ message: 'This notification cannot be removed from here' });
        }

        const toStr = (x) => (x == null ? '' : x.toString());
        let assigneeOk = false;
        if (relevantIds.length && da.assignedTo) {
            const at = toStr(da.assignedTo);
            assigneeOk = relevantIds.some((r) => toStr(r) === at);
        }
        if (!assigneeOk && targetEmployeeId && da.assignedToEmpId) {
            assigneeOk =
                String(da.assignedToEmpId).trim().toLowerCase() === String(targetEmployeeId).trim().toLowerCase();
        }
        if (!assigneeOk && !isAdminUser) {
            return res.status(403).json({ message: 'You can only remove notifications assigned to you' });
        }

        const actionedBy = manager?._id || currentUser.employeeObjectId || currentUser._id || null;
        await DashboardAction.findByIdAndUpdate(id, {
            $set: {
                status: 'Dismissed',
                actionedDate: new Date(),
                actionedBy,
                comment:
                    isAdminUser && !assigneeOk
                        ? 'Dismissed by administrator'
                        : 'Dismissed from inbox',
            },
        });
        res.status(200).json({ message: 'Notification removed' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to remove notification' });
    }
};

export const getEmployeePreviousAssets = async (req, res) => {
    try {
        const { employeeId } = req.params;

        let empObjId = null;
        const mongoose = (await import('mongoose')).default;
        if (mongoose.Types.ObjectId.isValid(employeeId)) {
            empObjId = employeeId;
        } else {
            const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
            const normEmp = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
            const emp = await EmployeeBasic.findOne({
                employeeId: { $regex: new RegExp(`^${normEmp(employeeId).replace(/\s+/g, '\\s*')}$`, 'i') }
            }).select('_id').lean();
            if (emp) empObjId = emp._id.toString();
        }

        if (!empObjId) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const AssetHistory = (await import('../models/AssetHistory.js')).default;
        const historyRecords = await AssetHistory.find({ assignedTo: empObjId }).select('assetId').lean();
        const distinctAssetIds = [...new Set(historyRecords.map(h => h.assetId?.toString()).filter(Boolean))];

        if (distinctAssetIds.length === 0) {
            return res.status(200).json({ items: [] });
        }

        const AssetItem = (await import('../models/AssetItem.js')).default;

        const previousAssets = await AssetItem.find({
            _id: { $in: distinctAssetIds },
            $or: [
                { assignedTo: { $ne: empObjId } },
                { assignedTo: null },
                { assignedTo: { $exists: false } }
            ]
        })
            .populate('assignedTo', 'firstName lastName employeeId')
            .populate('assignedCompany', 'name shortName nickName companyId')
            .populate('typeId', 'name')
            .populate('categoryId', 'name')
            .lean();

        res.status(200).json({ items: previousAssets });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};



