import AssetItem from '../models/AssetItem.js';
import AssetType from '../models/AssetType.js';
import AssetHistory from '../models/AssetHistory.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { uploadDocumentToS3 } from '../utils/s3Upload.js';
import { syncDashboardAction } from '../utils/syncDashboard.js';
import { closeAdminOfficerServiceTrackNotification } from '../utils/vehicleServiceAdminOfficerNotification.js';
import { getDepartmentHOD, isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import { getManagementHOD } from '../utils/getManagementHOD.js';
import { sendVehicleServiceWorkflowEmail } from '../utils/sendVehicleServiceWorkflowEmail.js';
import { resolveEmployeeEmail } from '../utils/resolveEmployeeEmail.js';
import { isUserAdministrator } from '../services/permissionService.js';
import { isJwtSystemSuperUser } from '../utils/systemSuperUser.js';
import {
    actorMayManageOilService,
    userIsOilServiceAdminOfficer,
    closeOilServicePendingDashboardActions,
    isOilServiceCashPayment,
    advanceOilCashAfterHrApprove,
    advanceOilCashAfterAccountsApprove,
    parseOilServiceRemark,
} from '../utils/oilServiceWorkflow.js';
import {
    advanceTireChangeAfterAccountsApprove,
    advanceTireChangeAfterHrApprove,
    isTireChangeWorkflow,
    notifyTireChangeAccountsHoldToAdmin,
    appendTireChangeActivity,
    TIRE_CHANGE_STAGE,
} from '../utils/tireChangeWorkflow.js';
import {
    advanceMechanicalWorkAfterAccountsApprove,
    advanceMechanicalWorkAfterHrApprove,
    isMechanicalWorkWorkflow,
    appendMechanicalWorkActivity,
} from '../utils/mechanicalWorkWorkflow.js';
import {
    advanceBodyWorkAfterAccountsApprove,
    advanceBodyWorkAfterHrApprove,
    isBodyWorkWorkflow,
    appendBodyWorkActivity,
} from '../utils/bodyWorkWorkflow.js';
import {
    advanceAccidentRepairAfterAccountsApprove,
    advanceAccidentRepairAfterHrApprove,
    isAccidentRepairWorkflow,
    notifyAccidentRepairStakeholder,
    appendAccidentRepairActivity,
    ACCIDENT_REPAIR_STAGE,
} from '../utils/accidentRepairWorkflow.js';
import {
    isCarWashServiceRecord,
    setCarWashPaymentStatusOnService,
    closeCarWashPendingDashboardActions,
    carWashDetailsPath,
    carWashDashboardMeta,
    notifyCarWashAccountsApproved,
    CAR_WASH_PAYMENT_PENDING,
    CAR_WASH_PAYMENT_NOT_PAID,
} from '../utils/carWashWorkflow.js';
import {
    applyServiceActiveState,
    applyPostServiceOperationalState,
    isServiceActive,
} from '../utils/assetOperationalFlags.js';

const STAGE = {
    HR: 'pending_hr',
    ACCOUNTS: 'pending_accounts',
    ADMIN: 'pending_admin',
    /** After Admin approves: waiting for first service day / in-window actions (Extend, Mark live). */
    SCHEDULED: 'scheduled_service',
    MANAGEMENT: 'pending_management',
    COMPLETE: 'complete',
    REJECTED: 'rejected'
};

function computeInclusiveWindowEnd(startDate, durationDays) {
    const s = new Date(startDate);
    if (Number.isNaN(s.getTime())) return null;
    const n = Math.max(1, Math.floor(Number(durationDays) || 1));
    const e = new Date(s);
    e.setDate(e.getDate() + (n - 1));
    e.setHours(12, 0, 0, 0);
    return e;
}

function vehicleServiceDetailsPath(assetId, serviceRecordId, serviceType = '') {
    if (!assetId || !serviceRecordId) return null;
    const type = String(serviceType || '').trim();
    if (type === 'Tire Change') {
        return `/HRM/Asset/Vehicle/details/${assetId}/tire-change/${serviceRecordId}`;
    }
    if (type === 'Mechanical Work') {
        return `/HRM/Asset/Vehicle/details/${assetId}/mechanical-work/${serviceRecordId}`;
    }
    if (type === 'Body Work') {
        return `/HRM/Asset/Vehicle/details/${assetId}/body-work/${serviceRecordId}`;
    }
    if (type === 'Accident Repair') {
        return `/HRM/Asset/Vehicle/details/${assetId}/accident-repair/${serviceRecordId}`;
    }
    if (type === 'Oil Service') {
        return `/HRM/Asset/Vehicle/details/${assetId}/oil-service/${serviceRecordId}`;
    }
    return `/HRM/Asset/Vehicle/service-requests/details/${assetId}/${serviceRecordId}`;
}

function vehicleServiceDetailsPathForWorkflow(asset, wf) {
    return vehicleServiceDetailsPath(asset?._id, wf?.serviceRecordId, wf?.serviceTypeLabel || '');
}

function vehicleServiceDashboardMeta(asset, serviceRecordId, serviceType = '') {
    const path = vehicleServiceDetailsPath(asset?._id, serviceRecordId, serviceType);
    return JSON.stringify({
        vehicleId: asset?._id ? String(asset._id) : '',
        serviceRecordId: serviceRecordId ? String(serviceRecordId) : '',
        serviceType: String(serviceType || ''),
        detailsPath: path || '',
    });
}

function vehicleServiceDashboardMetaForWorkflow(asset, wf) {
    return vehicleServiceDashboardMeta(asset, wf?.serviceRecordId, wf?.serviceTypeLabel || '');
}

function resolveStatusAfterService(asset, wf) {
    applyPostServiceOperationalState(asset, {
        statusBeforeService: wf?.previousStatus || null,
    });
    return asset.status;
}

function uniqRecipients(list) {
    const seen = new Set();
    const out = [];
    for (const emp of list || []) {
        if (!emp) continue;
        const k = String(emp._id || emp.employeeId || '').trim().toLowerCase();
        const { email } = resolveEmployeeEmail(emp);
        const ek = String(email || '').trim().toLowerCase();
        const key = k || ek;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(emp);
    }
    return out;
}

async function sendWorkflowEmailWithConsole({ recipient, asset, stageLabel, actionLabel, detailLine, linkPath }) {
    const { email } = resolveEmployeeEmail(recipient || {});
    const who = `${recipient?.firstName || ''} ${recipient?.lastName || ''}`.trim() || recipient?.employeeId || 'Unknown';
    console.log(`[VehicleServiceWorkflow][Email] ${actionLabel} -> ${who} <${email || 'no-company-email'}>`);
    if (!email) return;
    await sendVehicleServiceWorkflowEmail({
        recipient,
        asset,
        stageLabel,
        actionLabel,
        detailLine,
        linkPath,
    });
}

async function resolveWorkflowStakeholders(asset, serviceRecordId) {
    const sub = asset?.services?.id?.(serviceRecordId);
    const requesterId = sub?.requestedBy ? String(sub.requestedBy) : '';
    const requester = requesterId
        ? await EmployeeBasic.findById(requesterId).select('_id firstName lastName employeeId companyEmail primaryReportee').lean()
        : null;
    const assignedEmpRaw = asset?.assignedTo?._id
        ? await EmployeeBasic.findById(asset.assignedTo._id)
            .populate('primaryReportee', '_id firstName lastName employeeId companyEmail')
            .select('_id firstName lastName employeeId companyEmail primaryReportee')
            .lean()
        : null;
    const primaryReportee = assignedEmpRaw?.primaryReportee || null;
    return {
        requester,
        assignedEmployee: assignedEmpRaw,
        primaryReportee,
    };
}

async function resolveAssigneeForStage(stage) {
    const roleKey = flowchartRoleKeyForStage(stage);
    if (!roleKey) return null;
    if (roleKey === 'management') return getManagementHOD();

    let assignee = await getDepartmentHOD(roleKey);
    // Flowchart row exists but empObjectId was never linked — resolve by employeeId.
    if (assignee && !assignee._id && assignee.employeeId) {
        const raw = String(assignee.employeeId).trim();
        const parts = raw.split(/\s+/).filter(Boolean);
        const pattern = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
        if (pattern) {
            const repaired = await EmployeeBasic.findOne({
                employeeId: { $regex: new RegExp(`^${pattern}$`, 'i') },
            })
                .select('_id employeeId firstName lastName signature companyEmail')
                .lean();
            if (repaired?._id) assignee = repaired;
        }
    }
    return assignee;
}

/** Map workflow stage → Flowchart category key. */
function flowchartRoleKeyForStage(stage) {
    if (stage === STAGE.HR) return 'hr';
    if (stage === STAGE.ACCOUNTS || stage === 'pending_billing') return 'accounts';
    if (stage === STAGE.ADMIN || stage === STAGE.SCHEDULED) return 'assetcontroller';
    if (stage === 'pending_admin_officer' || stage === 'pending_admin_return') {
        return 'admincontroller';
    }
    if (stage === STAGE.MANAGEMENT) return 'management';
    return null;
}

function missingAssigneeMessage(stage) {
    const roleKey = flowchartRoleKeyForStage(stage);
    if (roleKey === 'hr') {
        return 'No Active HR is configured in Settings → FlowChart. Set HR to Active and link an employee, then approve again.';
    }
    if (roleKey === 'accounts') {
        return 'No Active Accounts is configured in Settings → FlowChart. Set Accounts to Active and link an employee, then try again.';
    }
    if (roleKey === 'admincontroller') {
        return 'No Active Admin Officer is configured in Settings → FlowChart. Set Admin Officer to Active and link an employee, then try again.';
    }
    if (roleKey === 'assetcontroller') {
        return 'No Active Asset Controller is configured in Settings → FlowChart. Configure the role, then try again.';
    }
    return 'Workflow role is not configured in Flowchart (assignee missing).';
}

async function getRequesterName(reqUser) {
    if (!reqUser) return 'System';
    const looksLikeObjectId = (value) => /^[a-fA-F0-9]{24}$/.test(String(value || '').trim());
    const rawName = reqUser.name ? String(reqUser.name).trim() : '';
    if (rawName && !looksLikeObjectId(rawName)) return rawName;
    const u = await EmployeeBasic.findById(reqUser.employeeObjectId).select('firstName lastName').lean();
    if (u) {
        const n = `${u.firstName || ''} ${u.lastName || ''}`.trim();
        if (n) return n;
    }
    const email = reqUser.email ? String(reqUser.email).trim() : '';
    if (email && !looksLikeObjectId(email)) return email;
    return 'User';
}

function isPortalAdmin(reqUser) {
    return isJwtSystemSuperUser(reqUser);
}

async function resolveActorEmployee(reqUser) {
    if (!reqUser?.employeeObjectId && !reqUser?.employeeId) return null;
    if (reqUser.employeeObjectId) {
        const e = await EmployeeBasic.findById(reqUser.employeeObjectId).select('_id employeeId firstName lastName signature').lean();
        if (e) return e;
    }
    if (reqUser.employeeId) {
        return EmployeeBasic.findOne({
            employeeId: { $regex: new RegExp(`^${String(reqUser.employeeId).replace(/\s+/g, '\\s*')}$`, 'i') }
        })
            .select('_id employeeId firstName lastName signature')
            .lean();
    }
    return null;
}

async function actorMayAct(reqUser, assignee) {
    if (!assignee?._id) return isPortalAdmin(reqUser) || (await isUserAdministrator(reqUser?.id));
    if (isPortalAdmin(reqUser)) return true;
    if (await isUserAdministrator(reqUser?.id)) return true;
    const actor = await resolveActorEmployee(reqUser);
    if (!actor?._id) return false;
    return String(actor._id) === String(assignee._id);
}

async function actorMayManageOilServiceForAsset(reqUser, asset) {
    return actorMayManageOilService(reqUser, asset);
}

function isOilServiceWorkflowRecord(wf, serviceSub) {
    return String(serviceSub?.serviceType || wf?.serviceTypeLabel || '').trim() === 'Oil Service';
}

function parseRemarkMeta(remarkValue) {
    if (!remarkValue) return {};
    if (typeof remarkValue === 'object') return remarkValue;
    try {
        return JSON.parse(remarkValue);
    } catch {
        return {};
    }
}

function requiresQuotationSelection(serviceType) {
    // Accident Repair does not require quotation selection in HR flow.
    return ['Tire Change', 'Mechanical Work', 'Body Work'].includes(String(serviceType || ''));
}

function selectedQuotationExists(choice, serviceSub, incomingUpdates) {
    const hasQ1 = !!(serviceSub?.attachment || incomingUpdates?.attachment?.data);
    const hasQ2 = !!(serviceSub?.quotation2 || incomingUpdates?.quotation2?.data);
    const hasQ3 = !!(serviceSub?.quotation3 || incomingUpdates?.quotation3?.data);
    if (choice === 'q1') return hasQ1;
    if (choice === 'q2') return hasQ2;
    if (choice === 'q3') return hasQ3;
    return false;
}

function availableQuotationCount(serviceSub, incomingUpdates) {
    const hasQ1 = !!(serviceSub?.attachment || incomingUpdates?.attachment?.data);
    const hasQ2 = !!(serviceSub?.quotation2 || incomingUpdates?.quotation2?.data);
    const hasQ3 = !!(serviceSub?.quotation3 || incomingUpdates?.quotation3?.data);
    return [hasQ1, hasQ2, hasQ3].filter(Boolean).length;
}

function keepOnlySelectedQuotationOnService(serviceSub) {
    if (!serviceSub) return;
    const remark = parseRemarkMeta(serviceSub.remark);
    const choice = String(remark?.approvedQuotationChoice || '').trim();
    if (!['q1', 'q2', 'q3'].includes(choice)) return;
    // Keep all quotation files intact and persist the exact selected key (q1/q2/q3).
    // This ensures UI reflects the HR-selected quotation correctly instead of forcing q1.
    remark.approvedQuotationChoice = choice;
    serviceSub.remark = JSON.stringify(remark);
}

/** Non-persisted payload for GET asset detail — who must act at this stage. */
export async function getWorkflowAssigneePayloadForStage(stage) {
    if (!stage || [STAGE.COMPLETE, STAGE.REJECTED].includes(stage)) return null;
    const assignee = await resolveAssigneeForStage(stage);
    if (!assignee) return null;
    const displayName =
        `${assignee.firstName || ''} ${assignee.lastName || ''}`.trim() || assignee.employeeId || '—';
    return {
        _id: assignee._id || null,
        firstName: assignee.firstName,
        lastName: assignee.lastName,
        employeeId: assignee.employeeId,
        displayName
    };
}

/** Same authorization rules as POST .../service-workflow/respond (for UI). */
export async function userMayRespondVehicleServiceWorkflow(reqUser, stage) {
    if (!stage || [STAGE.COMPLETE, STAGE.REJECTED].includes(stage)) return false;
    const assignee = await resolveAssigneeForStage(stage);
    const roleKey = flowchartRoleKeyForStage(stage);
    if (assignee?._id) {
        if (await actorMayAct(reqUser, assignee)) return true;
    }
    if (roleKey && (await isUserInFlowchart(reqUser, roleKey).catch(() => false))) {
        return true;
    }
    if (!assignee?._id && !isPortalAdmin(reqUser)) {
        return !!(await isUserAdministrator(reqUser?.id));
    }
    return actorMayAct(reqUser, assignee);
}

export async function mergeWorkflowServiceRecord(asset, serviceRecordId, body) {
    if (!serviceRecordId || !body || typeof body !== 'object') return;
    const sub = asset.services.id(serviceRecordId);
    if (!sub) return;

    const {
        serviceType,
        date,
        scheduledServiceDate,
        serviceDurationDays,
        expiryDate,
        currentKm,
        description,
        paidBy,
        value,
        remark,
        invoice,
        completionReport,
        shopInvoice,
        attachment,
        quotation2,
        quotation3,
        tireCondition,
        bodyWorkImages,
        returnOtherDoc,
        newConditionImages,
        garageBillAttachment,
    } = body;

    // Return-to-live files: workshop completion report vs shop invoice (legacy invoice key treated as completion when shopInvoice omitted).
    const completionBlob =
        completionReport?.data ? completionReport : !shopInvoice?.data && invoice?.data ? invoice : null;
    const shopBlob = shopInvoice?.data ? shopInvoice : null;

    let serviceCompletionReportUrl =
        String(sub.serviceCompletionReport || '').trim() || null;
    if (completionBlob?.data) {
        try {
            const uploadResult = await uploadDocumentToS3(
                completionBlob.data,
                'asset-service-workflow-completion',
                completionBlob.name || `service-completion-${Date.now()}.pdf`
            );
            serviceCompletionReportUrl = uploadResult.publicId;
        } catch (error) {
            console.error('[mergeWorkflowServiceRecord] completion report upload:', error);
            throw new Error('Failed to upload service completion document');
        }
    }

    let shopInvoiceDocUrl = String(sub.shopInvoice || '').trim() || null;
    if (shopBlob?.data) {
        try {
            const uploadResult = await uploadDocumentToS3(shopBlob.data, 'asset-service-invoices', shopBlob.name || 'invoice');
            shopInvoiceDocUrl = uploadResult.publicId;
        } catch (error) {
            console.error('[mergeWorkflowServiceRecord] shop invoice upload:', error);
            throw new Error('Failed to upload shop invoice');
        }
    }

    let attachmentUrl = sub.attachment || null;
    if (attachment && attachment.data) {
        try {
            const uploadResult = await uploadDocumentToS3(
                attachment.data,
                'asset-service-attachments',
                attachment.name || `service-attachment-${Date.now()}.pdf`
            );
            attachmentUrl = uploadResult.publicId;
        } catch (error) {
            console.error('[mergeWorkflowServiceRecord] attachment upload:', error);
            throw new Error('Failed to upload attachment');
        }
    }

    let quotation2Url = sub.quotation2 || null;
    if (quotation2 && quotation2.data) {
        try {
            const uploadResult = await uploadDocumentToS3(
                quotation2.data,
                'asset-service-attachments',
                quotation2.name || `service-quotation2-${Date.now()}.pdf`
            );
            quotation2Url = uploadResult.publicId;
        } catch (error) {
            console.error('[mergeWorkflowServiceRecord] quotation2 upload:', error);
            throw new Error('Failed to upload quotation 2');
        }
    }

    let quotation3Url = sub.quotation3 || null;
    if (quotation3 && quotation3.data) {
        try {
            const uploadResult = await uploadDocumentToS3(
                quotation3.data,
                'asset-service-attachments',
                quotation3.name || `service-quotation3-${Date.now()}.pdf`
            );
            quotation3Url = uploadResult.publicId;
        } catch (error) {
            console.error('[mergeWorkflowServiceRecord] quotation3 upload:', error);
            throw new Error('Failed to upload quotation 3');
        }
    }

    if (serviceType != null) sub.serviceType = serviceType;
    if (scheduledServiceDate) {
        sub.date = new Date(scheduledServiceDate);
    } else if (date != null) {
        sub.date = new Date(date);
    }
    if (expiryDate !== undefined) sub.expiryDate = expiryDate ? new Date(expiryDate) : null;
    if (currentKm !== undefined) sub.currentKm = currentKm != null ? Number(currentKm) : null;
    if (description != null) sub.description = description;
    if (paidBy != null) sub.paidBy = paidBy;
    if (value !== undefined) sub.value = Number(value) || 0;

    let remarkMeta = parseRemarkMeta(sub.remark);
    if (remark !== undefined) {
        try {
            const incoming = typeof remark === 'string' ? JSON.parse(remark) : remark;
            if (incoming && typeof incoming === 'object') {
                const incomingRemark = { ...incoming };
                if (Array.isArray(incomingRemark.bodyWorkImages) && incomingRemark.bodyWorkImages.length === 0) {
                    delete incomingRemark.bodyWorkImages;
                }
                if (Array.isArray(incomingRemark.newConditionImages)) {
                    delete incomingRemark.newConditionImages;
                }
                remarkMeta = { ...remarkMeta, ...incomingRemark };
            }
        } catch {
            /* keep parsed remarkMeta */
        }
    }

    if (Number.isFinite(Number(serviceDurationDays)) && Number(serviceDurationDays) >= 1) {
        const n = Math.floor(Number(serviceDurationDays));
        sub.serviceDuration = `${n} day${n === 1 ? '' : 's'}`;
        if (scheduledServiceDate) {
            remarkMeta.adminScheduledServiceDate = String(scheduledServiceDate).slice(0, 10);
        }
        remarkMeta.adminServiceDurationDays = n;
    }
    if (serviceCompletionReportUrl != null) sub.serviceCompletionReport = serviceCompletionReportUrl;
    if (shopInvoiceDocUrl != null) sub.shopInvoice = shopInvoiceDocUrl;
    if (attachmentUrl != null) sub.attachment = attachmentUrl;
    if (quotation2Url != null) sub.quotation2 = quotation2Url;
    if (quotation3Url != null) sub.quotation3 = quotation3Url;

    if (tireCondition?.data) {
        try {
            const uploadResult = await uploadDocumentToS3(
                tireCondition.data,
                'asset-service-attachments',
                tireCondition.name || `service-tire-condition-${Date.now()}.jpg`,
            );
            remarkMeta.tireConditionUrl = uploadResult.publicId;
            remarkMeta.tireConditionName = tireCondition.name || '';
        } catch (error) {
            console.error('[mergeWorkflowServiceRecord] tireCondition upload:', error);
            throw new Error('Failed to upload tire condition file');
        }
    }
    if (garageBillAttachment?.data) {
        try {
            const uploadResult = await uploadDocumentToS3(
                garageBillAttachment.data,
                'asset-service-attachments',
                garageBillAttachment.name || `garage-bill-attachment-${Date.now()}.pdf`,
            );
            remarkMeta.garageAttachmentUrl = uploadResult.publicId;
            remarkMeta.garageBillAttachmentUrl = uploadResult.publicId;
            remarkMeta.garageAttachmentName =
                garageBillAttachment.name || remarkMeta.garageAttachmentName || '';
        } catch (error) {
            console.error('[mergeWorkflowServiceRecord] garageBillAttachment upload:', error);
            throw new Error('Failed to upload garage bill attachment');
        }
    }
    if (Array.isArray(bodyWorkImages) && bodyWorkImages.length) {
        const uploaded = [];
        for (const img of bodyWorkImages) {
            if (!img?.data) continue;
            try {
                const uploadResult = await uploadDocumentToS3(
                    img.data,
                    'asset-service-attachments',
                    img.name || `body-work-image-${Date.now()}.jpg`,
                );
                uploaded.push({
                    url: uploadResult.publicId,
                    name: img.name || 'Rectification photo',
                });
            } catch (error) {
                console.error('[mergeWorkflowServiceRecord] bodyWorkImages upload:', error);
                throw new Error('Failed to upload rectification photos');
            }
        }
        if (uploaded.length) {
            const existing = Array.isArray(remarkMeta.bodyWorkImages) ? remarkMeta.bodyWorkImages : [];
            remarkMeta.bodyWorkImages = [...existing, ...uploaded];
        }
    }
    if (returnOtherDoc?.data) {
        try {
            const uploadResult = await uploadDocumentToS3(
                returnOtherDoc.data,
                'asset-service-invoices',
                returnOtherDoc.name || `return-other-doc-${Date.now()}.pdf`,
            );
            sub.invoice = uploadResult.publicId;
            remarkMeta.returnOtherDocUrl = uploadResult.publicId;
            remarkMeta.returnOtherDocName = returnOtherDoc.name || '';
        } catch (error) {
            console.error('[mergeWorkflowServiceRecord] returnOtherDoc upload:', error);
            throw new Error('Failed to upload other document');
        }
    }
    if (Array.isArray(newConditionImages) && newConditionImages.length) {
        const uploaded = [];
        for (const img of newConditionImages) {
            if (!img?.data) continue;
            try {
                const uploadResult = await uploadDocumentToS3(
                    img.data,
                    'asset-service-attachments',
                    img.name || `new-condition-image-${Date.now()}.jpg`,
                );
                uploaded.push({
                    url: uploadResult.publicId,
                    name: img.name || 'New condition photo',
                });
            } catch (error) {
                console.error('[mergeWorkflowServiceRecord] newConditionImages upload:', error);
                throw new Error('Failed to upload new condition photos');
            }
        }
        if (uploaded.length) {
            const existing = Array.isArray(remarkMeta.newConditionImages) ? remarkMeta.newConditionImages : [];
            remarkMeta.newConditionImages = [...existing, ...uploaded];
        }
    }

    if (
        remark !== undefined ||
        tireCondition?.data ||
        (Array.isArray(bodyWorkImages) && bodyWorkImages.length) ||
        returnOtherDoc?.data ||
        (Array.isArray(newConditionImages) && newConditionImages.length) ||
        Number.isFinite(Number(serviceDurationDays))
    ) {
        sub.remark = JSON.stringify(remarkMeta);
    }

    const ck = body.currentKm != null ? Number(body.currentKm) : null;
    if (ck && !Number.isNaN(ck) && ck > (asset.currentKilometer || 0)) {
        asset.currentKilometer = ck;
    }

    asset.markModified('services');
}

async function pushWorkflowHistory(asset, { stage, action, note, byName, bySignatureUrl }) {
    if (!asset.activeServiceWorkflow) asset.activeServiceWorkflow = {};
    if (!Array.isArray(asset.activeServiceWorkflow.history)) asset.activeServiceWorkflow.history = [];
    asset.activeServiceWorkflow.history.push({
        stage,
        action,
        note: note || '',
        byName: byName || '',
        bySignatureUrl: bySignatureUrl || '',
        at: new Date()
    });
}

/** Save final workflow timeline on the services[] subdoc so fleet/history views keep the tracker after a new workflow starts. */
function persistWorkflowSnapshotToServiceSubdoc(asset) {
    const wf = asset.activeServiceWorkflow;
    if (!wf?.serviceRecordId) return;
    const sub = asset.services?.id?.(wf.serviceRecordId);
    if (!sub) return;
    const hist = Array.isArray(wf.history) ? wf.history : [];
    sub.workflowSnapshot = {
        stage: wf.stage,
        serviceTypeLabel: wf.serviceTypeLabel || '',
        serviceRecordId: wf.serviceRecordId,
        history: hist.map((h) => ({
            stage: h.stage,
            action: h.action,
            note: h.note || '',
            byName: h.byName || '',
            bySignatureUrl: h.bySignatureUrl || '',
            at: h.at,
        })),
    };
    asset.markModified('services');
}

const STAGE_LABEL = {
    [STAGE.HR]: 'HR',
    [STAGE.ACCOUNTS]: 'Accounts',
    [STAGE.ADMIN]: 'On service (Asset Controller)',
    [STAGE.SCHEDULED]: 'Scheduled service',
    [STAGE.MANAGEMENT]: 'Management'
};

/**
 * Mirrors workflow steps into AssetHistory so the vehicle History tab lists approvals/rejects alongside other events.
 */
async function logVehicleServiceWorkflowToAssetHistory(asset, {
    stage,
    workflowAction,
    note,
    byName,
    performedById,
    serviceTypeLabel,
    hasServiceUpdates,
    serviceRecordId: serviceRecordIdOverride
}) {
    try {
        const label = STAGE_LABEL[stage] || stage;
        const svc = serviceTypeLabel || asset.activeServiceWorkflow?.serviceTypeLabel || '';
        let comments = '';
        if (workflowAction === 'start') {
            comments = `Approval workflow started (awaiting ${label})${svc ? `: ${svc}` : ''}`;
            if (note) comments += `. ${note}`;
        } else if (workflowAction === 'reject') {
            comments = `Service approval rejected at ${label}`;
            if (note) comments += `: ${note}`;
        } else if (workflowAction === 'approve') {
            comments = `Approved at ${label}`;
            if (hasServiceUpdates) comments += ' (service record updated)';
            if (note) comments += `. ${note}`;
        } else if (workflowAction === 'hold') {
            comments = `Accounts hold: ${note || '—'}`;
        }

        await AssetHistory.create({
            assetId: asset._id,
            action: 'Service',
            performedBy: performedById || undefined,
            comments,
            details: {
                type: 'VehicleServiceWorkflow',
                serviceRecordId:
                    serviceRecordIdOverride ?? (asset.activeServiceWorkflow?.serviceRecordId || null),
                stage,
                workflowAction,
                note: note || '',
                byName: byName || '',
                serviceTypeLabel: svc,
                hasServiceUpdates: !!hasServiceUpdates
            },
            date: new Date()
        });
    } catch (e) {
        console.error('[VehicleServiceWorkflow] AssetHistory log failed:', e);
    }
}

/**
 * Called after POST /AssetItem/:id/service saves a new service line on a vehicle.
 */
export async function maybeStartVehicleServiceWorkflow(asset, { serviceRecordId, serviceType, req }) {
    try {
        const typeDoc = await AssetType.findById(asset.typeId).select('name').lean();
        const tname = (typeDoc?.name || '').toLowerCase();
        const isVehicle =
            !!(asset.plateNumber && String(asset.plateNumber).trim()) ||
            tname.includes('vehicle') ||
            tname.includes('car') ||
            tname.includes('truck') ||
            tname.includes('fleet') ||
            tname.includes('van');

        if (!isVehicle) return;

        if (String(serviceType || '').trim() === 'Oil Service') {
            return;
        }

        const requesterName = await getRequesterName(req.user);
        const isAccidentRepair = String(serviceType || '').trim() === 'Accident Repair';

        if (isAccidentRepair) {
            const adminOfficer = await getDepartmentHOD('admincontroller');

            if (asset.activeServiceWorkflow?.serviceRecordId) {
                persistWorkflowSnapshotToServiceSubdoc(asset);
            }

            asset.activeServiceWorkflow = {
                serviceRecordId,
                stage: ACCIDENT_REPAIR_STAGE.ADMIN_OFFICER,
                previousStatus: asset.status,
                serviceTypeLabel: serviceType || '',
                history: [],
            };
            await pushWorkflowHistory(asset, {
                stage: ACCIDENT_REPAIR_STAGE.ADMIN_OFFICER,
                action: 'created',
                note: 'Accident repair assignment submitted',
                byName: requesterName,
            });

            const requesterEmp = req?.user ? await resolveActorEmployee(req.user) : null;
            await logVehicleServiceWorkflowToAssetHistory(asset, {
                stage: ACCIDENT_REPAIR_STAGE.ADMIN_OFFICER,
                workflowAction: 'start',
                note: 'Accident repair assignment submitted',
                byName: requesterName,
                performedById: requesterEmp?._id,
                serviceTypeLabel: serviceType || '',
                hasServiceUpdates: false,
                serviceRecordId,
            });

            if (adminOfficer?._id) {
                await notifyAccidentRepairStakeholder({
                    asset,
                    serviceRecordId,
                    recipient: adminOfficer,
                    requestedByName: requesterName,
                    extra2: 'Complete Garage / Service Details',
                    stageLabel: 'Garage details required',
                    actionLabel: 'Accident repair — garage update',
                    detailLine: `${requesterName} submitted the Vehicle Accident Form. Please open the Accident Repair page, complete Garage / Service Details, and click Done.`,
                });
            }

            persistWorkflowSnapshotToServiceSubdoc(asset);
            asset.markModified('activeServiceWorkflow');
            await asset.save();
            return;
        }

        const cur = asset.activeServiceWorkflow;
        // Snapshot any in-progress (or finished) workflow onto its service row so a new
        // request can start while a previous same-type service is still ending.
        if (cur?.serviceRecordId) {
            persistWorkflowSnapshotToServiceSubdoc(asset);
        }

        const hr = await resolveAssigneeForStage(STAGE.HR);
        if (!hr?._id) {
            console.warn('[VehicleServiceWorkflow] No Flowchart HR — workflow not started');
            return;
        }

        const populated = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId').lean();
        const subjectEmp = populated?.assignedTo || null;

        asset.activeServiceWorkflow = {
            serviceRecordId,
            stage: STAGE.HR,
            previousStatus: asset.status,
            serviceTypeLabel: serviceType || '',
            history: []
        };
        await pushWorkflowHistory(asset, {
            stage: STAGE.HR,
            action: 'created',
            note: `Service logged: ${serviceType}`,
            byName: await getRequesterName(req.user)
        });

        const requesterEmp = req?.user ? await resolveActorEmployee(req.user) : null;
        await logVehicleServiceWorkflowToAssetHistory(asset, {
            stage: STAGE.HR,
            workflowAction: 'start',
            note: `Service logged: ${serviceType}`,
            byName: await getRequesterName(req.user),
            performedById: requesterEmp?._id,
            serviceTypeLabel: serviceType || '',
            hasServiceUpdates: false,
            serviceRecordId
        });

        const isTireChange = String(serviceType || '').trim() === 'Tire Change';
        const plate = [asset.plateEmirate, asset.plateNumber].filter(Boolean).join(' ').trim();
        const assetLabel = `${asset.assetId || ''}${plate ? ` (${plate})` : ''}`.trim();

        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Service Request',
            status: 'Pending',
            assignedTo: hr._id,
            subjectEmployee: subjectEmp,
            subjectName: asset.name || asset.assetId || 'Vehicle',
            requestedByName: requesterName,
            extra1: `${asset.assetId} — ${serviceType || 'Service'}`,
            extra2: isTireChange
                ? 'Tire change submitted — review quotations'
                : 'Awaiting HR approval',
            extra3: vehicleServiceDashboardMeta(asset, serviceRecordId, serviceType),
        });

        await sendWorkflowEmailWithConsole({
            recipient: hr,
            asset,
            stageLabel: isTireChange ? 'HR quotation review required' : 'HR approval required',
            actionLabel: isTireChange ? 'Tire change — quotation review' : 'New vehicle service request',
            detailLine: isTireChange
                ? `${requesterName} submitted a tire change request for ${assetLabel}. Open the Tire Change details page, drag Quote 1/2/3 into Approved Quote, then approve or reject.`
                : `${requesterName} logged a service (${serviceType}). Please approve or reject in your dashboard.`,
            linkPath: vehicleServiceDetailsPath(asset._id, serviceRecordId, serviceType),
        });

        persistWorkflowSnapshotToServiceSubdoc(asset);
        asset.markModified('activeServiceWorkflow');
        await asset.save();
    } catch (e) {
        console.error('[VehicleServiceWorkflow] start failed:', e);
    }
}

