import AssetItem from '../models/AssetItem.js';
import AssetType from '../models/AssetType.js';
import AssetHistory from '../models/AssetHistory.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { uploadDocumentToS3 } from '../utils/s3Upload.js';
import { syncDashboardAction } from '../utils/syncDashboard.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';
import { getManagementHOD } from '../utils/getManagementHOD.js';
import { sendVehicleServiceWorkflowEmail } from '../utils/sendVehicleServiceWorkflowEmail.js';
import { isUserAdministrator } from '../services/permissionService.js';

const STAGE = {
    HR: 'pending_hr',
    ACCOUNTS: 'pending_accounts',
    ADMIN: 'pending_admin',
    MANAGEMENT: 'pending_management',
    COMPLETE: 'complete',
    REJECTED: 'rejected'
};

async function resolveAssigneeForStage(stage) {
    if (stage === STAGE.HR) return getDepartmentHOD('hr');
    if (stage === STAGE.ACCOUNTS) return getDepartmentHOD('accounts');
    if (stage === STAGE.ADMIN) return getDepartmentHOD('assetcontroller');
    if (stage === STAGE.MANAGEMENT) return getManagementHOD();
    return null;
}

async function getRequesterName(reqUser) {
    if (!reqUser) return 'System';
    if (reqUser.name) return reqUser.name;
    const u = await EmployeeBasic.findById(reqUser.employeeObjectId).select('firstName lastName').lean();
    if (u) return `${u.firstName || ''} ${u.lastName || ''}`.trim();
    return reqUser.email || 'User';
}

function isPortalAdmin(reqUser) {
    return reqUser?.isAdmin === true || reqUser?.role === 'Admin' || reqUser?.role === 'ROOT';
}

