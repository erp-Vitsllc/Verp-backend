import AssetItem from '../models/AssetItem.js';
import AssetType from '../models/AssetType.js';
import AssetHistory from '../models/AssetHistory.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { uploadDocumentToS3 } from '../utils/s3Upload.js';
import { syncDashboardAction } from '../utils/syncDashboard.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';
import { getManagementHOD } from '../utils/getManagementHOD.js';
import { sendVehicleServiceWorkflowEmail } from '../utils/sendVehicleServiceWorkflowEmail.js';
import { resolveEmployeeEmail } from '../utils/resolveEmployeeEmail.js';
import { isUserAdministrator } from '../services/permissionService.js';

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

function vehicleServiceDetailsPath(assetId, serviceRecordId) {
    if (!assetId || !serviceRecordId) return null;
    return `/HRM/Asset/Vehicle/service-requests/details/${assetId}/${serviceRecordId}`;
}

function vehicleServiceDashboardMeta(asset, serviceRecordId) {
    const path = vehicleServiceDetailsPath(asset?._id, serviceRecordId);
    return JSON.stringify({
        vehicleId: asset?._id ? String(asset._id) : '',
        serviceRecordId: serviceRecordId ? String(serviceRecordId) : '',
        detailsPath: path || '',
    });
}

function resolveStatusAfterService(asset, wf) {
    const prev = String(wf?.previousStatus || '').trim();
    // We should never remain in service-like statuses after "mark live"/reject/cancel.
    if (prev && !['on service', 'waiting for service'].includes(prev.toLowerCase())) {
        return prev;
    }
    // Fallback for older rows that didn't store previousStatus correctly.
    return asset?.assignedTo ? 'Assigned' : 'Unassigned';
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
    if (stage === STAGE.HR) return getDepartmentHOD('hr');
    if (stage === STAGE.ACCOUNTS) return getDepartmentHOD('accounts');
    if (stage === STAGE.ADMIN || stage === STAGE.SCHEDULED) return getDepartmentHOD('assetcontroller');
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

    const q1 = serviceSub.attachment || null;
    const q2 = serviceSub.quotation2 || null;
    const q3 = serviceSub.quotation3 || null;
    const selected = choice === 'q1' ? q1 : choice === 'q2' ? q2 : q3;
    if (!selected) return;

    serviceSub.attachment = selected;
    serviceSub.quotation2 = null;
    serviceSub.quotation3 = null;

    if (choice === 'q2' && remark.quotation2Name) {
        remark.attachmentName = remark.quotation2Name;
    } else if (choice === 'q3' && remark.quotation3Name) {
        remark.attachmentName = remark.quotation3Name;
    }
    // Normalize storage/view: once non-selected files are removed, keep approved key as q1
    // because the selected file now lives in `attachment`.
    remark.approvedQuotationChoice = 'q1';
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
        scheduledServiceDate,
        serviceDurationDays,
        expiryDate,
        currentKm,
        description,
        paidBy,
        value,
        remark,
        invoice,
        attachment,
        quotation2,
        quotation3
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
    if (remark !== undefined) sub.remark = remark;
    if (Number.isFinite(Number(serviceDurationDays)) && Number(serviceDurationDays) >= 1) {
        const n = Math.floor(Number(serviceDurationDays));
        sub.serviceDuration = `${n} day${n === 1 ? '' : 's'}`;
        const r = parseRemarkMeta(sub.remark);
        if (scheduledServiceDate) {
            r.adminScheduledServiceDate = String(scheduledServiceDate).slice(0, 10);
        }
        r.adminServiceDurationDays = n;
        sub.remark = JSON.stringify(r);
    }
    if (invoiceUrl != null) sub.invoice = invoiceUrl;
    if (attachmentUrl != null) sub.attachment = attachmentUrl;
    if (quotation2Url != null) sub.quotation2 = quotation2Url;
    if (quotation3Url != null) sub.quotation3 = quotation3Url;

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

        const cur = asset.activeServiceWorkflow;
        if (cur?.stage && ![STAGE.COMPLETE, STAGE.REJECTED].includes(cur.stage)) {
            return;
        }

        if (
            cur?.serviceRecordId &&
            [STAGE.COMPLETE, STAGE.REJECTED].includes(cur.stage)
        ) {
            const prevSub = asset.services?.id?.(cur.serviceRecordId);
            if (prevSub && !prevSub.workflowSnapshot?.stage) {
                persistWorkflowSnapshotToServiceSubdoc(asset);
            }
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

        const requesterName = await getRequesterName(req.user);

        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Service Request',
            status: 'Pending',
            assignedTo: hr._id,
            subjectEmployee: subjectEmp,
            requestedByName: requesterName,
            extra1: `${asset.assetId} — ${serviceType || 'Service'}`,
            extra2: 'Awaiting HR approval',
            extra3: vehicleServiceDashboardMeta(asset, serviceRecordId),
        });

        await sendWorkflowEmailWithConsole({
            recipient: hr,
            asset,
            stageLabel: 'HR approval required',
            actionLabel: 'New vehicle service request',
            detailLine: `${requesterName} logged a service (${serviceType}). Please approve or reject in your dashboard.`,
            linkPath: vehicleServiceDetailsPath(asset._id, serviceRecordId),
        });

        persistWorkflowSnapshotToServiceSubdoc(asset);
        asset.markModified('activeServiceWorkflow');
        await asset.save();
    } catch (e) {
        console.error('[VehicleServiceWorkflow] start failed:', e);
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
        if (!['approve', 'reject', 'hold', 'unhold'].includes(action)) {
            return res.status(400).json({ message: 'action must be approve, reject, hold, or unhold' });
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
                byName: actorName
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
            try {
                const hr = await resolveAssigneeForStage(STAGE.HR);
                if (hr?._id) {
                    await sendWorkflowEmailWithConsole({
                        recipient: hr,
                        asset,
                        stageLabel: 'Accounts hold',
                        actionLabel: 'Vehicle service request is on hold',
                        detailLine: `Accounts placed this request on hold until ${holdUntil.toISOString().slice(0, 10)}. Reason: ${reason}.`,
                        linkPath: vehicleServiceDetailsPath(asset._id, wf.serviceRecordId),
                    });
                }
            } catch (e) {
                console.error('[VehicleServiceWorkflow] hold notify HR failed:', e);
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
                byName: actorName
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
            await pushWorkflowHistory(asset, { stage, action: 'reject', note: comment || '', byName: actorName });
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
                            linkPath: vehicleServiceDetailsPath(asset._id, wf.serviceRecordId),
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
                            extra3: vehicleServiceDashboardMeta(asset, wf.serviceRecordId),
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

        await pushWorkflowHistory(asset, { stage, action: 'approve', note: comment || '', byName: actorName });
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

        let nextStage = null;
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
            asset.status = todayUtc >= startUtc && todayUtc <= endUtc ? 'On Service' : 'Waiting for Service';
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
                    extra3: vehicleServiceDashboardMeta(asset, wf.serviceRecordId),
                });
                await sendWorkflowEmailWithConsole({
                    recipient: nextAssignee,
                    asset,
                    stageLabel: 'Service scheduled (asset controller)',
                    actionLabel: 'Vehicle service window is scheduled',
                    detailLine: `A service date and duration are set. The vehicle is waiting for service until the first service day, then you can use Extend or Mark live during the window.`,
                    linkPath: vehicleServiceDetailsPath(asset._id, wf.serviceRecordId),
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
                        linkPath: vehicleServiceDetailsPath(asset._id, wf.serviceRecordId),
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
                extra3: vehicleServiceDashboardMeta(asset, wf.serviceRecordId),
            });

            await sendWorkflowEmailWithConsole({
                recipient: nextAssignee,
                asset,
                stageLabel: extra2,
                actionLabel: 'Vehicle service workflow',
                detailLine: `The request moved to the next step. Please review in VeRP.`,
                linkPath: vehicleServiceDetailsPath(asset._id, wf.serviceRecordId),
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
                        linkPath: vehicleServiceDetailsPath(asset._id, wf.serviceRecordId),
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
        res.status(500).json({ message: error.message || 'Server error' });
    }
};

function utcDayStart(d) {
    if (!d) return NaN;
    const x = new Date(d);
    return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
}

/**
 * POST /api/AssetItem/:id/service-workflow/period
 * { action: 'extend' | 'go_live', extendDays?, invoice?, comment? }
 * — Asset Controller: extend the scheduled in-shop window, or mark live (invoice required) to complete the workflow.
 */
export const respondVehicleServiceScheduledPeriod = async (req, res) => {
    try {
        const { id } = req.params;
        const { action, extendDays, invoice, comment } = req.body || {};
        if (!['extend', 'go_live', 'cancel', 'reject'].includes(String(action || ''))) {
            return res.status(400).json({ message: 'action must be extend, go_live, cancel, or reject' });
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
                    r.extendedByDays = (r.extendedByDays || 0) + ext;
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
            if (invoice?.data && serviceRecordId) {
                await mergeWorkflowServiceRecord(asset, serviceRecordId, { invoice });
            }
            if (serviceRecordId) {
                const sub = asset.services?.id?.(serviceRecordId);
                if (sub) {
                    const r = parseRemarkMeta(sub.remark);
                    r.vehicleServiceCompleted = 'live';
                    r.vehicleServiceCompletedAt = new Date().toISOString();
                    sub.remark = JSON.stringify(r);
                    asset.markModified('services');
                }
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
                note: 'Workflow completed — vehicle marked live (invoice saved)',
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
                        linkPath: vehicleServiceDetailsPath(asset._id, serviceRecordId),
                    });
                }
            } catch (notifyErr) {
                console.error('[VehicleServiceWorkflow] go_live notify stakeholders failed:', notifyErr);
            }
            persistWorkflowSnapshotToServiceSubdoc(asset);
            await asset.save();
            const doneFresh = await AssetItem.findById(asset._id).populate('assignedTo', 'firstName lastName employeeId');
            return res.json({ message: 'Vehicle is back in normal use — service workflow completed.', asset: doneFresh });
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
        console.error('[respondVehicleServiceScheduledPeriod]', error);
        res.status(500).json({ message: error.message || 'Server error' });
    }
};