/**
 * Car Wash: skip HR/Admin/Scheduled — submit goes straight to Accounts validation.
 */
export async function maybeStartCarWashWorkflow(asset, { serviceRecordId, req }) {
    try {
        const serviceSub = asset.services?.id?.(serviceRecordId);
        if (!serviceSub) return;

        const cur = asset.activeServiceWorkflow;
        if (cur?.serviceRecordId) {
            persistWorkflowSnapshotToServiceSubdoc(asset);
        }

        const accounts = await resolveAssigneeForStage(STAGE.ACCOUNTS);
        if (!accounts?._id) {
            console.warn('[CarWashWorkflow] No Flowchart Accounts — workflow not started');
            return;
        }

        setCarWashPaymentStatusOnService(serviceSub, CAR_WASH_PAYMENT_PENDING);

        asset.activeServiceWorkflow = {
            serviceRecordId,
            stage: STAGE.ACCOUNTS,
            previousStatus: asset.status,
            serviceTypeLabel: 'Car Wash',
            history: [],
        };

        const requesterName = await getRequesterName(req.user);
        const requesterEmp = req?.user ? await resolveActorEmployee(req.user) : null;

        await pushWorkflowHistory(asset, {
            stage: STAGE.ACCOUNTS,
            action: 'created',
            note: 'Car wash request submitted for Accounts validation',
            byName: requesterName,
        });

        await logVehicleServiceWorkflowToAssetHistory(asset, {
            stage: STAGE.ACCOUNTS,
            workflowAction: 'start',
            note: 'Car wash request submitted for Accounts validation',
            byName: requesterName,
            performedById: requesterEmp?._id,
            serviceTypeLabel: 'Car Wash',
            hasServiceUpdates: false,
            serviceRecordId,
        });

        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Service Request',
            status: 'Pending',
            assignedTo: accounts._id,
            subjectEmployee: asset.assignedTo,
            requestedByName: requesterName,
            extra1: `${asset.assetId} — Car Wash`,
            extra2: 'Awaiting Accounts validation',
            extra3: carWashDashboardMeta(asset, serviceRecordId),
        });

        await sendWorkflowEmailWithConsole({
            recipient: accounts,
            asset,
            stageLabel: 'Accounts validation required',
            actionLabel: 'New car wash request',
            detailLine: `${requesterName} submitted a car wash request. Please validate the amount in VeRP.`,
            linkPath: carWashDetailsPath(asset._id, serviceRecordId),
        });

        persistWorkflowSnapshotToServiceSubdoc(asset);
        asset.markModified('activeServiceWorkflow');
        asset.markModified('services');
        await asset.save();
    } catch (e) {
        console.error('[CarWashWorkflow] start failed:', e);
    }
}