async function resolveActorEmployee(reqUser) {
    if (!reqUser?.employeeObjectId && !reqUser?.employeeId) return null;
    if (reqUser.employeeObjectId) {
        const e = await EmployeeBasic.findById(reqUser.employeeObjectId).select('_id employeeId firstName lastName').lean();
        if (e) return e;
    }
    if (reqUser.employeeId) {
        return EmployeeBasic.findOne({
            employeeId: { $regex: new RegExp(`^${String(reqUser.employeeId).replace(/\s+/g, '\\s*')}$`, 'i') }
        })
            .select('_id employeeId firstName lastName')
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
    if (!assignee?._id && !isPortalAdmin(reqUser)) {
        return !!(await isUserAdministrator(reqUser?.id));
    }
    return actorMayAct(reqUser, assignee);
}

/**
 * Apply the same field set as POST /AssetItem/:id/service to an existing services[] subdoc during workflow approval.
 */
async function mergeWorkflowServiceRecord(asset, serviceRecordId, body) {
    if (!serviceRecordId || !body || typeof body !== 'object') return;
    const sub = asset.services.id(serviceRecordId);
    if (!sub) return;

    const {
        serviceType,
        date,
        expiryDate,
        currentKm,
        description,
        paidBy,
        value,
        remark,
        invoice,
        attachment
    } = body;

    let invoiceUrl = sub.invoice || null;
    if (invoice && invoice.data) {
        try {
            const uploadResult = await uploadDocumentToS3(invoice.data, 'asset-service-invoices', invoice.name);
            invoiceUrl = uploadResult.publicId;
        } catch (error) {
            console.error('[mergeWorkflowServiceRecord] invoice upload:', error);
            throw new Error('Failed to upload invoice');
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

    if (serviceType != null) sub.serviceType = serviceType;
    if (date != null) sub.date = new Date(date);
    if (expiryDate !== undefined) sub.expiryDate = expiryDate ? new Date(expiryDate) : null;
    if (currentKm !== undefined) sub.currentKm = currentKm != null ? Number(currentKm) : null;
    if (description != null) sub.description = description;
    if (paidBy != null) sub.paidBy = paidBy;
    if (value !== undefined) sub.value = Number(value) || 0;
    if (remark !== undefined) sub.remark = remark;
    if (invoiceUrl != null) sub.invoice = invoiceUrl;
    if (attachmentUrl != null) sub.attachment = attachmentUrl;

    const ck = body.currentKm != null ? Number(body.currentKm) : null;
    if (ck && !Number.isNaN(ck) && ck > (asset.currentKilometer || 0)) {
        asset.currentKilometer = ck;
    }

    asset.markModified('services');
}

async function pushWorkflowHistory(asset, { stage, action, note, byName }) {
    if (!asset.activeServiceWorkflow) asset.activeServiceWorkflow = {};
    if (!Array.isArray(asset.activeServiceWorkflow.history)) asset.activeServiceWorkflow.history = [];
    asset.activeServiceWorkflow.history.push({
        stage,
        action,
        note: note || '',
        byName: byName || '',
        at: new Date()
    });
}

const STAGE_LABEL = {
    [STAGE.HR]: 'HR',
    [STAGE.ACCOUNTS]: 'Accounts',
    [STAGE.ADMIN]: 'On service (Asset Controller)',
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
    hasServiceUpdates
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
        }

        await AssetHistory.create({
            assetId: asset._id,
            action: 'Service',
            performedBy: performedById || undefined,
            comments,
            details: {
                type: 'VehicleServiceWorkflow',
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

        const cur = asset.activeServiceWorkflow;
        if (cur?.stage && ![STAGE.COMPLETE, STAGE.REJECTED].includes(cur.stage)) {
            return;
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
            hasServiceUpdates: false
        });

        const requesterName = await getRequesterName(req.user);

        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Service Request',
            status: 'Pending',
            assignedTo: hr._id,
            subjectEmployee: subjectEmp,
            requestedByName: requesterName,
            extra1: `${asset.assetId} — ${serviceType || 'Service'}`,
            extra2: 'Awaiting HR approval'
        });

        await sendVehicleServiceWorkflowEmail({
            recipient: hr,
            asset,
            stageLabel: 'HR approval required',
            actionLabel: 'New vehicle service request',
            detailLine: `${requesterName} logged a service (${serviceType}). Please approve or reject in your dashboard.`
        });

        asset.markModified('activeServiceWorkflow');
        await asset.save();
    } catch (e) {
        console.error('[VehicleServiceWorkflow] start failed:', e);
    }
}

/**
 * POST /api/AssetItem/:id/service-workflow/respond
 * body: { action: 'approve' | 'reject', comment?: string, serviceUpdates?: object }
 * serviceUpdates uses the same shape as POST /AssetItem/:id/service (optional on approve).
 */
export const respondVehicleServiceWorkflow = async (req, res) => {
    try {
        const { id } = req.params;
        const { action, comment, serviceUpdates } = req.body || {};
        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ message: 'action must be approve or reject' });
        }

        const asset = await AssetItem.findById(id).populate('assignedTo', 'firstName lastName employeeId');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const wf = asset.activeServiceWorkflow;
        if (!wf?.stage || [STAGE.COMPLETE, STAGE.REJECTED].includes(wf.stage)) {
            return res.status(400).json({ message: 'No active service workflow for this vehicle' });
        }

        const stage = wf.stage;
        const assignee = await resolveAssigneeForStage(stage);
        if (!assignee?._id && !isPortalAdmin(req.user)) {
            return res.status(503).json({ message: 'Workflow role is not configured in Flowchart (assignee missing).' });
        }

        const allowed = await actorMayAct(req.user, assignee);
        if (!allowed) {
            return res.status(403).json({ message: 'You are not authorized for this workflow step' });
        }

        const actorName =
            (await getRequesterName(req.user)) ||
            `${(await resolveActorEmployee(req.user))?.firstName || ''}`;
        const actorEmp = await resolveActorEmployee(req.user);
        const performedById = actorEmp?._id;

        let hadServiceUpdates = false;
        if (action === 'approve' && serviceUpdates && wf.serviceRecordId) {
            try {
                await mergeWorkflowServiceRecord(asset, wf.serviceRecordId, serviceUpdates);
                hadServiceUpdates = true;
            } catch (mergeErr) {
                return res.status(400).json({ message: mergeErr.message || 'Could not update service record' });
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

            if (wf.previousStatus) asset.status = wf.previousStatus;
            asset.activeServiceWorkflow.stage = STAGE.REJECTED;
            await pushWorkflowHistory(asset, { stage, action: 'reject', note: comment || '', byName: actorName });
            await logVehicleServiceWorkflowToAssetHistory(asset, {
                stage,
                workflowAction: 'reject',
                note: comment || '',
                byName: actorName,
                performedById,
                serviceTypeLabel: wf.serviceTypeLabel,
                hasServiceUpdates: false
            });
            await asset.save();
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

        await pushWorkflowHistory(asset, { stage, action: 'approve', note: comment || '', byName: actorName });
        await logVehicleServiceWorkflowToAssetHistory(asset, {
            stage,
            workflowAction: 'approve',
            note: comment || '',
            byName: actorName,
            performedById,
            serviceTypeLabel: wf.serviceTypeLabel,
            hasServiceUpdates: hadServiceUpdates
        });

        let nextStage = null;
        if (stage === STAGE.HR) nextStage = STAGE.ACCOUNTS;
        else if (stage === STAGE.ACCOUNTS) nextStage = STAGE.ADMIN;
        else if (stage === STAGE.ADMIN) nextStage = STAGE.MANAGEMENT;
        else if (stage === STAGE.MANAGEMENT) nextStage = STAGE.COMPLETE;

        if (nextStage === STAGE.COMPLETE) {
            asset.activeServiceWorkflow.stage = STAGE.COMPLETE;
            if (wf.previousStatus) asset.status = wf.previousStatus;
            await asset.save();
            const doneFresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
            return res.json({ message: 'Service workflow completed', asset: doneFresh });
        }

        if (stage === STAGE.ACCOUNTS && nextStage === STAGE.ADMIN) {
            asset.status = 'On Service';
        }

        asset.activeServiceWorkflow.stage = nextStage;
        await asset.save();

        const nextAssignee = await resolveAssigneeForStage(nextStage);
        if (nextAssignee?._id) {
            const requesterName = actorName;
            let extra2 = 'Action required';
            if (nextStage === STAGE.ACCOUNTS) extra2 = 'Awaiting Accounts approval';
            if (nextStage === STAGE.ADMIN) extra2 = 'Vehicle is On Service — Asset Controller update';
            if (nextStage === STAGE.MANAGEMENT) extra2 = 'Awaiting Management closure';

            await syncDashboardAction({
                requestId: asset._id,
                requestType: 'Vehicle Service Request',
                status: 'Pending',
                assignedTo: nextAssignee._id,
                subjectEmployee: asset.assignedTo,
                requestedByName: requesterName,
                extra1: `${asset.assetId} — ${wf.serviceTypeLabel || 'Service'}`,
                extra2
            });

            await sendVehicleServiceWorkflowEmail({
                recipient: nextAssignee,
                asset,
                stageLabel: extra2,
                actionLabel: 'Vehicle service workflow',
                detailLine: `The request moved to the next step. Please review in VeRP.`
            });
        }

        const fresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
        return res.json({ message: 'Step recorded', asset: fresh });
    } catch (error) {
        console.error('[respondVehicleServiceWorkflow]', error);
        res.status(500).json({ message: error.message || 'Server error' });
    }
};