/**
 * POST /api/AssetItem/:id/service-workflow/respond
 * body: { action: 'approve' | 'reject' | 'hold' | 'unhold', comment?, serviceUpdates?, holdReason?, holdDays?, holdUntilDate? }
 * - hold: Accounts step only; requires holdReason + holdUntilDate (or holdDays for legacy payloads).
 * serviceUpdates uses the same shape as POST /AssetItem/:id/service (optional on approve).
 */
export const respondVehicleServiceWorkflow = async (req, res) => {
    try {
        const { id } = req.params;
        const { action, comment, serviceUpdates, holdReason, holdDays, holdUntilDate } = req.body || {};
        if (!['approve', 'reject', 'hold', 'unhold', 'save'].includes(action)) {
            return res.status(400).json({ message: 'action must be approve, reject, hold, unhold, or save' });
        }

        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const wf = asset.activeServiceWorkflow;
        if (!wf?.stage || [STAGE.COMPLETE, STAGE.REJECTED].includes(wf.stage)) {
            return res.status(400).json({ message: 'No active service workflow for this vehicle' });
        }

        const stage = wf.stage;
        if (stage === STAGE.SCHEDULED) {
            return res.status(400).json({
                message:
                    'This request is in the scheduled service window. Use Extend or Mark live (POST .../service-workflow/period), not the approval endpoint.',
            });
        }
        let assignee = await resolveAssigneeForStage(stage);
        const roleKey = flowchartRoleKeyForStage(stage);
        const actorEmpEarly = await resolveActorEmployee(req.user);
        // UI may show Approve via flowchart row match while HOD lookup failed —
        // if the actor is the Flowchart role holder, treat them as the assignee.
        if (!assignee?._id && roleKey && actorEmpEarly?._id) {
            const inRole = await isUserInFlowchart(req.user, roleKey).catch(() => false);
            if (inRole) {
                assignee = actorEmpEarly;
            }
        }
        const serviceSubEarly = wf.serviceRecordId ? asset.services?.id?.(wf.serviceRecordId) : null;
        const isOilServiceWf = isOilServiceWorkflowRecord(wf, serviceSubEarly);
        const oilServiceManager = isOilServiceWf ? await actorMayManageOilServiceForAsset(req.user, asset) : false;
        const oilCashAtPaymentStage =
            isOilServiceWf &&
            isOilServiceCashPayment(serviceSubEarly) &&
            [STAGE.HR, STAGE.ACCOUNTS].includes(stage);
        const oilManagerStage =
            isOilServiceWf &&
            oilServiceManager &&
            !oilCashAtPaymentStage &&
            [STAGE.HR, STAGE.ACCOUNTS, STAGE.ADMIN].includes(stage) &&
            ['approve', 'save'].includes(action);

        if (!assignee?._id && !isPortalAdmin(req.user) && !oilManagerStage) {
            return res.status(503).json({ message: missingAssigneeMessage(stage) });
        }

        // Cash Oil HR / Accounts: only the flowchart assignee — no Super User / admin bypass.
        let allowed = false;
        if (oilCashAtPaymentStage) {
            if (!assignee?._id) {
                return res.status(503).json({
                    message:
                        stage === STAGE.HR
                            ? 'Flowchart HR is not configured for this approval step.'
                            : 'Flowchart Accounts is not configured for this approval step.',
                });
            }
            const actor = actorEmpEarly || (await resolveActorEmployee(req.user));
            allowed = !!(actor?._id && String(actor._id) === String(assignee._id));
        } else {
            allowed = (await actorMayAct(req.user, assignee)) || oilManagerStage;
            // Align with UI: flowchart role holders may act even if HOD doc was partially linked.
            if (!allowed && roleKey) {
                allowed = await isUserInFlowchart(req.user, roleKey).catch(() => false);
            }
        }
        if (!allowed) {
            return res.status(403).json({
                message: oilCashAtPaymentStage
                    ? stage === STAGE.HR
                        ? 'Only the flowchart HR can approve this oil service schedule step.'
                        : 'Only the flowchart Accounts user can approve this oil service billing step.'
                    : 'You are not authorized for this workflow step',
            });
        }

        const actorName =
            (await getRequesterName(req.user)) ||
            `${(await resolveActorEmployee(req.user))?.firstName || ''}`;
        const actorEmp = await resolveActorEmployee(req.user);
        const actorSignatureUrl = String(actorEmp?.signature?.url || '').trim();
        const performedById = actorEmp?._id;

        if (action === 'approve' && (stage === STAGE.HR || stage === STAGE.ACCOUNTS) && !actorSignatureUrl) {
            const oilBypass =
                isOilServiceWf && oilServiceManager && stage === STAGE.HR && !oilCashAtPaymentStage;
            if (!oilBypass) {
                return res.status(400).json({
                    message: 'Digital signature is required. Please add your signature in profile before approval.',
                });
            }
        }

        if (action === 'save') {
            if (!wf.serviceRecordId) {
                return res.status(400).json({ message: 'No service record linked to this workflow.' });
            }
            if (!serviceUpdates || typeof serviceUpdates !== 'object') {
                return res.status(400).json({ message: 'serviceUpdates is required to save request details.' });
            }
            try {
                await mergeWorkflowServiceRecord(asset, wf.serviceRecordId, serviceUpdates);
            } catch (mergeErr) {
                return res.status(400).json({ message: mergeErr.message || 'Could not update service record' });
            }
            persistWorkflowSnapshotToServiceSubdoc(asset);
            asset.markModified('services');
            await asset.save();
            const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
            return res.json({ message: 'Request details saved', asset: fresh });
        }

        if (action === 'hold') {
            if (stage !== STAGE.ACCOUNTS) {
                return res.status(400).json({ message: 'Hold is only available at the Accounts step' });
            }
            const reason = String(holdReason || '').trim();
            if (!reason) {
                return res.status(400).json({ message: 'Hold reason is required' });
            }
            let holdUntil = null;
            if (holdUntilDate) {
                holdUntil = new Date(holdUntilDate);
            } else if (Number.isFinite(Number(holdDays)) && Number(holdDays) >= 1) {
                holdUntil = new Date(Date.now() + Number(holdDays) * 24 * 60 * 60 * 1000);
            }
            if (!holdUntil || Number.isNaN(holdUntil.getTime())) {
                return res.status(400).json({ message: 'Hold date is required' });
            }
            const now = new Date();
            const msPerDay = 24 * 60 * 60 * 1000;
            const daysNum = Math.max(1, Math.ceil((holdUntil.getTime() - now.getTime()) / msPerDay));
            const remindAt = new Date(holdUntil.getTime() - msPerDay);
            if (!asset.activeServiceWorkflow.accountsHold) asset.activeServiceWorkflow.accountsHold = {};
            asset.activeServiceWorkflow.accountsHold = {
                reason,
                days: daysNum,
                heldAt: now,
                holdUntilDate: holdUntil,
                remindAt,
                reminderSentAt: null,
            };
            await pushWorkflowHistory(asset, {
                stage,
                action: 'hold',
                note: `${reason} (until ${holdUntil.toISOString().slice(0, 10)})`,
                byName: actorName,
                bySignatureUrl: actorSignatureUrl,
            });
            await logVehicleServiceWorkflowToAssetHistory(asset, {
                stage,
                workflowAction: 'hold',
                note: `${reason} (until ${holdUntil.toISOString().slice(0, 10)})`,
                byName: actorName,
                performedById,
                serviceTypeLabel: wf.serviceTypeLabel,
                hasServiceUpdates: false,
                serviceRecordId: wf.serviceRecordId
            });
            persistWorkflowSnapshotToServiceSubdoc(asset);
            asset.markModified('activeServiceWorkflow');
            await asset.save();
            if (isTireWf) {
                await notifyTireChangeAccountsHoldToAdmin(asset, asset.activeServiceWorkflow, reason, actorName);
            } else {
                try {
                    const hr = await resolveAssigneeForStage(STAGE.HR);
                    if (hr?._id) {
                        await sendWorkflowEmailWithConsole({
                            recipient: hr,
                            asset,
                            stageLabel: 'Accounts hold',
                            actionLabel: 'Vehicle service request is on hold',
                            detailLine: `Accounts placed this request on hold until ${holdUntil.toISOString().slice(0, 10)}. Reason: ${reason}.`,
                            linkPath: vehicleServiceDetailsPathForWorkflow(asset, wf),
                        });
                    }
                } catch (e) {
                    console.error('[VehicleServiceWorkflow] hold notify HR failed:', e);
                }
            }
            const holdFresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
            return res.json({
                message: `Hold recorded until ${holdUntil.toLocaleDateString()}`,
                asset: holdFresh
            });
        }

        if (action === 'unhold') {
            if (stage !== STAGE.ACCOUNTS) {
                return res.status(400).json({ message: 'Unhold is only available at the Accounts step' });
            }
            const hold = asset.activeServiceWorkflow?.accountsHold || null;
            if (!hold?.holdUntilDate) {
                return res.status(400).json({ message: 'This request is not currently on hold' });
            }

            asset.activeServiceWorkflow.accountsHold = null;
            await pushWorkflowHistory(asset, {
                stage,
                action: 'unhold',
                note: comment || 'Hold cleared',
                byName: actorName,
                bySignatureUrl: actorSignatureUrl,
            });
            await logVehicleServiceWorkflowToAssetHistory(asset, {
                stage,
                workflowAction: 'approve',
                note: comment || 'Hold cleared',
                byName: actorName,
                performedById,
                serviceTypeLabel: wf.serviceTypeLabel,
                hasServiceUpdates: false,
                serviceRecordId: wf.serviceRecordId
            });
            persistWorkflowSnapshotToServiceSubdoc(asset);
            asset.markModified('activeServiceWorkflow');
            await asset.save();
            const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
            return res.json({ message: 'Hold cleared. You can now approve or reject.', asset: fresh });
        }

        let hadServiceUpdates = false;
        if (action === 'approve' && stage === STAGE.HR && wf.serviceRecordId) {
            const serviceSub = asset.services?.id?.(wf.serviceRecordId);
            const incomingType = serviceUpdates?.serviceType || serviceSub?.serviceType || wf.serviceTypeLabel;
            const meta = parseRemarkMeta(serviceUpdates?.remark);
            const choice = String(meta?.approvedQuotationChoice || '').trim();
            if (requiresQuotationSelection(incomingType)) {
                const qCount = availableQuotationCount(serviceSub, serviceUpdates);
                if (qCount > 1) {
                    if (!choice || !['q1', 'q2', 'q3'].includes(choice)) {
                        return res.status(400).json({ message: 'HR must select one approved quotation before approval.' });
                    }
                    if (!selectedQuotationExists(choice, serviceSub, serviceUpdates)) {
                        return res.status(400).json({ message: 'Selected quotation file is missing.' });
                    }
                }
            }
        }

        if (action === 'approve' && stage === STAGE.ADMIN && wf.serviceRecordId) {
            const su = serviceUpdates || {};
            const startRaw = su.scheduledServiceDate || su.date;
            const durationDays = Number(su.serviceDurationDays);
            if (!startRaw) {
                return res.status(400).json({ message: 'Service date is required before Admin approval.' });
            }
            if (!Number.isFinite(durationDays) || durationDays < 1) {
                return res.status(400).json({ message: 'Service duration (days) is required and must be at least 1.' });
            }
        }

        if (action === 'approve' && serviceUpdates && wf.serviceRecordId) {
            try {
                await mergeWorkflowServiceRecord(asset, wf.serviceRecordId, serviceUpdates);
                hadServiceUpdates = true;
            } catch (mergeErr) {
                return res.status(400).json({ message: mergeErr.message || 'Could not update service record' });
            }
        }

        const serviceSubCarWash = wf.serviceRecordId ? asset.services?.id?.(wf.serviceRecordId) : null;
        const isCarWashWf = isCarWashServiceRecord(serviceSubCarWash, wf);
        if (action === 'approve' && stage === STAGE.ACCOUNTS && isCarWashWf) {
            const validatedAmount = Number(serviceSubCarWash?.value);
            if (!Number.isFinite(validatedAmount) || validatedAmount <= 0) {
                return res.status(400).json({ message: 'A valid amount is required before approval.' });
            }

            if (assignee?._id) {
                await syncDashboardAction({
                    requestId: asset._id,
                    requestType: 'Vehicle Service Request',
                    status: 'Approved',
                    assignedTo: assignee._id,
                    actionedBy: performedById,
                    comment: comment || 'Amount validated',
                    subjectEmployee: asset.assignedTo,
                    requestedByName: actorName,
                });
            }

            setCarWashPaymentStatusOnService(serviceSubCarWash, CAR_WASH_PAYMENT_NOT_PAID);
            asset.activeServiceWorkflow.stage = STAGE.COMPLETE;
            asset.status = resolveStatusAfterService(asset, wf);

            await pushWorkflowHistory(asset, {
                stage: STAGE.ACCOUNTS,
                action: 'approve',
                note: comment || 'Amount validated — Not paid',
                byName: actorName,
                bySignatureUrl: actorSignatureUrl,
            });
            await logVehicleServiceWorkflowToAssetHistory(asset, {
                stage: STAGE.ACCOUNTS,
                workflowAction: 'approve',
                note: comment || 'Amount validated — Not paid',
                byName: actorName,
                performedById,
                serviceTypeLabel: 'Car Wash',
                hasServiceUpdates: hadServiceUpdates,
                serviceRecordId: wf.serviceRecordId,
            });

            await closeCarWashPendingDashboardActions(asset._id, wf.serviceRecordId, {
                actionedBy: performedById,
                comment: comment || 'Car wash validated',
            });

            await closeAdminOfficerServiceTrackNotification({
                assetId: asset._id,
                serviceRecordId: wf.serviceRecordId,
                actionedBy: performedById,
                comment: comment || 'Car wash completed',
                requestedByName: actorName,
            });

            persistWorkflowSnapshotToServiceSubdoc(asset);
            asset.markModified('services');
            await asset.save();

            await notifyCarWashAccountsApproved({
                asset,
                serviceRecordId: wf.serviceRecordId,
                actorName,
                validatedAmount: serviceSubCarWash?.value,
            });

            const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
            return res.json({
                message: 'Car wash validated. Status updated to Not paid.',
                asset: fresh,
            });
        }

        if (action === 'approve' && stage === STAGE.HR && wf.serviceRecordId) {
            const serviceSub = asset.services?.id?.(wf.serviceRecordId);
            if (serviceSub && requiresQuotationSelection(serviceSub.serviceType || wf.serviceTypeLabel)) {
                keepOnlySelectedQuotationOnService(serviceSub);
                asset.markModified('services');
            }
        }

        if (action === 'reject') {
            if (assignee?._id) {
                await syncDashboardAction({
                    requestId: asset._id,
                    requestType: 'Vehicle Service Request',
                    status: 'Rejected',
                    assignedTo: assignee._id,
                    actionedBy: (await resolveActorEmployee(req.user))?._id,
                    comment: comment || 'Rejected',
                    subjectEmployee: asset.assignedTo,
                    requestedByName: actorName
                });
            }

            asset.status = resolveStatusAfterService(asset, wf);
            asset.activeServiceWorkflow.stage = STAGE.REJECTED;
            await pushWorkflowHistory(asset, { stage, action: 'reject', note: comment || '', byName: actorName, bySignatureUrl: actorSignatureUrl });
            await logVehicleServiceWorkflowToAssetHistory(asset, {
                stage,
                workflowAction: 'reject',
                note: comment || '',
                byName: actorName,
                performedById,
                serviceTypeLabel: wf.serviceTypeLabel,
                hasServiceUpdates: false,
                serviceRecordId: wf.serviceRecordId
            });
            persistWorkflowSnapshotToServiceSubdoc(asset);
            await asset.save();
            try {
                const serviceSub = asset.services?.id?.(wf.serviceRecordId);
                const requesterId = serviceSub?.requestedBy || null;
                if (requesterId) {
                    const requester = await EmployeeBasic.findById(requesterId).select('firstName lastName employeeId companyEmail workEmail personalEmail email').lean();
                    if (requester) {
                        await sendWorkflowEmailWithConsole({
                            recipient: requester,
                            asset,
                            stageLabel: 'Service request rejected',
                            actionLabel: 'Vehicle service rejected',
                            detailLine: `Your service request was rejected at ${STAGE_LABEL[stage] || stage}. Reason: ${comment || 'No reason provided'}. You can edit and re-submit.`,
                            linkPath: vehicleServiceDetailsPathForWorkflow(asset, wf),
                        });
                        await syncDashboardAction({
                            requestId: asset._id,
                            requestType: 'Vehicle Service Request',
                            status: 'Rejected',
                            assignedTo: requester._id,
                            actionedBy: (await resolveActorEmployee(req.user))?._id,
                            comment: comment || 'Rejected',
                            subjectEmployee: asset.assignedTo,
                            requestedByName: actorName,
                            extra1: `${asset.assetId} — ${wf.serviceTypeLabel || 'Service'}`,
                            extra2: `Rejected at ${STAGE_LABEL[stage] || stage}`,
                            extra3: vehicleServiceDashboardMetaForWorkflow(asset, wf),
                        });
                    }
                }
            } catch (notifyErr) {
                console.error('[VehicleServiceWorkflow] reject notify requester failed:', notifyErr);
            }
            const rejectedFresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
            return res.json({ message: 'Workflow rejected', asset: rejectedFresh });
        }

        // approve — close this assignee's pending row when possible
        if (assignee?._id) {
            await syncDashboardAction({
                requestId: asset._id,
                requestType: 'Vehicle Service Request',
                status: 'Approved',
                assignedTo: assignee._id,
                actionedBy: (await resolveActorEmployee(req.user))?._id,
                comment: comment || '',
                subjectEmployee: asset.assignedTo,
                requestedByName: actorName
            });
        }

        await pushWorkflowHistory(asset, { stage, action: 'approve', note: comment || '', byName: actorName, bySignatureUrl: actorSignatureUrl });
        await logVehicleServiceWorkflowToAssetHistory(asset, {
            stage,
            workflowAction: 'approve',
            note: comment || '',
            byName: actorName,
            performedById,
            serviceTypeLabel: wf.serviceTypeLabel,
            hasServiceUpdates: hadServiceUpdates,
            serviceRecordId: wf.serviceRecordId
        });

        const serviceSubForOil = wf.serviceRecordId ? asset.services?.id?.(wf.serviceRecordId) : null;
        const isTireWf = isTireChangeWorkflow(wf, serviceSubForOil);
        const isMechWf = isMechanicalWorkWorkflow(wf, serviceSubForOil);
        const isBodyWf = isBodyWorkWorkflow(wf, serviceSubForOil);
        const isAccWf = isAccidentRepairWorkflow(wf, serviceSubForOil);
        const oilServiceType = isOilServiceWorkflowRecord(wf, serviceSubForOil);
        const oilCashPayment = oilServiceType && isOilServiceCashPayment(serviceSubForOil || parseOilServiceRemark(serviceSubForOil));

        // Cash oil: End Service → HR → Accounts → Zoho (do not jump to complete).
        if (action === 'approve' && oilCashPayment && stage === STAGE.HR) {
            persistWorkflowSnapshotToServiceSubdoc(asset);
            await advanceOilCashAfterHrApprove(asset, asset.activeServiceWorkflow, actorName);
            const oilHrFresh = await AssetItem.findById(asset._id).populate(
                'assignedTo',
                'firstName lastName employeeId',
            );
            return res.json({
                message: 'HR approved schedule — vehicle can go On Service on the start date.',
                asset: oilHrFresh,
            });
        }

        if (action === 'approve' && oilCashPayment && stage === STAGE.ACCOUNTS) {
            persistWorkflowSnapshotToServiceSubdoc(asset);
            const oilAccResult = await advanceOilCashAfterAccountsApprove(
                asset,
                asset.activeServiceWorkflow,
                actorName,
            );
            const oilAccFresh = await AssetItem.findById(asset._id).populate(
                'assignedTo',
                'firstName lastName employeeId',
            );
            const zohoBillSync = oilAccResult?.zohoBillSync || null;
            return res.json({
                message: `Billed. ${zohoBillSync?.message || 'Zoho bill created.'}`,
                zohoBillMessage: zohoBillSync?.message || '',
                zohoBillId: zohoBillSync?.billId || '',
                zohoBillOk: true,
                asset: oilAccFresh,
            });
        }

        if (
            action === 'approve' &&
            oilServiceType &&
            oilServiceManager &&
            [STAGE.HR, STAGE.ACCOUNTS, STAGE.ADMIN].includes(stage) &&
            !oilCashPayment
        ) {
            const meta = parseRemarkMeta(serviceSubForOil?.remark);
            const handOverRaw = meta.handOverDate;
            const returnRaw = meta.returnDate;
            if (!handOverRaw || !returnRaw) {
                return res.status(400).json({
                    message: 'Hand over date and return date are required before submitting service details.',
                });
            }
            const startD = new Date(handOverRaw);
            const endD = new Date(returnRaw);
            if (Number.isNaN(startD.getTime()) || Number.isNaN(endD.getTime())) {
                return res.status(400).json({ message: 'Invalid hand over or return date.' });
            }
            const msPerDay = 24 * 60 * 60 * 1000;
            const durationDays = Math.max(
                1,
                Math.floor((utcDayStart(endD) - utcDayStart(startD)) / msPerDay) + 1,
            );

            if (!asset.activeServiceWorkflow) asset.activeServiceWorkflow = {};
            asset.activeServiceWorkflow.scheduledServiceDate = startD;
            asset.activeServiceWorkflow.serviceWindowEndDate = endD;
            asset.activeServiceWorkflow.serviceDurationDays = durationDays;
            asset.activeServiceWorkflow.stage = STAGE.COMPLETE;
            if (serviceSubForOil) {
                serviceSubForOil.serviceDuration = `${durationDays} day${durationDays === 1 ? '' : 's'}`;
                const remarkComplete = parseRemarkMeta(serviceSubForOil.remark);
                remarkComplete.vehicleServiceCompleted = 'live';
                remarkComplete.vehicleServiceCompletedAt = new Date().toISOString();
                serviceSubForOil.remark = JSON.stringify(remarkComplete);
            }
            asset.status = resolveStatusAfterService(asset, wf);
            persistWorkflowSnapshotToServiceSubdoc(asset);
            asset.markModified('services');
            asset.markModified('activeServiceWorkflow');
            await asset.save();
            const performedBy = (await resolveActorEmployee(req.user))?._id;
            await closeOilServicePendingDashboardActions(asset._id, wf.serviceRecordId, {
                comment: 'Oil service completed. Vehicle status restored.',
                actionedBy: performedBy,
            });
            await closeAdminOfficerServiceTrackNotification({
                assetId: asset._id,
                serviceRecordId: wf.serviceRecordId,
                actionedBy: performedBy,
                comment: 'Oil service completed. Vehicle status restored.',
                requestedByName: actorName,
            });
            const oilFresh = await AssetItem.findById(asset._id).populate(
                'assignedTo',
                'firstName lastName employeeId',
            );
            return res.json({
                message: 'Oil service completed. Vehicle status restored.',
                asset: oilFresh,
            });
        }

        if (
            action === 'approve' &&
            (isTireWf || isMechWf || isBodyWf || isAccWf) &&
            stage === 'pending_billing'
        ) {
            persistWorkflowSnapshotToServiceSubdoc(asset);
            const { advanceShopBillingAfterAccountsApprove } = await import(
                '../utils/vehicleShopServiceScheduled.js'
            );
            const label = isTireWf
                ? 'Tire Change'
                : isMechWf
                  ? 'Mechanical Work'
                  : isBodyWf
                    ? 'Body Work'
                    : 'Accident Repair';
            const append =
                isTireWf
                    ? appendTireChangeActivity
                    : isMechWf
                      ? appendMechanicalWorkActivity
                      : isBodyWf
                        ? appendBodyWorkActivity
                        : appendAccidentRepairActivity;
            const billResult = await advanceShopBillingAfterAccountsApprove(
                asset,
                asset.activeServiceWorkflow,
                actorName,
                { serviceTypeLabel: label, appendActivity: append },
            );
            const billFresh = await AssetItem.findById(asset._id).populate(
                'assignedTo',
                'firstName lastName employeeId',
            );
            const zohoBillSync = billResult?.zohoBillSync || null;
            return res.json({
                message: `Billed. ${zohoBillSync?.message || 'Zoho bill created.'}`,
                zohoBillMessage: zohoBillSync?.message || '',
                zohoBillId: zohoBillSync?.billId || '',
                zohoBillOk: true,
                asset: billFresh,
            });
        }

        if (
            action === 'approve' &&
            isTireWf &&
            stage === STAGE.HR
        ) {
            persistWorkflowSnapshotToServiceSubdoc(asset);
            await advanceTireChangeAfterHrApprove(asset, asset.activeServiceWorkflow, actorName);
            const tireHrFresh = await AssetItem.findById(asset._id).populate(
                'assignedTo',
                'firstName lastName employeeId',
            );
            return res.json({ message: 'HR approved — sent to Admin Officer for garage details', asset: tireHrFresh });
        }

        if (
            action === 'approve' &&
            isTireWf &&
            stage === STAGE.ACCOUNTS
        ) {
            persistWorkflowSnapshotToServiceSubdoc(asset);
            const tireAccResult = await advanceTireChangeAfterAccountsApprove(
                asset,
                asset.activeServiceWorkflow,
                actorName,
            );
            const tireAccFresh = await AssetItem.findById(asset._id).populate(
                'assignedTo',
                'firstName lastName employeeId',
            );
            const zohoBillSync = tireAccResult?.zohoBillSync || null;
            return res.json({
                message: `Accounts approved — service scheduled. ${zohoBillSync?.message || 'Zoho bill created.'}`,
                zohoBillMessage: zohoBillSync?.message || '',
                zohoBillId: zohoBillSync?.billId || '',
                zohoBillOk: true,
                asset: tireAccFresh,
            });
        }

        if (
            action === 'approve' &&
            isMechWf &&
            stage === STAGE.HR
        ) {
            persistWorkflowSnapshotToServiceSubdoc(asset);
            await advanceMechanicalWorkAfterHrApprove(asset, asset.activeServiceWorkflow, actorName);
            const mechHrFresh = await AssetItem.findById(asset._id).populate(
                'assignedTo',
                'firstName lastName employeeId',
            );
            return res.json({ message: 'HR approved — sent to Admin Officer for garage details', asset: mechHrFresh });
        }

        if (
            action === 'approve' &&
            isMechWf &&
            stage === STAGE.ACCOUNTS
        ) {
            persistWorkflowSnapshotToServiceSubdoc(asset);
            const mechAccResult = await advanceMechanicalWorkAfterAccountsApprove(
                asset,
                asset.activeServiceWorkflow,
                actorName,
            );
            const mechAccFresh = await AssetItem.findById(asset._id).populate(
                'assignedTo',
                'firstName lastName employeeId',
            );
            const zohoBillSync = mechAccResult?.zohoBillSync || null;
            return res.json({
                message: `Accounts approved — service scheduled. ${zohoBillSync?.message || 'Zoho bill created.'}`,
                zohoBillMessage: zohoBillSync?.message || '',
                zohoBillId: zohoBillSync?.billId || '',
                zohoBillOk: true,
                asset: mechAccFresh,
            });
        }

        if (
            action === 'approve' &&
            isBodyWf &&
            stage === STAGE.HR
        ) {
            persistWorkflowSnapshotToServiceSubdoc(asset);
            await advanceBodyWorkAfterHrApprove(asset, asset.activeServiceWorkflow, actorName);
            const bodyHrFresh = await AssetItem.findById(asset._id).populate(
                'assignedTo',
                'firstName lastName employeeId',
            );
            return res.json({ message: 'HR approved — sent to Admin Officer for garage details', asset: bodyHrFresh });
        }

        if (
            action === 'approve' &&
            isBodyWf &&
            stage === STAGE.ACCOUNTS
        ) {
            persistWorkflowSnapshotToServiceSubdoc(asset);
            const bodyAccResult = await advanceBodyWorkAfterAccountsApprove(
                asset,
                asset.activeServiceWorkflow,
                actorName,
            );
            const bodyAccFresh = await AssetItem.findById(asset._id).populate(
                'assignedTo',
                'firstName lastName employeeId',
            );
            const zohoBillSync = bodyAccResult?.zohoBillSync || null;
            return res.json({
                message: `Accounts approved — service scheduled. ${zohoBillSync?.message || 'Zoho bill created.'}`,
                zohoBillMessage: zohoBillSync?.message || '',
                zohoBillId: zohoBillSync?.billId || '',
                zohoBillOk: true,
                asset: bodyAccFresh,
            });
        }

        if (
            action === 'approve' &&
            isAccWf &&
            stage === STAGE.HR
        ) {
            persistWorkflowSnapshotToServiceSubdoc(asset);
            await advanceAccidentRepairAfterHrApprove(asset, asset.activeServiceWorkflow, actorName);
            const accHrFresh = await AssetItem.findById(asset._id).populate(
                'assignedTo',
                'firstName lastName employeeId',
            );
            return res.json({ message: 'HR approved — sent to Admin Officer for garage details', asset: accHrFresh });
        }

        if (
            action === 'approve' &&
            isAccWf &&
            stage === STAGE.ACCOUNTS
        ) {
            persistWorkflowSnapshotToServiceSubdoc(asset);
            const accAccResult = await advanceAccidentRepairAfterAccountsApprove(
                asset,
                asset.activeServiceWorkflow,
                actorName,
            );
            const accAccFresh = await AssetItem.findById(asset._id).populate(
                'assignedTo',
                'firstName lastName employeeId',
            );
            const zohoBillSync = accAccResult?.zohoBillSync || null;
            return res.json({
                message: `Accounts approved — service scheduled. ${zohoBillSync?.message || 'Zoho bill created.'}`,
                zohoBillMessage: zohoBillSync?.message || '',
                zohoBillId: zohoBillSync?.billId || '',
                zohoBillOk: true,
                asset: accAccFresh,
            });
        }

        let nextStage = null;
        if (isTireWf || isMechWf || isBodyWf || isAccWf) {
            return res.status(400).json({ message: 'Invalid service workflow step for this action.' });
        }
        if (stage === STAGE.HR) nextStage = STAGE.ACCOUNTS;
        else if (stage === STAGE.ACCOUNTS) nextStage = STAGE.ADMIN;
        else if (stage === STAGE.MANAGEMENT) nextStage = STAGE.COMPLETE;
        else if (stage === STAGE.ADMIN) nextStage = STAGE.SCHEDULED;

        if (nextStage === STAGE.SCHEDULED) {
            const su = serviceUpdates || {};
            const startRaw = su.scheduledServiceDate || su.date;
            const n = Math.floor(Number(su.serviceDurationDays));
            const startD = new Date(startRaw);
            if (Number.isNaN(startD.getTime())) {
                return res.status(400).json({ message: 'Invalid service date.' });
            }
            if (!asset.activeServiceWorkflow) asset.activeServiceWorkflow = {};
            asset.activeServiceWorkflow.scheduledServiceDate = startD;
            asset.activeServiceWorkflow.serviceDurationDays = n;
            asset.activeServiceWorkflow.serviceWindowEndDate = computeInclusiveWindowEnd(startD, n);
            asset.activeServiceWorkflow.serviceDurationEmailSentAt = null;
            asset.activeServiceWorkflow.stage = STAGE.SCHEDULED;
            // Flip immediately when today is already inside the scheduled window
            // so UI does not depend on the periodic background job timing.
            const startUtc = Date.UTC(startD.getUTCFullYear(), startD.getUTCMonth(), startD.getUTCDate());
            const endD = asset.activeServiceWorkflow.serviceWindowEndDate;
            const endUtc = endD
                ? Date.UTC(endD.getUTCFullYear(), endD.getUTCMonth(), endD.getUTCDate())
                : startUtc;
            const now = new Date();
            const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
            asset.onServiceActive = true;
            asset.status = asset.assignedTo ? 'Assigned' : 'Unassigned';
            wf.stage = STAGE.SCHEDULED;
            persistWorkflowSnapshotToServiceSubdoc(asset);
            await asset.save();

            const nextAssignee = await resolveAssigneeForStage(STAGE.SCHEDULED);
            if (nextAssignee?._id) {
                const requesterName = actorName;
                await syncDashboardAction({
                    requestId: asset._id,
                    requestType: 'Vehicle Service Request',
                    status: 'Pending',
                    assignedTo: nextAssignee._id,
                    subjectEmployee: asset.assignedTo,
                    requestedByName: requesterName,
                    extra1: `${asset.assetId} — ${wf.serviceTypeLabel || 'Service'}`,
                    extra2: 'Service scheduled — use Extend or Mark live during the service window',
                    extra3: vehicleServiceDashboardMetaForWorkflow(asset, wf),
                });
                await sendWorkflowEmailWithConsole({
                    recipient: nextAssignee,
                    asset,
                    stageLabel: 'Service scheduled (asset controller)',
                    actionLabel: 'Vehicle service window is scheduled',
                    detailLine: `A service date and duration are set. The vehicle is waiting for service until the first service day, then you can use Extend or Mark live during the window.`,
                    linkPath: vehicleServiceDetailsPathForWorkflow(asset, wf),
                });
            }

            try {
                const stakeholders = await resolveWorkflowStakeholders(asset, wf.serviceRecordId);
                const hr = await resolveAssigneeForStage(STAGE.HR);
                const accounts = await resolveAssigneeForStage(STAGE.ACCOUNTS);
                for (const recipient of uniqRecipients([
                    stakeholders.requester,
                    stakeholders.assignedEmployee,
                    stakeholders.primaryReportee,
                    hr,
                    accounts,
                ])) {
                    await sendWorkflowEmailWithConsole({
                        recipient,
                        asset,
                        stageLabel: 'Admin approved; service scheduled',
                        actionLabel: 'Vehicle service moved to scheduled window',
                        detailLine: `Admin approved and scheduled this service window. Current vehicle status: ${asset.status}.`,
                        linkPath: vehicleServiceDetailsPathForWorkflow(asset, wf),
                    });
                }
            } catch (notifyErr) {
                console.error('[VehicleServiceWorkflow] admin scheduled notify failed:', notifyErr);
            }

            const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
            return res.json({
                message:
                    asset.status === 'On Service'
                        ? 'Service date and duration saved. Vehicle is now On Service (inside the scheduled window).'
                        : 'Service date and duration saved. The vehicle is waiting for service until the scheduled day.',
                asset: fresh,
            });
        }

        if (nextStage === STAGE.COMPLETE) {
            asset.activeServiceWorkflow.stage = STAGE.COMPLETE;
            asset.status = resolveStatusAfterService(asset, wf);
            persistWorkflowSnapshotToServiceSubdoc(asset);
            await asset.save();
            await closeAdminOfficerServiceTrackNotification({
                assetId: asset._id,
                serviceRecordId: wf.serviceRecordId,
                actionedBy: performedById,
                comment: comment || 'Service workflow completed',
                requestedByName: actorName,
            });
            const doneFresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
            return res.json({ message: 'Service workflow completed', asset: doneFresh });
        }

        // Keep current status unchanged at Accounts approval.
        // Admin approval moves the vehicle into a scheduled service window (not "On Service" until the service day).

        asset.activeServiceWorkflow.stage = nextStage;
        persistWorkflowSnapshotToServiceSubdoc(asset);
        await asset.save();

        const nextAssignee = await resolveAssigneeForStage(nextStage);
        if (nextAssignee?._id) {
            const requesterName = actorName;
            let extra2 = 'Action required';
            if (nextStage === STAGE.ACCOUNTS) extra2 = 'Awaiting Accounts approval';
            if (nextStage === STAGE.ADMIN) {
                extra2 = 'Admin must set the service date and duration to schedule the in-shop window';
            }

            await syncDashboardAction({
                requestId: asset._id,
                requestType: 'Vehicle Service Request',
                status: 'Pending',
                assignedTo: nextAssignee._id,
                subjectEmployee: asset.assignedTo,
                requestedByName: requesterName,
                extra1: `${asset.assetId} — ${wf.serviceTypeLabel || 'Service'}`,
                extra2,
                extra3: vehicleServiceDashboardMetaForWorkflow(asset, wf),
            });

            await sendWorkflowEmailWithConsole({
                recipient: nextAssignee,
                asset,
                stageLabel: extra2,
                actionLabel: 'Vehicle service workflow',
                detailLine: `The request moved to the next step. Please review in VeRP.`,
                linkPath: vehicleServiceDetailsPathForWorkflow(asset, wf),
            });
        }

        if (stage === STAGE.HR && nextStage === STAGE.ACCOUNTS) {
            try {
                const stakeholders = await resolveWorkflowStakeholders(asset, wf.serviceRecordId);
                for (const recipient of uniqRecipients([stakeholders.assignedEmployee, stakeholders.primaryReportee])) {
                    await sendWorkflowEmailWithConsole({
                        recipient,
                        asset,
                        stageLabel: 'HR approved; sent to Accounts',
                        actionLabel: 'Vehicle service request update',
                        detailLine: `Your vehicle service request was approved by HR and moved to Accounts review.`,
                        linkPath: vehicleServiceDetailsPathForWorkflow(asset, wf),
                    });
                }
            } catch (notifyErr) {
                console.error('[VehicleServiceWorkflow] HR->Accounts notify stakeholders failed:', notifyErr);
            }
        }

        const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
        return res.json({ message: 'Step recorded', asset: fresh });
    } catch (error) {
        console.error('[respondVehicleServiceWorkflow]', error);
        const msg = String(error?.message || 'Server error');
        const isZohoGate =
            /zoho bill/i.test(msg) ||
            /account types are not applicable/i.test(msg) ||
            /pay account is required/i.test(msg) ||
            /vendor not found/i.test(msg);
        res.status(isZohoGate ? 400 : 500).json({ message: msg });
    }
};

function utcDayStart(d) {
    if (!d) return NaN;
    const x = new Date(d);
    return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
}

/** Workshop completion report present (multipart body or previously saved on the service row / remark). */
function workflowReturnCompletionSatisfied(subDoc, remarkMeta, body) {
    const { completionReport, shopInvoice, invoice, serviceReport } = body || {};
    if (completionReport?.data) return true;
    if (serviceReport?.data) return true;
    if (invoice?.data && !shopInvoice?.data) return true;
    if (subDoc && String(subDoc.serviceCompletionReport || '').trim()) return true;
    if (
        subDoc &&
        String(subDoc.invoice || '').trim() &&
        (remarkMeta?.serviceReportName || remarkMeta?.serviceReportMime || remarkMeta?.serviceReportUpdatedAt)
    ) {
        return true;
    }
    return false;
}

/** Shop / VAT invoice present for workflow return-to-live. */
function workflowReturnShopInvoiceSatisfied(subDoc, remarkMeta, body) {
    const { shopInvoice } = body || {};
    if (shopInvoice?.data) return true;
    if (subDoc && String(subDoc.shopInvoice || '').trim()) return true;
    if (remarkMeta?.shopInvoiceName || remarkMeta?.shopInvoiceUpdatedAt) return true;
    return false;
}

/**
 * POST /api/AssetItem/:id/service-workflow/period
 * { action: 'extend' | 'go_live' | 'update_status' | 'change_service_start', extendDays?, scheduledServiceDate?, invoice?, comment?, ... }
 * — Asset Controller: extend window, change first service day (after Admin schedule), mark live, etc.
 */
export const respondVehicleServiceScheduledPeriod = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            action,
            extendDays,
            scheduledServiceDate: scheduledServiceDateBody,
            invoice,
            completionReport,
            shopInvoice,
            comment,
            serviceStatus,
            serviceReport,
            description,
            returnMode,
            returnDate,
            returnStatus,
            handOverDate,
        } = req.body || {};
        if (!['extend', 'go_live', 'cancel', 'reject', 'update_status', 'change_service_start'].includes(String(action || ''))) {
            return res
                .status(400)
                .json({
                    message: 'action must be extend, go_live, cancel, reject, update_status, or change_service_start',
                });
        }

        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const wf = asset.activeServiceWorkflow;
        if (wf?.stage !== STAGE.SCHEDULED) {
            return res
                .status(400)
                .json({ message: 'This action is only available during the scheduled service window (after Admin approval).' });
        }

        const assignee = await resolveAssigneeForStage(STAGE.SCHEDULED);
        const allowed = await actorMayAct(req.user, assignee);
        if (!allowed) {
            return res.status(403).json({ message: 'You are not authorized for this action' });
        }

        const actorName = (await getRequesterName(req.user)) || 'User';
        const actorEmp = await resolveActorEmployee(req.user);
        const performedById = actorEmp?._id;
        const today = utcDayStart(new Date());
        const start = wf.scheduledServiceDate ? utcDayStart(wf.scheduledServiceDate) : NaN;
        const end = wf.serviceWindowEndDate ? utcDayStart(wf.serviceWindowEndDate) : NaN;
        const serviceRecordId = wf.serviceRecordId;

        if (action === 'change_service_start') {
            const hasAdminScheduled =
                Array.isArray(wf.history) &&
                wf.history.some((h) => h.stage === STAGE.ADMIN && h.action === 'approve');
            if (!hasAdminScheduled) {
                return res.status(400).json({
                    message: 'The first service day can only be changed after Asset Controller approves the schedule.',
                });
            }
            const newStartRaw = scheduledServiceDateBody;
            if (!newStartRaw) {
                return res.status(400).json({ message: 'scheduledServiceDate is required' });
            }
            const newStart = new Date(newStartRaw);
            if (Number.isNaN(newStart.getTime())) {
                return res.status(400).json({ message: 'Invalid scheduledServiceDate' });
            }
            const dur = Math.max(1, Math.floor(Number(wf.serviceDurationDays) || 1));
            wf.scheduledServiceDate = newStart;
            wf.serviceWindowEndDate = computeInclusiveWindowEnd(newStart, dur);
            wf.serviceDurationEmailSentAt = null;

            const startUtc = Date.UTC(newStart.getUTCFullYear(), newStart.getUTCMonth(), newStart.getUTCDate());
            const endD = wf.serviceWindowEndDate;
            const endUtc = endD
                ? Date.UTC(endD.getUTCFullYear(), endD.getUTCMonth(), endD.getUTCDate())
                : startUtc;
            const now = new Date();
            const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
            asset.onServiceActive = true;
            asset.status = asset.assignedTo ? 'Assigned' : 'Unassigned';
            wf.stage = STAGE.SCHEDULED;

            if (serviceRecordId) {
                const isoDay = newStart.toISOString().slice(0, 10);
                await mergeWorkflowServiceRecord(asset, serviceRecordId, {
                    scheduledServiceDate: isoDay,
                    serviceDurationDays: dur,
                });
            }

            const noteExtra = String(comment || '').trim();
            await pushWorkflowHistory(asset, {
                stage: STAGE.SCHEDULED,
                action: 'change_service_start',
                note: noteExtra
                    ? `First service day set to ${newStart.toISOString().slice(0, 10)}. ${noteExtra}`
                    : `First service day set to ${newStart.toISOString().slice(0, 10)}`,
                byName: actorName,
            });
            await logVehicleServiceWorkflowToAssetHistory(asset, {
                stage: STAGE.SCHEDULED,
                workflowAction: 'approve',
                note: `Rescheduled service start to ${newStart.toISOString().slice(0, 10)}`,
                byName: actorName,
                performedById,
                serviceTypeLabel: wf.serviceTypeLabel,
                hasServiceUpdates: true,
                serviceRecordId,
            });
            persistWorkflowSnapshotToServiceSubdoc(asset);
            await asset.save();
            const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
            return res.json({ message: 'Scheduled first service date updated.', asset: fresh });
        }

        if (action === 'extend') {
            const ext = Math.floor(Number(extendDays));
            if (!Number.isFinite(ext) || ext < 1) {
                return res.status(400).json({ message: 'extendDays must be a whole number of at least 1' });
            }
            if (Number.isFinite(start) && today < start) {
                return res.status(400).json({ message: 'Extend is not available before the scheduled first service day.' });
            }
            if (Number.isFinite(end) && today > end) {
                return res.status(400).json({ message: 'The service window has ended. Use Mark live to close the workflow, or contact an administrator.' });
            }
            if (!wf.serviceWindowEndDate) {
                return res.status(400).json({ message: 'Missing service window data on this request.' });
            }
            const newEnd = new Date(wf.serviceWindowEndDate);
            newEnd.setDate(newEnd.getDate() + ext);
            wf.serviceWindowEndDate = newEnd;
            const prevDur = Math.max(1, Math.floor(Number(wf.serviceDurationDays) || 1));
            wf.serviceDurationDays = prevDur + ext;
            if (serviceRecordId) {
                const sub = asset.services?.id?.(serviceRecordId);
                if (sub) {
                    const n = wf.serviceDurationDays;
                    sub.serviceDuration = `${n} day${n === 1 ? '' : 's'}`;
                    const r = parseRemarkMeta(sub.remark);
                    const returnDateStr = newEnd.toISOString().slice(0, 10);
                    r.extendedByDays = (r.extendedByDays || 0) + ext;
                    r.returnMode = 'extend';
                    r.accidentExtendDays = ext;
                    r.accidentServiceStatus = 'on_service';
                    r.accidentReturnDate = returnDateStr;
                    r.serviceReturnDate = returnDateStr;
                    if (String(comment || '').trim()) {
                        r.lastExtendNote = String(comment).trim();
                    }
                    sub.remark = JSON.stringify(r);
                    asset.markModified('services');
                }
            }
            await pushWorkflowHistory(asset, {
                stage: STAGE.SCHEDULED,
                action: 'extend',
                note: `+${ext} day(s). ${String(comment || '').trim()}`,
                byName: actorName,
            });
            await logVehicleServiceWorkflowToAssetHistory(asset, {
                stage: STAGE.SCHEDULED,
                workflowAction: 'approve',
                note: `Extended service window by ${ext} day(s)${comment ? `. ${comment}` : ''}`,
                byName: actorName,
                performedById,
                serviceTypeLabel: wf.serviceTypeLabel,
                hasServiceUpdates: true,
                serviceRecordId,
            });
            persistWorkflowSnapshotToServiceSubdoc(asset);
            await asset.save();
            try {
                const stakeholders = await resolveWorkflowStakeholders(asset, serviceRecordId);
                const hr = await resolveAssigneeForStage(STAGE.HR);
                const accounts = await resolveAssigneeForStage(STAGE.ACCOUNTS);
                const admin = await resolveAssigneeForStage(STAGE.SCHEDULED);
                for (const recipient of uniqRecipients([
                    stakeholders.requester,
                    stakeholders.assignedEmployee,
                    stakeholders.primaryReportee,
                    hr,
                    accounts,
                    admin,
                ])) {
                    await sendWorkflowEmailWithConsole({
                        recipient,
                        asset,
                        stageLabel: 'Service extended',
                        actionLabel: 'Vehicle service return date updated',
                        detailLine: `Service window extended by ${ext} day(s). New expected return date: ${newEnd.toISOString().slice(0, 10)}.`,
                        linkPath: vehicleServiceDetailsPathForWorkflow(asset, wf),
                    });
                }
            } catch (notifyErr) {
                console.error('[VehicleServiceWorkflow] extend notify stakeholders failed:', notifyErr);
            }
            const out = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
            return res.json({ message: 'Service window extended', asset: out });
        }

        if (action === 'go_live') {
            if (Number.isFinite(start) && today < start) {
                return res.status(400).json({ message: 'Mark live is not available before the scheduled first service day.' });
            }
            const goLiveNote = String(comment || '').trim();
            if (!goLiveNote) {
                return res.status(400).json({ message: 'Description is required to mark live.' });
            }
            if (!serviceRecordId) {
                return res.status(400).json({ message: 'Missing service record for this workflow.' });
            }
            const subGo = asset.services?.id?.(serviceRecordId);
            if (!subGo) {
                return res.status(404).json({ message: 'Service record not found.' });
            }
            const rmGo = parseRemarkMeta(subGo.remark);
            const goCompletionBody = { completionReport, shopInvoice, invoice };
            if (!workflowReturnCompletionSatisfied(subGo, rmGo, goCompletionBody)) {
                return res
                    .status(400)
                    .json({ message: 'Service completion report is required — upload under Return from service to live.' });
            }
            if (!workflowReturnShopInvoiceSatisfied(subGo, rmGo, goCompletionBody)) {
                return res.status(400).json({ message: 'Shop invoice upload is required before marking live.' });
            }
            const completionBlob =
                completionReport?.data ? completionReport : !shopInvoice?.data && invoice?.data ? invoice : null;
            const mergeGo = {
                ...(completionBlob?.data ? { completionReport: completionBlob } : {}),
                ...(shopInvoice?.data ? { shopInvoice } : {}),
            };
            if (Object.keys(mergeGo).length) {
                await mergeWorkflowServiceRecord(asset, serviceRecordId, mergeGo);
            }
            const subAfterMerge = asset.services?.id?.(serviceRecordId);
            if (subAfterMerge) {
                const r = parseRemarkMeta(subAfterMerge.remark);
                r.vehicleServiceCompleted = 'live';
                r.vehicleServiceCompletedAt = new Date().toISOString();
                if (handOverDate !== undefined) {
                    r.handOverDate = handOverDate ? String(handOverDate).slice(0, 10) : null;
                }
                if (completionBlob?.name) {
                    r.serviceReportName = String(completionBlob.name);
                    if (completionBlob.mime != null && String(completionBlob.mime).trim() !== '') {
                        r.serviceReportMime = String(completionBlob.mime);
                    }
                    r.serviceReportUpdatedAt = new Date().toISOString();
                }
                if (shopInvoice?.name) {
                    r.shopInvoiceName = String(shopInvoice.name);
                    if (shopInvoice.mime != null && String(shopInvoice.mime).trim() !== '') {
                        r.shopInvoiceMime = String(shopInvoice.mime);
                    }
                    r.shopInvoiceUpdatedAt = new Date().toISOString();
                }
                subAfterMerge.remark = JSON.stringify(r);
                asset.markModified('services');
            }
            asset.status = resolveStatusAfterService(asset, wf);
            wf.stage = STAGE.COMPLETE;
            if (assignee?._id) {
                await syncDashboardAction({
                    requestId: asset._id,
                    requestType: 'Vehicle Service Request',
                    status: 'Approved',
                    assignedTo: assignee._id,
                    actionedBy: (await resolveActorEmployee(req.user))?._id,
                    comment: comment || 'Marked live',
                    subjectEmployee: asset.assignedTo,
                    requestedByName: actorName,
                });
            }
            await pushWorkflowHistory(asset, {
                stage: STAGE.SCHEDULED,
                action: 'go_live',
                note: goLiveNote,
                byName: actorName,
            });
            await logVehicleServiceWorkflowToAssetHistory(asset, {
                stage: STAGE.SCHEDULED,
                workflowAction: 'approve',
                note: 'Workflow completed — vehicle marked live (completion report & shop invoice saved)',
                byName: actorName,
                performedById,
                serviceTypeLabel: wf.serviceTypeLabel,
                hasServiceUpdates: true,
                serviceRecordId,
            });
            try {
                const stakeholders = await resolveWorkflowStakeholders(asset, serviceRecordId);
                const hr = await resolveAssigneeForStage(STAGE.HR);
                const accounts = await resolveAssigneeForStage(STAGE.ACCOUNTS);
                const admin = await resolveAssigneeForStage(STAGE.SCHEDULED);
                for (const recipient of uniqRecipients([
                    stakeholders.requester,
                    stakeholders.assignedEmployee,
                    stakeholders.primaryReportee,
                    hr,
                    accounts,
                    admin,
                ])) {
                    await sendWorkflowEmailWithConsole({
                        recipient,
                        asset,
                        stageLabel: 'Vehicle marked live',
                        actionLabel: 'Service workflow completed',
                        detailLine: `Service is marked live and completed. Vehicle status is restored to ${asset.status}.`,
                        linkPath: vehicleServiceDetailsPathForWorkflow(asset, wf),
                    });
                }
            } catch (notifyErr) {
                console.error('[VehicleServiceWorkflow] go_live notify stakeholders failed:', notifyErr);
            }
            persistWorkflowSnapshotToServiceSubdoc(asset);
            await asset.save();
            await closeAdminOfficerServiceTrackNotification({
                assetId: asset._id,
                serviceRecordId: wf.serviceRecordId,
                actionedBy: performedById,
                comment: goLiveNote || 'Service workflow completed',
                requestedByName: actorName,
            });
            const doneFresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
            return res.json({ message: 'Vehicle is back in normal use — service workflow completed.', asset: doneFresh });
        }
        if (action === 'update_status') {
            if (!serviceRecordId) {
                return res.status(400).json({ message: 'Missing service record for this workflow.' });
            }
            const requestedStatus = String(serviceStatus || '').trim();
            const normalizedRequestedStatus = requestedStatus.toLowerCase().replace(/\s+/g, '_');
            const isExtendMode = String(returnMode || 'date').trim().toLowerCase() === 'extend';
            const statusText = isExtendMode
                ? 'on_service'
                : (normalizedRequestedStatus || '');
            if (!statusText) {
                return res.status(400).json({ message: 'Service status is required.' });
            }
            const sub = asset.services?.id?.(serviceRecordId);
            if (!sub) {
                return res.status(404).json({ message: 'Service record not found.' });
            }
            const r0 = parseRemarkMeta(sub.remark);
            const updateBodyDocs = { serviceReport, shopInvoice };
            if (!workflowReturnCompletionSatisfied(sub, r0, updateBodyDocs)) {
                return res
                    .status(400)
                    .json({ message: 'Service completion report upload is required for this submit.' });
            }
            if (!workflowReturnShopInvoiceSatisfied(sub, r0, updateBodyDocs)) {
                return res.status(400).json({ message: 'Shop invoice upload is required for this submit.' });
            }
            const mergeStatus = {};
            if (serviceReport?.data) mergeStatus.completionReport = serviceReport;
            if (shopInvoice?.data) mergeStatus.shopInvoice = shopInvoice;
            if (Object.keys(mergeStatus).length) {
                await mergeWorkflowServiceRecord(asset, serviceRecordId, mergeStatus);
            }
            if (description != null) {
                sub.description = String(description || '').trim();
            }
            const r = parseRemarkMeta(sub.remark);
            r.accidentServiceStatus = statusText;
            r.returnMode = isExtendMode ? 'extend' : 'date';
            if (r.returnMode === 'extend') {
                const ext = Math.max(1, Math.floor(Number(extendDays) || 1));
                r.accidentExtendDays = ext;
                const currentBase = wf.serviceWindowEndDate ? new Date(wf.serviceWindowEndDate) : new Date();
                currentBase.setDate(currentBase.getDate() + ext);
                const updatedReturn = currentBase.toISOString().slice(0, 10);
                wf.serviceWindowEndDate = currentBase;
                wf.serviceDurationDays = Math.max(1, Math.floor(Number(wf.serviceDurationDays) || 1)) + ext;
                r.accidentReturnDate = updatedReturn;
                r.serviceReturnDate = updatedReturn;
            } else {
                r.accidentReturnDate = returnDate ? String(returnDate).slice(0, 10) : null;
                r.accidentExtendDays = null;
                r.serviceReturnDate = returnDate ? String(returnDate).slice(0, 10) : null;
            }
            r.accidentReturnStatus = String(returnStatus || '').trim();
            if (handOverDate !== undefined) {
                r.handOverDate = handOverDate ? String(handOverDate).slice(0, 10) : null;
            }
            if (serviceReport?.name) r.serviceReportName = String(serviceReport.name);
            if (serviceReport?.mime) r.serviceReportMime = String(serviceReport.mime);
            if (serviceReport?.data) r.serviceReportUpdatedAt = new Date().toISOString();
            if (shopInvoice?.name) r.shopInvoiceName = String(shopInvoice.name);
            if (shopInvoice?.mime) r.shopInvoiceMime = String(shopInvoice.mime);
            if (shopInvoice?.data) r.shopInvoiceUpdatedAt = new Date().toISOString();
            sub.remark = JSON.stringify(r);
            asset.markModified('services');

            const normalized = statusText.toLowerCase().replace(/\s+/g, '_');
            if (normalized === 'complete' || normalized === 'completed') {
                asset.status = resolveStatusAfterService(asset, wf);
                wf.stage = STAGE.COMPLETE;
                r.vehicleServiceCompleted = 'complete';
                r.vehicleServiceCompletedAt = new Date().toISOString();
                sub.remark = JSON.stringify(r);
                asset.markModified('services');
                if (assignee?._id) {
                    await syncDashboardAction({
                        requestId: asset._id,
                        requestType: 'Vehicle Service Request',
                        status: 'Approved',
                        assignedTo: assignee._id,
                        actionedBy: (await resolveActorEmployee(req.user))?._id,
                        comment: 'Completed from status update',
                        subjectEmployee: asset.assignedTo,
                        requestedByName: actorName,
                    });
                }
                await closeAdminOfficerServiceTrackNotification({
                    assetId: asset._id,
                    serviceRecordId,
                    actionedBy: performedById,
                    comment: 'Completed from status update',
                    requestedByName: actorName,
                });
            } else if (normalized === 'on_service') {
                applyServiceActiveState(asset);
                wf.stage = STAGE.SCHEDULED;
            }

            await pushWorkflowHistory(asset, {
                stage: STAGE.SCHEDULED,
                action: 'status_update',
                note: `Status updated: ${statusText}`,
                byName: actorName,
                bySignatureUrl: String(actorEmp?.signature?.url || '').trim(),
            });
            await logVehicleServiceWorkflowToAssetHistory(asset, {
                stage: STAGE.SCHEDULED,
                workflowAction: 'approve',
                note: `Service status updated to ${statusText}`,
                byName: actorName,
                performedById,
                serviceTypeLabel: wf.serviceTypeLabel,
                hasServiceUpdates: true,
                serviceRecordId,
            });
            persistWorkflowSnapshotToServiceSubdoc(asset);
            await asset.save();
            if (r.returnMode === 'extend') {
                try {
                    const stakeholders = await resolveWorkflowStakeholders(asset, serviceRecordId);
                    const hr = await resolveAssigneeForStage(STAGE.HR);
                    const accounts = await resolveAssigneeForStage(STAGE.ACCOUNTS);
                    const admin = await resolveAssigneeForStage(STAGE.SCHEDULED);
                    for (const recipient of uniqRecipients([
                        stakeholders.requester,
                        stakeholders.assignedEmployee,
                        stakeholders.primaryReportee,
                        hr,
                        accounts,
                        admin,
                    ])) {
                        await sendWorkflowEmailWithConsole({
                            recipient,
                            asset,
                            stageLabel: 'Service extended',
                            actionLabel: 'Vehicle service return date updated',
                            detailLine: `Service remains On Service and return date is extended to ${r.accidentReturnDate || '—'}.`,
                            linkPath: vehicleServiceDetailsPathForWorkflow(asset, wf),
                        });
                    }
                } catch (notifyErr) {
                    console.error('[VehicleServiceWorkflow] update_status extend notify failed:', notifyErr);
                }
            }
            const out = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
            return res.json({ message: 'Service status saved successfully.', asset: out });
        }
        if (action === 'cancel') {
            asset.status = resolveStatusAfterService(asset, wf);
            wf.stage = STAGE.COMPLETE;
            await pushWorkflowHistory(asset, {
                stage: STAGE.SCHEDULED,
                action: 'cancel',
                note: String(comment || 'Cancelled in scheduled period').trim(),
                byName: actorName,
            });
            await logVehicleServiceWorkflowToAssetHistory(asset, {
                stage: STAGE.SCHEDULED,
                workflowAction: 'approve',
                note: `Scheduled service cancelled${comment ? `. ${comment}` : ''}`,
                byName: actorName,
                performedById,
                serviceTypeLabel: wf.serviceTypeLabel,
                hasServiceUpdates: false,
                serviceRecordId,
            });
            persistWorkflowSnapshotToServiceSubdoc(asset);
            await asset.save();
            const doneFresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
            return res.json({ message: 'Scheduled service cancelled and vehicle status restored.', asset: doneFresh });
        }
        if (action === 'reject') {
            asset.status = resolveStatusAfterService(asset, wf);
            wf.stage = STAGE.REJECTED;
            await pushWorkflowHistory(asset, {
                stage: STAGE.SCHEDULED,
                action: 'reject',
                note: String(comment || 'Rejected in scheduled period').trim(),
                byName: actorName,
            });
            await logVehicleServiceWorkflowToAssetHistory(asset, {
                stage: STAGE.SCHEDULED,
                workflowAction: 'reject',
                note: `Scheduled service rejected${comment ? `. ${comment}` : ''}`,
                byName: actorName,
                performedById,
                serviceTypeLabel: wf.serviceTypeLabel,
                hasServiceUpdates: false,
                serviceRecordId,
            });
            persistWorkflowSnapshotToServiceSubdoc(asset);
            await asset.save();
            const doneFresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
            return res.json({ message: 'Scheduled service rejected and vehicle status restored.', asset: doneFresh });
        }
        return res.status(400).json({ message: 'Invalid action' });
    } catch (error) {
        if (error?.name === 'VersionError') {
            return res.status(409).json({
                message:
                    'This request was updated by another process at the same time. Please refresh and submit again.',
            });
        }
        console.error('[respondVehicleServiceScheduledPeriod]', error);
        res.status(500).json({ message: error.message || 'Server error' });
    }
};
