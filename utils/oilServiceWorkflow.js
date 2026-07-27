import mongoose from 'mongoose';
import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import DashboardAction from '../models/DashboardAction.js';
import { isFleetVehicleProfileActive } from './assetApprovalHelpers.js';
import { getDepartmentHOD, isUserActiveInFlowchart } from './getDepartmentHOD.js';
import { syncDashboardAction } from './syncDashboard.js';
import { closeAdminOfficerServiceTrackNotification } from './vehicleServiceAdminOfficerNotification.js';
import { sendVehicleServiceWorkflowEmail } from './sendVehicleServiceWorkflowEmail.js';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';
import {
    applyServiceActiveState,
    applyPostServiceOperationalState,
} from './assetOperationalFlags.js';
import { mergeWorkflowServiceRecord } from '../controllers/vehicleServiceWorkflowController.js';
import { isReqUserSystemSuperUser } from './systemSuperUser.js';
import { allocateNextServiceReqNo } from './assetServiceReqNo.js';
import {
    commitWorkflowContext,
    getWorkflowContextForService,
} from './vehicleServiceWorkflowResolve.js';

const STAGE_SCHEDULED = 'scheduled_service';
const STAGE_COMPLETE = 'complete';

const normEmpId = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');

export function isOilServiceWorkflowRecord(wf, service) {
    if (String(wf?.serviceTypeLabel || '').trim() === 'Oil Service') return true;
    return String(service?.serviceType || '').trim() === 'Oil Service';
}

export function isOilServiceLive(asset, service = null) {
    const serviceId = service?._id;
    const ctx = serviceId
        ? getWorkflowContextForService(asset, serviceId)
        : { wf: asset?.activeServiceWorkflow || null, bindActive: true };
    const wf = ctx.wf || {};
    if (!isOilServiceWorkflowRecord(wf, service)) return false;
    if (wf.oilServiceLiveAt) return true;
    const remark = parseOilServiceRemark(service);
    if (remark?.oilServiceLiveAt) return true;
    if (!ctx.bindActive) return false;
    return asset?.onServiceActive === true && String(wf.stage || '').toLowerCase() === STAGE_SCHEDULED;
}

export function isOilServiceWaitingForStartDate(asset, service = null) {
    const wf = asset?.activeServiceWorkflow || {};
    if (!isOilServiceWorkflowRecord(wf, service)) return false;
    if (String(wf.stage || '').toLowerCase() !== STAGE_SCHEDULED) return false;
    return !isOilServiceLive(asset, service);
}

export function oilServiceDetailsPath(vehicleId, serviceRecordId) {
    if (!vehicleId || !serviceRecordId) return null;
    return `/HRM/Asset/Vehicle/details/${vehicleId}/oil-service/${serviceRecordId}`;
}

function oilServiceDashboardMeta(asset, serviceRecordId) {
    const path = oilServiceDetailsPath(asset?._id, serviceRecordId);
    return JSON.stringify({
        vehicleId: asset?._id ? String(asset._id) : '',
        serviceRecordId: serviceRecordId ? String(serviceRecordId) : '',
        serviceType: 'Oil Service',
        detailsPath: path || '',
    });
}

function parseOilServiceDashboardMeta(extra3) {
    if (!extra3) return null;
    try {
        return typeof extra3 === 'object' ? extra3 : JSON.parse(String(extra3));
    } catch {
        return null;
    }
}

/** Clear pending vehicle-service bell rows when an oil service is finished. */
export async function closeOilServicePendingDashboardActions(
    assetId,
    serviceRecordId,
    { comment = 'Oil service completed', actionedBy = null } = {},
) {
    if (!assetId) return;

    const targetServiceId = serviceRecordId ? String(serviceRecordId) : '';
    const assetObjectId = assetId?._id || assetId;

    await DashboardAction.updateMany(
        {
            requestId: assetObjectId,
            requestType: 'Vehicle Service Request',
            status: 'Pending',
            requestedByName: 'Oil service completed',
        },
        {
            status: 'Approved',
            actionedDate: new Date(),
            actionedBy: actionedBy || null,
            comment: comment || 'Oil service completed',
        },
    );

    const pendingRows = await DashboardAction.find({
        requestId: assetObjectId,
        requestType: 'Vehicle Service Request',
        status: 'Pending',
    }).select('_id extra3').lean();

    const idsToClose = pendingRows
        .filter((row) => {
            if (!targetServiceId) return true;
            const meta = parseOilServiceDashboardMeta(row.extra3);
            if (!meta?.serviceRecordId) return true;
            return String(meta.serviceRecordId) === targetServiceId;
        })
        .map((row) => row._id);

    if (!idsToClose.length) return;

    await DashboardAction.updateMany(
        { _id: { $in: idsToClose } },
        {
            status: 'Approved',
            actionedDate: new Date(),
            actionedBy: actionedBy || null,
            comment: comment || 'Oil service completed',
        },
    );
}

/**
 * Remove stale pending vehicle-service inbox rows (legacy bug + already-completed services).
 * Safe to run on inbox sync — idempotent.
 */
export async function healStaleOilServicePendingDashboardActions({ assetIds = null } = {}) {
    const bugQuery = {
        status: 'Pending',
        requestType: 'Vehicle Service Request',
        requestedByName: 'Oil service completed',
    };
    if (Array.isArray(assetIds) && assetIds.length) {
        bugQuery.requestId = { $in: assetIds };
    }
    await DashboardAction.updateMany(bugQuery, {
        $set: {
            status: 'Approved',
            actionedDate: new Date(),
            comment: 'Oil service completed',
        },
    });

    const rowQuery = {
        status: 'Pending',
        requestType: 'Vehicle Service Request',
    };
    if (Array.isArray(assetIds) && assetIds.length) {
        rowQuery.requestId = { $in: assetIds };
    }

    const rows = await DashboardAction.find(rowQuery).select('_id requestId extra3 requestedByName').lean();
    if (!rows.length) return;

    const idsToLoad = [...new Set(rows.map((row) => String(row.requestId || '')).filter(Boolean))];
    const assets = await AssetItem.find({ _id: { $in: idsToLoad } })
        .select('_id services activeServiceWorkflow')
        .lean();
    const assetMap = Object.fromEntries(assets.map((asset) => [String(asset._id), asset]));

    const staleIds = [];
    for (const row of rows) {
        const asset = assetMap[String(row.requestId || '')];
        if (!asset) continue;

        const meta = parseOilServiceDashboardMeta(row.extra3);
        const serviceRecordId = meta?.serviceRecordId ? String(meta.serviceRecordId) : '';
        const service = serviceRecordId
            ? (asset.services || []).find((s) => String(s._id) === serviceRecordId)
            : null;

        if (service) {
            const remark = parseOilServiceRemark(service);
            if (String(remark.vehicleServiceCompleted || '').toLowerCase() === 'live') {
                staleIds.push(row._id);
                continue;
            }
        }

        const extra1 = String(row.extra1 || '');
        const detailsPath = String(meta?.detailsPath || '');
        const isOilServiceRow =
            /\bOil Service\b/i.test(extra1) ||
            String(meta?.serviceType || '').trim() === 'Oil Service' ||
            String(service?.serviceType || '').trim() === 'Oil Service';
        if (isOilServiceRow && detailsPath.includes('/service-requests/details/')) {
            staleIds.push(row._id);
            continue;
        }

        const wf = asset.activeServiceWorkflow || {};
        if (String(wf.stage || '').toLowerCase() === 'complete') {
            if (!serviceRecordId || String(wf.serviceRecordId || '') === serviceRecordId) {
                staleIds.push(row._id);
            }
        }
    }

    if (!staleIds.length) return;

    await DashboardAction.updateMany(
        { _id: { $in: staleIds }, status: 'Pending' },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment: 'Oil service completed',
            },
        },
    );
}

export function parseOilServiceRemark(service) {
    if (!service?.remark) return {};
    try {
        return typeof service.remark === 'object' ? service.remark : JSON.parse(service.remark);
    } catch {
        return {};
    }
}

function toEmpIdString(v) {
    if (!v) return null;
    if (typeof v === 'string') return v;
    if (v._id) return v._id.toString();
    if (v.toString) return v.toString();
    return null;
}

async function userMatchesFlowchartRole(reqUser, departmentKey) {
    if (!reqUser || !departmentKey) return false;
    let inFlow = false;
    try {
        inFlow = await isUserActiveInFlowchart(reqUser, departmentKey);
    } catch {
        inFlow = false;
    }
    if (inFlow) return true;
    const hod = await getDepartmentHOD(departmentKey);
    if (!hod) return false;
    if (hod._id && reqUser?.employeeObjectId) {
        if (hod._id.toString() === reqUser.employeeObjectId.toString()) return true;
    }
    if (hod.employeeId && reqUser?.employeeId) {
        if (normEmpId(hod.employeeId) === normEmpId(reqUser.employeeId)) return true;
    }
    return false;
}

/** Fleet Admin Officer / Admin Controller (flowchart admincontroller) — not portal/root super admin. */
export async function userIsOilServiceAdminOfficer(reqUser) {
    return userMatchesFlowchartRole(reqUser, 'admincontroller');
}

export async function userIsOilServiceAssetController(reqUser) {
    return userMatchesFlowchartRole(reqUser, 'assetcontroller');
}

export async function userIsOilServiceHr(reqUser) {
    return userMatchesFlowchartRole(reqUser, 'hr');
}

/**
 * Who may create / draft / submit (initiate) vehicle service requests:
 * Super User, Admin Officer/Controller, Asset Controller, HR,
 * assigned employee, or that assignee's HOD (primaryReportee).
 *
 * Create + first Initiate are opened to any authenticated user via
 * `actorMayCreateOrInitiateVehicleService` — do not use this for those gates.
 */
export async function actorMayManageOilService(reqUser, asset) {
    if (await isReqUserSystemSuperUser(reqUser)) return true;
    if (await userIsOilServiceAdminOfficer(reqUser)) return true;
    if (await userIsOilServiceAssetController(reqUser)) return true;
    if (await userIsOilServiceHr(reqUser)) return true;

    const currentEmpObjectId = reqUser?.employeeObjectId?.toString?.() || null;
    if (!currentEmpObjectId || !asset?.assignedTo) return false;

    const assigneeId = toEmpIdString(asset.assignedTo);
    if (assigneeId && assigneeId === currentEmpObjectId) return true;

    let assigneeDoc =
        typeof asset.assignedTo === 'object' && asset.assignedTo?.primaryReportee !== undefined
            ? asset.assignedTo
            : await EmployeeBasic.findById(assigneeId)
                .select('primaryReportee')
                .lean()
                .catch(() => null);

    const hodId = toEmpIdString(assigneeDoc?.primaryReportee);
    return !!(hodId && hodId === currentEmpObjectId);
}

/**
 * Create service + Initiate (submit pending/draft) — any authenticated ERP user.
 * Later workflow stages still use actorMayManageOilService / stage assignees.
 */
export async function actorMayCreateOrInitiateVehicleService(reqUser) {
    if (!reqUser) return false;
    if (await isReqUserSystemSuperUser(reqUser)) return true;
    return Boolean(
        reqUser._id ||
            reqUser.id ||
            reqUser.employeeObjectId ||
            reqUser.employeeId,
    );
}

/** Tire change uses the same manual-request roles as oil service (no system auto-create). */
export async function actorMayManageTireChangeRequest(reqUser, asset) {
    return actorMayManageOilService(reqUser, asset);
}

export async function userMayEditOilServiceDates(reqUser, asset, serviceId) {
    if (await isReqUserSystemSuperUser(reqUser)) return true;
    if (!asset || !serviceId) return false;

    const service = asset.services?.id?.(serviceId);
    if (!service) return false;
    const wf = asset.activeServiceWorkflow;
    if (!wf || wf.stage !== STAGE_SCHEDULED) return false;
    if (!isOilServiceWorkflowRecord(wf, service)) return false;

    const remark = parseOilServiceRemark(service);
    if (String(remark.requestStatus || '').toLowerCase() !== 'submitted') return false;

    if (await userIsOilServiceAdminOfficer(reqUser)) return true;

    if (isOilServiceWaitingForStartDate(asset, service)) {
        return actorMayManageOilService(reqUser, asset);
    }

    return false;
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

async function sendOilEmail({ recipient, asset, actionLabel, detailLine, linkPath, cc = [] }) {
    const who = `${recipient?.firstName || ''} ${recipient?.lastName || ''}`.trim() || recipient?.employeeId || 'Unknown';
    const { email } = resolveEmployeeEmail(recipient || {});
    console.log(`[OilService][Email] ${actionLabel} -> ${who} <${email || 'no-email'}>`);
    if (!email) return;
    await sendVehicleServiceWorkflowEmail({
        recipient,
        asset,
        stageLabel: 'Oil service',
        actionLabel,
        detailLine,
        linkPath,
        cc,
    });
}

function pickOilServiceNotifyEmail(emp) {
    if (!emp) return null;
    const { email } = resolveEmployeeEmail(emp);
    if (email) return email;
    return String(emp.companyEmail || emp.workEmail || emp.email || '').trim() || null;
}

/** Collect unique company/work emails for CC, excluding the primary TO address. */
function collectCcEmails(employees, excludeTo = null) {
    const set = new Set();
    for (const emp of employees || []) {
        const addr = pickOilServiceNotifyEmail(emp);
        if (addr) set.add(addr);
    }
    const exclude = String(excludeTo || '').trim().toLowerCase();
    if (exclude) {
        for (const addr of [...set]) {
            if (addr.toLowerCase() === exclude) set.delete(addr);
        }
    }
    return [...set];
}

/**
 * Service details submitted — one email to Admin Officer (TO), assignee + HR (CC) on company email.
 */
async function notifyOilServiceDetailsCompleted({
    asset,
    serviceRecordId,
    adminOfficer,
    hr,
    assignee,
    detailLine,
    actionedBy = null,
}) {
    const linkPath = oilServiceDetailsPath(asset._id, serviceRecordId);
    const adminTo = pickOilServiceNotifyEmail(adminOfficer);
    if (!adminTo) {
        console.warn('[OilService] Admin Officer has no company email — skipping completion email.');
    } else {
        const cc = collectCcEmails([hr, assignee], adminTo);
        await sendOilEmail({
            recipient: adminOfficer,
            asset,
            actionLabel: 'Oil service completed',
            detailLine,
            linkPath,
            cc,
        });

        console.log(
            `[OilService][Email] Oil service completed -> TO: ${adminTo}${cc.length ? `, CC: ${cc.join(', ')}` : ''}`,
        );
    }

    await closeOilServicePendingDashboardActions(asset._id, serviceRecordId, {
        comment: detailLine || 'Oil service completed',
        actionedBy,
    });

    await closeAdminOfficerServiceTrackNotification({
        assetId: asset._id,
        serviceRecordId,
        actionedBy,
        comment: detailLine || 'Oil service completed',
    });
}

async function notifyStakeholders({ asset, serviceRecordId, recipients, actionLabel, detailLine }) {
    const linkPath = oilServiceDetailsPath(asset._id, serviceRecordId);
    const list = uniqRecipients(recipients);
    for (const recipient of list) {
        await sendOilEmail({ recipient, asset, actionLabel, detailLine, linkPath });
        if (recipient?._id) {
            await syncDashboardAction({
                requestId: asset._id,
                requestType: 'Vehicle Service Request',
                status: 'Pending',
                assignedTo: recipient._id,
                subjectEmployee: asset.assignedTo,
                requestedByName: actionLabel,
                extra1: `${asset.assetId} — Oil Service`,
                extra2: detailLine,
                extra3: oilServiceDashboardMeta(asset, serviceRecordId),
            });
        }
    }
}

/** Email HR, Admin Officer, and assignee when oil service moves to On Service (once per workflow). */
async function notifyOilServiceWentLiveIfNeeded(asset, serviceRecordId, { detailLine } = {}) {
    const wf = asset?.activeServiceWorkflow;
    if (!wf || wf.oilServiceLiveNotifiedAt) return false;

    const populated = await AssetItem.findById(asset._id)
        .populate('assignedTo', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
        .lean();
    if (!populated) return false;

    const hr = await getDepartmentHOD('hr');
    const adminOfficer = await getDepartmentHOD('admincontroller');
    const assignee = populated?.assignedTo || null;
    const plate = [populated?.plateEmirate, populated?.plateNumber].filter(Boolean).join(' ').trim();
    const message =
        detailLine ||
        `Oil service for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''} has started today. The vehicle is now on service.`;

    await notifyStakeholders({
        asset: populated,
        serviceRecordId,
        recipients: [hr, adminOfficer, assignee],
        actionLabel: 'Vehicle on service',
        detailLine: message,
    });

    const fresh = await AssetItem.findById(asset._id);
    if (fresh?.activeServiceWorkflow) {
        fresh.activeServiceWorkflow.oilServiceLiveNotifiedAt = new Date();
        fresh.markModified('activeServiceWorkflow');
        await fresh.save();
    }

    return true;
}

export async function getRequesterName(reqUser) {
    if (!reqUser) return 'User';
    if (reqUser.employeeObjectId) {
        const emp = await EmployeeBasic.findById(reqUser.employeeObjectId)
            .select('firstName lastName')
            .lean();
        if (emp) {
            const n = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();
            if (n) return n;
        }
    }
    return (reqUser.name && String(reqUser.name).trim()) || 'User';
}

function pushWorkflowHistory(asset, { stage, action, note, byName }) {
    if (!asset.activeServiceWorkflow) asset.activeServiceWorkflow = {};
    if (!Array.isArray(asset.activeServiceWorkflow.history)) asset.activeServiceWorkflow.history = [];
    asset.activeServiceWorkflow.history.push({
        stage,
        action,
        note: note || '',
        byName: byName || '',
        bySignatureUrl: '',
        at: new Date(),
    });
}

/** Persist oil-service timeline rows on the service remark (survives before workflow starts). */
export function appendOilServiceActivity(service, { type, byName, note = '', meta = {} }) {
    const remark = parseOilServiceRemark(service);
    if (!Array.isArray(remark.oilActivityLog)) remark.oilActivityLog = [];
    remark.oilActivityLog.push({
        type,
        byName: byName || '',
        note: note || '',
        at: new Date().toISOString(),
        ...meta,
    });
    service.remark = JSON.stringify(remark);
}

function syncOilActivityToWorkflowHistory(asset, serviceId, { type, byName, note }) {
    if (!asset?.activeServiceWorkflow) return;
    if (String(asset.activeServiceWorkflow.serviceRecordId) !== String(serviceId)) return;
    const stageByType = {
        service_created: 'created',
        service_updated: 'pending',
        service_scheduled: STAGE_SCHEDULED,
        on_service: STAGE_SCHEDULED,
        date_change: STAGE_SCHEDULED,
        service_completed: STAGE_COMPLETE,
    };
    const actionByType = {
        service_created: 'created',
        service_updated: 'updated',
        service_scheduled: 'scheduled',
        on_service: 'on_service',
        date_change: 'date_change',
        service_completed: 'completed',
    };
    pushWorkflowHistory(asset, {
        stage: stageByType[type] || type,
        action: actionByType[type] || type,
        note,
        byName,
    });
}

function recordOilServiceActivity(asset, service, serviceId, entry) {
    appendOilServiceActivity(service, entry);
    syncOilActivityToWorkflowHistory(asset, serviceId, entry);
}

function persistWorkflowSnapshot(asset) {
    const wf = asset.activeServiceWorkflow;
    if (!wf?.serviceRecordId) return;
    const sub = asset.services?.id?.(wf.serviceRecordId);
    if (!sub) return;
    sub.workflowSnapshot = {
        stage: wf.stage,
        serviceTypeLabel: wf.serviceTypeLabel || '',
        serviceRecordId: wf.serviceRecordId,
        history: Array.isArray(wf.history) ? wf.history : [],
        scheduledServiceDate: wf.scheduledServiceDate || null,
        serviceWindowEndDate: wf.serviceWindowEndDate || null,
    };
}

function utcDayStart(value) {
    const d = value ? new Date(value) : new Date();
    if (Number.isNaN(d.getTime())) return null;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function resolveServiceEndDate(remark) {
    const raw =
        remark.serviceEndDate ||
        remark.nextChangeMonth ||
        '';
    if (!raw) return null;
    const str = String(raw).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) return new Date(str.slice(0, 10));
    if (/^\d{4}-\d{2}$/.test(str)) return new Date(`${str}-01`);
    const d = new Date(str);
    return Number.isNaN(d.getTime()) ? null : d;
}

function resolveServiceStartDate(remark) {
    const raw = remark.serviceStartDate || remark.scheduledServiceDate || '';
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Flip oil service from Scheduled → On Service when the start date is reached.
 * Idempotent — safe to call on page load and from cron.
 */
export async function activateOilServiceOnStartDate(
    asset,
    { byName = 'System', force = false, notify = true, detailLine } = {},
) {
    const wf = asset?.activeServiceWorkflow;
    if (!wf || String(wf.stage || '').toLowerCase() !== STAGE_SCHEDULED) return false;
    if (!isOilServiceWorkflowRecord(wf, asset.services?.id?.(wf.serviceRecordId))) return false;
    if (isOilServiceLive(asset, asset.services?.id?.(wf.serviceRecordId))) return false;

    const service = asset.services?.id?.(wf.serviceRecordId);
    if (!service) return false;

    const remark = parseOilServiceRemark(service);
    const startD = resolveServiceStartDate(remark) || wf.scheduledServiceDate;
    if (!startD) return false;

    const today = utcDayStart(new Date());
    const startUtc = utcDayStart(startD);
    if (!force && (startUtc == null || today < startUtc)) return false;

    const liveAt = new Date();
    wf.oilServiceLiveAt = liveAt;
    remark.oilServiceLiveAt = liveAt.toISOString();
    remark.workflowStage = STAGE_SCHEDULED;
    service.remark = JSON.stringify(remark);

    recordOilServiceActivity(asset, service, service._id, {
        type: 'on_service',
        byName,
        note: 'Service start date reached — vehicle on service',
    });

    asset.onServiceActive = true;
    applyServiceActiveState(asset);
    persistWorkflowSnapshot(asset);
    asset.markModified('services');
    asset.markModified('activeServiceWorkflow');
    await asset.save();

    if (notify) {
        await notifyOilServiceWentLiveIfNeeded(asset, service._id, { detailLine });
    }

    return true;
}

/** Cron + batch: activate oil services whose start date is today or earlier. */
export async function processOilServiceStartDateActivation() {
    try {
        const items = await AssetItem.find({
            'activeServiceWorkflow.stage': STAGE_SCHEDULED,
            'activeServiceWorkflow.serviceTypeLabel': 'Oil Service',
            $or: [
                { 'activeServiceWorkflow.oilServiceLiveAt': { $exists: false } },
                { 'activeServiceWorkflow.oilServiceLiveAt': null },
            ],
            onServiceActive: { $ne: true },
        })
            .select('_id')
            .limit(500)
            .lean();

        for (const row of items) {
            const asset = await AssetItem.findById(row._id);
            if (!asset) continue;
            await activateOilServiceOnStartDate(asset, { byName: 'System', notify: true });
        }

        const missedNotify = await AssetItem.find({
            'activeServiceWorkflow.stage': STAGE_SCHEDULED,
            'activeServiceWorkflow.serviceTypeLabel': 'Oil Service',
            'activeServiceWorkflow.oilServiceLiveAt': { $exists: true, $ne: null },
            $or: [
                { 'activeServiceWorkflow.oilServiceLiveNotifiedAt': { $exists: false } },
                { 'activeServiceWorkflow.oilServiceLiveNotifiedAt': null },
            ],
        })
            .select('_id activeServiceWorkflow')
            .limit(200)
            .lean();

        for (const row of missedNotify) {
            const asset = await AssetItem.findById(row._id);
            if (!asset?.activeServiceWorkflow?.serviceRecordId) continue;
            await notifyOilServiceWentLiveIfNeeded(asset, asset.activeServiceWorkflow.serviceRecordId);
        }
    } catch (e) {
        console.error('[processOilServiceStartDateActivation]', e);
    }
}

/**
 * Submit oil service assignment (pending row → scheduled; on service begins on start date).
 */
export async function submitOilServiceAssignment(asset, serviceId, req) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    if (String(service.serviceType || '').trim() !== 'Oil Service') {
        throw new Error('Not an oil service record');
    }

    const remark = parseOilServiceRemark(service);
    const reqStatus = String(remark.requestStatus || '').toLowerCase();
    if (!['draft', 'pending'].includes(reqStatus)) {
        throw new Error('Only pending oil service requests can be submitted.');
    }

    const startD = resolveServiceStartDate(remark);
    const endD = resolveServiceEndDate(remark);
    if (!startD || !endD) {
        throw new Error('Service start date and service end date are required.');
    }
    if (utcDayStart(endD) < utcDayStart(startD)) {
        throw new Error('Service end date must be on or after service start date.');
    }

    const requesterName = await getRequesterName(req.user);
    const previousStatus = asset.status;

    remark.requestStatus = 'submitted';
    remark.assignmentSubmittedAt = new Date().toISOString();
    remark.oilServiceScheduledAt = remark.assignmentSubmittedAt;
    remark.requestedByName = requesterName;
    remark.workflowStage = STAGE_SCHEDULED;
    service.remark = JSON.stringify(remark);

    // Keep prior in-progress workflow on its service row when starting another oil request.
    const priorWf = asset.activeServiceWorkflow;
    if (
        priorWf?.serviceRecordId &&
        String(priorWf.serviceRecordId) !== String(service._id)
    ) {
        persistWorkflowSnapshot(asset);
    }

    if (!asset.activeServiceWorkflow) asset.activeServiceWorkflow = {};
    asset.activeServiceWorkflow = {
        serviceRecordId: service._id,
        stage: STAGE_SCHEDULED,
        previousStatus,
        serviceTypeLabel: 'Oil Service',
        scheduledServiceDate: startD,
        serviceWindowEndDate: endD,
        serviceDurationEmailSentAt: null,
        oilServiceOverdueNotifiedAt: null,
        oilServiceLiveAt: null,
        history: [],
    };

    recordOilServiceActivity(asset, service, service._id, {
        type: 'service_scheduled',
        byName: requesterName,
        note: 'Oil service scheduled',
    });

    const today = utcDayStart(new Date());
    const startUtc = utcDayStart(startD);
    if (startUtc != null && today >= startUtc) {
        await activateOilServiceOnStartDate(asset, { byName: requesterName, force: true, notify: false });
    } else {
        asset.onServiceActive = false;
        persistWorkflowSnapshot(asset);
        asset.markModified('services');
        asset.markModified('activeServiceWorkflow');
        await asset.save();
    }

    // Paid oil assignment: create Zoho Bill when Pay Account + amount are on the garage row.
    try {
        const liveService = asset.services?.id?.(serviceId);
        const liveRemark = parseOilServiceRemark(liveService);
        const amountMode = String(liveRemark.amountMode || '').toLowerCase();
        const hasPayAccount = Boolean(
            String(liveRemark.payAccountId || liveRemark.garagePayAccountId || '').trim(),
        );
        if (amountMode !== 'warranty' && hasPayAccount && liveService) {
            const { syncVehicleGarageServiceToZoho } = await import('./syncVehicleGarageServiceToZoho.js');
            await syncVehicleGarageServiceToZoho({
                asset,
                service: liveService,
                serviceTypeLabel: 'Oil Service',
            });
            asset.markModified('services');
            await asset.save();
        }
    } catch (zohoErr) {
        console.warn('[OilService] Zoho bill on assignment failed:', zohoErr?.message || zohoErr);
    }

    const populated = await AssetItem.findById(asset._id)
        .populate('assignedTo', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
        .lean();
    const hr = await getDepartmentHOD('hr');
    const adminOfficer = await getDepartmentHOD('admincontroller');
    const assignee = populated?.assignedTo || null;

    const plate = [populated?.plateEmirate, populated?.plateNumber].filter(Boolean).join(' ').trim();
    const startLabel = startD.toISOString().slice(0, 10);
    const isLive = isOilServiceLive(populated, populated?.services?.find?.((s) => String(s._id) === String(service._id)));
    const detailLine = isLive
        ? `${requesterName} submitted an oil service request for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''}. The vehicle is now on service.`
        : `${requesterName} scheduled an oil service for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''}. Service starts on ${startLabel}.`;

    if (isLive) {
        await notifyOilServiceWentLiveIfNeeded(populated, service._id, { detailLine });
    } else {
        await notifyStakeholders({
            asset: populated,
            serviceRecordId: service._id,
            recipients: [hr, adminOfficer, assignee],
            actionLabel: 'Oil service scheduled',
            detailLine,
        });
    }

    return populated;
}

/**
 * Save oil service details draft (no workflow advance).
 */
export async function saveOilServiceDetailsDraft(asset, serviceId, serviceUpdates) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    const { wf, bindActive } = getWorkflowContextForService(asset, serviceId);
    if (!wf || wf.stage !== STAGE_SCHEDULED) {
        throw new Error('Oil service details can only be saved while the service is active.');
    }
    if (!isOilServiceLive(asset, service)) {
        throw new Error('Service details are available only after the scheduled start date, when the vehicle is on service.');
    }

    const remark = parseOilServiceRemark(service);
    remark.serviceDetailsDraft = true;
    remark.serviceDetailsDraftAt = new Date().toISOString();
    if (serviceUpdates?.remark) {
        await mergeWorkflowServiceRecord(asset, serviceId, serviceUpdates);
    } else {
        service.remark = JSON.stringify({ ...remark, ...parseOilServiceRemark(service) });
    }

    commitWorkflowContext(asset, serviceId, { wf, bindActive });
    asset.markModified('services');
    await asset.save();
    return asset;
}

/**
 * Submit oil service details → complete workflow, restore vehicle status, notify stakeholders.
 */
export async function submitOilServiceDetails(asset, serviceId, serviceUpdates, req) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    const { wf, bindActive } = getWorkflowContextForService(asset, serviceId);
    if (!wf || wf.stage !== STAGE_SCHEDULED) {
        throw new Error('Oil service details can only be submitted while the service is active.');
    }
    if (!isOilServiceLive(asset, service)) {
        throw new Error('Service details can only be submitted after the scheduled start date, when the vehicle is on service.');
    }

    if (serviceUpdates && typeof serviceUpdates === 'object') {
        await mergeWorkflowServiceRecord(asset, serviceId, serviceUpdates);
    }

    const remark = parseOilServiceRemark(asset.services.id(serviceId));
    if (!String(remark.returnDate || '').trim() || !String(remark.handOverDate || '').trim()) {
        throw new Error('Return date and hand over date are required before submitting service details.');
    }

    const serviceRow = asset.services.id(serviceId);
    const totalCharge = Number(remark.totalServiceCharge ?? serviceRow?.value);
    if (!Number.isFinite(totalCharge) || totalCharge <= 0) {
        throw new Error('Total service charge is required and must be greater than 0.');
    }

    const actorName = await getRequesterName(req.user);
    wf.stage = STAGE_COMPLETE;
    remark.serviceDetailsDraft = false;
    remark.vehicleServiceCompleted = 'live';
    remark.vehicleServiceCompletedAt = new Date().toISOString();
    remark.workflowStage = STAGE_COMPLETE;
    asset.services.id(serviceId).remark = JSON.stringify(remark);

    recordOilServiceActivity(asset, service, serviceId, {
        type: 'service_completed',
        byName: actorName,
        note: 'Oil service completed',
    });

    if (bindActive) {
        applyPostServiceOperationalState(asset, { statusBeforeService: wf.previousStatus || null });
        asset.onServiceActive = false;
    }

    commitWorkflowContext(asset, serviceId, { wf, bindActive });
    asset.markModified('services');
    await asset.save();

    // Paid oil jobs: Vendor = Garage, Pay Account, Amount → Zoho Bill (same as shop garage services).
    let zohoBillSync = null;
    try {
        const completedService = asset.services.id(serviceId);
        const completedRemark = parseOilServiceRemark(completedService);
        const amountMode = String(completedRemark.amountMode || '').toLowerCase();
        const hasPayAccount = Boolean(
            String(completedRemark.payAccountId || completedRemark.garagePayAccountId || '').trim(),
        );
        if (amountMode !== 'warranty' && hasPayAccount) {
            const { syncVehicleGarageServiceToZoho } = await import('./syncVehicleGarageServiceToZoho.js');
            zohoBillSync = await syncVehicleGarageServiceToZoho({
                asset,
                service: completedService,
                serviceTypeLabel: 'Oil Service',
            });
            asset.markModified('services');
            await asset.save();
        }
    } catch (zohoErr) {
        console.warn('[OilService] Zoho garage bill sync failed:', zohoErr?.message || zohoErr);
        zohoBillSync = { ok: false, message: zohoErr?.message || 'Zoho bill sync failed' };
    }

    const populated = await AssetItem.findById(asset._id)
        .populate('assignedTo', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
        .lean();
    const hr = await getDepartmentHOD('hr');
    const adminOfficer = await getDepartmentHOD('admincontroller');
    const assignee = populated?.assignedTo || null;

    const detailLine = `Oil service for ${populated?.assetId || ''} has been completed. The vehicle status has been restored.`;

    await notifyOilServiceDetailsCompleted({
        asset: populated,
        serviceRecordId: serviceId,
        adminOfficer,
        hr,
        assignee,
        detailLine,
        actionedBy: req.user?.employeeObjectId || req.user?._id || null,
    });

    return { asset: populated, zohoBillSync };
}

/**
 * Admin officer or assignee (while scheduled) may update service start/end dates.
 */
export async function updateOilServiceDates(asset, serviceId, { serviceStartDate, serviceEndDate }, reqUser) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    const { wf, bindActive } = getWorkflowContextForService(asset, serviceId);
    if (!wf || wf.stage !== STAGE_SCHEDULED) {
        throw new Error('Service dates can only be updated during an active oil service.');
    }

    const remark = parseOilServiceRemark(service);
    const prevStart = remark.serviceStartDate || '';
    const prevEnd = remark.serviceEndDate || '';
    const actorName = await getRequesterName(reqUser);

    if (serviceStartDate) {
        remark.serviceStartDate = serviceStartDate;
        wf.scheduledServiceDate = new Date(serviceStartDate);
    }
    if (serviceEndDate) {
        remark.serviceEndDate = serviceEndDate;
        remark.nextChangeMonth = String(serviceEndDate).slice(0, 7);
        wf.serviceWindowEndDate = new Date(serviceEndDate);
        wf.serviceDurationEmailSentAt = null;
        wf.oilServiceOverdueNotifiedAt = null;
    }

    if (
        serviceStartDate &&
        String(prevStart).slice(0, 10) !== String(serviceStartDate).slice(0, 10)
    ) {
        const entry = {
            type: 'date_change',
            byName: actorName,
            note: 'Service start date updated',
            field: 'start',
            from: prevStart,
            to: serviceStartDate,
        };
        appendOilServiceActivity(service, entry);
        syncOilActivityToWorkflowHistory(asset, serviceId, entry);
    }
    if (serviceEndDate && String(prevEnd).slice(0, 10) !== String(serviceEndDate).slice(0, 10)) {
        const entry = {
            type: 'date_change',
            byName: actorName,
            note: 'Service end date updated',
            field: 'end',
            from: prevEnd,
            to: serviceEndDate,
        };
        appendOilServiceActivity(service, entry);
        syncOilActivityToWorkflowHistory(asset, serviceId, entry);
    }

    const mergedRemark = parseOilServiceRemark(service);
    if (serviceStartDate) mergedRemark.serviceStartDate = serviceStartDate;
    if (serviceEndDate) {
        mergedRemark.serviceEndDate = serviceEndDate;
        mergedRemark.nextChangeMonth = String(serviceEndDate).slice(0, 7);
    }
    service.remark = JSON.stringify(mergedRemark);
    commitWorkflowContext(asset, serviceId, { wf, bindActive });
    asset.markModified('services');
    await asset.save();
    return asset;
}

/** Extend service end date for oil service at any active workflow stage. */
export async function updateOilServiceEndDateExtend(asset, serviceId, { serviceEndDate }, reqUser) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    const { wf, bindActive } = getWorkflowContextForService(asset, serviceId);
    if (!wf || !isOilServiceWorkflowRecord(wf, service)) {
        throw new Error('Not an oil service workflow.');
    }

    const endDate = String(serviceEndDate || '').trim().slice(0, 10);
    if (!endDate) throw new Error('Extend date is required');

    const remark = parseOilServiceRemark(service);
    const prevEnd = remark.serviceEndDate || '';
    const actorName = await getRequesterName(reqUser);

    remark.serviceEndDate = endDate;
    remark.nextChangeMonth = String(endDate).slice(0, 7);
    wf.serviceWindowEndDate = new Date(endDate);
    wf.serviceDurationEmailSentAt = null;
    wf.oilServiceOverdueNotifiedAt = null;

    if (String(prevEnd).slice(0, 10) !== endDate) {
        const entry = {
            type: 'date_change',
            byName: actorName,
            note: 'Extend date updated',
            field: 'end',
            from: prevEnd,
            to: endDate,
        };
        appendOilServiceActivity(service, entry);
        syncOilActivityToWorkflowHistory(asset, serviceId, entry);
    }

    service.remark = JSON.stringify(remark);
    commitWorkflowContext(asset, serviceId, { wf, bindActive });
    asset.markModified('services');
    await asset.save();
    return asset;
}

function isApprovedOilServiceRow(asset, service) {
    if (!service || String(service.serviceType || '').trim() !== 'Oil Service') return false;
    const remark = parseOilServiceRemark(service);
    if (String(remark?.requestStatus || '').toLowerCase() === 'draft') return false;
    if (String(remark?.vehicleServiceCompleted || '').toLowerCase() === 'live') return true;
    if (String(service?.workflowSnapshot?.stage || '').toLowerCase() === 'complete') return true;
    const wf = asset?.activeServiceWorkflow || {};
    if (
        String(wf.serviceRecordId || '') === String(service._id || '') &&
        String(wf.stage || '').toLowerCase() === STAGE_COMPLETE &&
        isOilServiceWorkflowRecord(wf, service)
    ) {
        return true;
    }
    return false;
}

/** Most recent oil service row on the asset (the "previous" row before auto-creating the next). */
function findPreviousOilServiceRow(asset) {
    const services = Array.isArray(asset?.services) ? asset.services : [];
    return (
        services
            .filter((s) => String(s.serviceType || '').trim() === 'Oil Service')
            .sort((a, b) => new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0))[0] ||
        null
    );
}

function isCompletedOilService(asset, service) {
    return isApprovedOilServiceRow(asset, service);
}

function findLatestCompletedOilService(asset) {
    const previous = findPreviousOilServiceRow(asset);
    return previous && isApprovedOilServiceRow(asset, previous) ? previous : null;
}

function isOpenOilServiceRecord(asset, service) {
    if (!service || String(service.serviceType || '').trim() !== 'Oil Service') return false;
    const remark = parseOilServiceRemark(service);
    const requestStatus = String(remark?.requestStatus || '').toLowerCase();
    if (['draft', 'pending', 'submitted'].includes(requestStatus)) return true;
    if (String(remark?.vehicleServiceCompleted || '').toLowerCase() === 'live') return true;
    const wf = asset?.activeServiceWorkflow || {};
    const wfStage = String(wf.stage || '').toLowerCase();
    if (
        String(wf.serviceRecordId || '') === String(service._id || '') &&
        isOilServiceWorkflowRecord(wf, service) &&
        wfStage &&
        !['complete', 'rejected'].includes(wfStage)
    ) {
        return true;
    }
    return false;
}

function hasOpenOilServiceRequest(asset) {
    const wf = asset?.activeServiceWorkflow || {};
    const wfStage = String(wf.stage || '').toLowerCase();
    if (
        isOilServiceWorkflowRecord(wf, null) &&
        wfStage &&
        !['complete', 'rejected'].includes(wfStage)
    ) {
        return true;
    }
    for (const service of asset?.services || []) {
        if (isOpenOilServiceRecord(asset, service)) return true;
    }
    return false;
}

function resolveNextOilServiceDateFromRemark(remark, asset) {
    const month = String(remark?.nextChangeMonth || '').trim();
    if (/^\d{4}-\d{2}$/.test(month)) {
        return new Date(`${month}-01`);
    }
    const end = String(remark?.serviceEndDate || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(end)) {
        return new Date(end.slice(0, 10));
    }
    const remarkNext = String(remark?.nextServiceDate || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(remarkNext)) {
        return new Date(remarkNext.slice(0, 10));
    }
    if (asset?.nextServiceDate) {
        const assetNext = new Date(asset.nextServiceDate);
        if (!Number.isNaN(assetNext.getTime())) return assetNext;
    }
    return null;
}

function formatOilDueDateLabel(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
}

/** True when an auto-created due request is still open (blocks duplicate auto-create). */
function hasOpenAutoCreatedOilService(asset) {
    for (const service of asset?.services || []) {
        if (String(service?.serviceType || '').trim() !== 'Oil Service') continue;
        const remark = parseOilServiceRemark(service);
        if (!remark?.autoCreated) continue;
        if (isOpenOilServiceRecord(asset, service)) return true;
    }
    return false;
}

/**
 * Due when:
 * 1) vehicle current km == previous row next oil change km, or
 * 2) previous row next oil service date == today.
 * Previous row may be any status (not only completed).
 */
function evaluateOilServiceDue(asset, previousRow) {
    if (!previousRow) {
        return { due: false, dateDue: false, kmDue: false, nextDate: null, nextKm: null };
    }

    const previousRemark = parseOilServiceRemark(previousRow);
    const today = utcDayStart(new Date());
    const nextDate = resolveNextOilServiceDateFromRemark(previousRemark, asset);
    const nextDateDay = nextDate != null ? utcDayStart(nextDate) : null;
    const dateDue = nextDateDay != null && today != null && nextDateDay === today;

    const nextKm = Number(previousRemark?.nextChangeKm);
    const currentKm = Number(asset?.currentKilometer);
    const kmDue =
        Number.isFinite(nextKm) &&
        nextKm > 0 &&
        Number.isFinite(currentKm) &&
        currentKm === nextKm;

    if (!dateDue && !kmDue) {
        return {
            due: false,
            dateDue: false,
            kmDue: false,
            nextDate,
            nextKm: Number.isFinite(nextKm) && nextKm > 0 ? nextKm : null,
            currentKm: Number.isFinite(currentKm) ? currentKm : null,
        };
    }

    let reason = 'due_date';
    if (dateDue && kmDue) reason = 'due_date_and_km';
    else if (kmDue) reason = 'due_km';

    return {
        due: true,
        reason,
        dateDue,
        kmDue,
        nextDate,
        nextKm: Number.isFinite(nextKm) && nextKm > 0 ? nextKm : null,
        currentKm: Number.isFinite(currentKm) ? currentKm : null,
    };
}

/**
 * When the previous oil service row (any status) has next service date == today
 * or current km == next change km, create a pending oil service row and email
 * Admin Officer, assigned user, and Management.
 */
export async function maybeAutoCreateOilServiceDue(assetDoc) {
    if (!assetDoc) return false;
    if (!String(assetDoc.plateNumber || '').trim()) return false;
    if (!isFleetVehicleProfileActive(assetDoc)) return false;
    // Only block when an auto-created due request is already open (not by previous-row status).
    if (hasOpenAutoCreatedOilService(assetDoc)) return false;

    const previousRow = findPreviousOilServiceRow(assetDoc);
    if (!previousRow) return false;

    const dueInfo = evaluateOilServiceDue(assetDoc, previousRow);
    if (!dueInfo.due) return false;

    const previousRemark = parseOilServiceRemark(previousRow);
    const followId = previousRemark.autoOilFollowUpServiceId;
    if (followId) {
        const followUp =
            assetDoc.services?.id?.(followId) ||
            (assetDoc.services || []).find((s) => String(s?._id) === String(followId));
        if (followUp) return false;
    }

    const completedMeta = previousRemark;
    const currentKm = Number(
        assetDoc.currentKilometer ?? completedMeta?.currentKm ?? previousRow?.currentKm ?? 0,
    );
    const serviceId = new mongoose.Types.ObjectId();
    const remarkObj = {
        serviceSubtype: 'Oil Service',
        amountMode: 'amount',
        requestStatus: 'pending',
        currentKm: Number.isFinite(currentKm) ? currentKm : 0,
        nextChangeKm: completedMeta?.nextChangeKm ?? 0,
        serviceEndDate: '',
        nextChangeMonth: completedMeta?.nextChangeMonth || '',
        oilServiceTypeText: '',
        autoCreated: true,
        autoCreatedReason: dueInfo.reason,
        autoCreatedAt: new Date().toISOString(),
        ...(previousRow?._id ? { autoCreatedFromServiceId: String(previousRow._id) } : {}),
    };

    const newService = {
        _id: serviceId,
        serviceReqNo: allocateNextServiceReqNo(assetDoc),
        serviceType: 'Oil Service',
        date: new Date(),
        currentKm: remarkObj.currentKm,
        description: '',
        paidBy: 'Company',
        value: 0,
        remark: JSON.stringify(remarkObj),
    };

    assetDoc.services.push(newService);
    appendOilServiceActivity(newService, {
        type: 'service_created',
        byName: 'System',
        note: 'Oil service request auto-created — change due',
    });

    if (previousRow) {
        const sourceRemark = parseOilServiceRemark(previousRow);
        sourceRemark.autoOilFollowUpServiceId = String(serviceId);
        sourceRemark.autoOilFollowUpCreatedAt = new Date().toISOString();
        previousRow.remark = JSON.stringify(sourceRemark);
    }

    assetDoc.markModified('services');
    await assetDoc.save();

    const populated = await AssetItem.findById(assetDoc._id)
        .populate(
            'assignedTo',
            'firstName lastName employeeId companyEmail workEmail personalEmail email',
        )
        .lean();
    if (!populated) return true;

    const adminOfficer = await getDepartmentHOD('admincontroller');
    const management = await getDepartmentHOD('management');
    const plate = [populated.plateEmirate, populated.plateNumber].filter(Boolean).join(' ').trim();
    const detailParts = [];
    if (dueInfo.dateDue) {
        detailParts.push(`next oil service date is today (${formatOilDueDateLabel(dueInfo.nextDate)})`);
    }
    if (dueInfo.kmDue) {
        detailParts.push(
            `current odometer ${dueInfo.currentKm} km equals next oil change ${dueInfo.nextKm} km`,
        );
    }
    const detailLine = `Oil change is due for ${populated.assetId || ''}${plate ? ` (${plate})` : ''}. ${detailParts.join('; ')}. A pending oil service request was created automatically.`;

    await notifyStakeholders({
        asset: populated,
        serviceRecordId: serviceId,
        recipients: [adminOfficer, populated.assignedTo, management],
        actionLabel: 'Oil change due — service request created',
        detailLine,
    });

    try {
        const { notifyAdminOfficerOnVehicleServiceCreated } = await import(
            './vehicleServiceAdminOfficerNotification.js'
        );
        await notifyAdminOfficerOnVehicleServiceCreated({
            asset: populated,
            serviceRecordId: serviceId,
            serviceType: 'Oil Service',
            requestedByName: 'System',
            sendEmail: false,
        });
    } catch (notifyErr) {
        console.error('[OilService] Admin officer track notify on auto-create failed:', notifyErr);
    }

    return true;
}

/** Cron: auto-create pending oil service when next date == today or current km == next change km. */
export async function processOilServiceDueAutoCreate() {
    try {
        const items = await AssetItem.find({
            plateNumber: { $exists: true, $ne: '' },
            vehicleProfileActivationStatus: 'active',
        })
            .select(
                'assetId plateNumber plateEmirate services activeServiceWorkflow currentKilometer nextServiceDate assignedTo vehicleProfileActivationStatus typeId',
            )
            .populate('typeId', 'name')
            .limit(500);

        for (const row of items) {
            try {
                await maybeAutoCreateOilServiceDue(row);
            } catch (innerErr) {
                console.error(
                    '[processOilServiceDueAutoCreate] asset',
                    row?._id,
                    innerErr?.message || innerErr,
                );
            }
        }
    } catch (e) {
        console.error('[processOilServiceDueAutoCreate]', e);
    }
}

/**
 * Cron: notify admin officer + assignee when oil service end date has passed.
 */
export async function processOilServiceOverdue() {
    try {
        const items = await AssetItem.find({
            'activeServiceWorkflow.stage': STAGE_SCHEDULED,
            'activeServiceWorkflow.serviceTypeLabel': 'Oil Service',
            onServiceActive: true,
        })
            .select('assetId name plateNumber plateEmirate activeServiceWorkflow assignedTo onServiceActive')
            .populate('assignedTo', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
            .limit(500)
            .lean();

        const today = utcDayStart(new Date());
        const adminOfficer = await getDepartmentHOD('admincontroller');

        for (const row of items) {
            const wf = row.activeServiceWorkflow;
            if (!wf?.serviceWindowEndDate) continue;
            const end = utcDayStart(wf.serviceWindowEndDate);
            if (end == null || today <= end) continue;
            if (wf.oilServiceOverdueNotifiedAt) continue;

            const asset = await AssetItem.findById(row._id).populate(
                'assignedTo',
                'firstName lastName employeeId companyEmail workEmail personalEmail email',
            );
            if (!asset?.activeServiceWorkflow) continue;
            const serviceSub = asset.services?.id?.(asset.activeServiceWorkflow.serviceRecordId);
            if (String(serviceSub?.serviceType || '').trim() !== 'Oil Service') continue;
            asset.activeServiceWorkflow.oilServiceOverdueNotifiedAt = new Date();
            asset.markModified('activeServiceWorkflow');
            await asset.save();

            const serviceId = wf.serviceRecordId;
            const plate = [asset.plateEmirate, asset.plateNumber].filter(Boolean).join(' ').trim();
            const detailLine = `The oil service window for ${asset.assetId || ''}${plate ? ` (${plate})` : ''} has passed its end date. Please complete service details or extend the service period.`;

            await notifyStakeholders({
                asset: asset.toObject ? asset.toObject() : asset,
                serviceRecordId: serviceId,
                recipients: [adminOfficer, asset.assignedTo],
                actionLabel: 'Oil service duration overdue',
                detailLine,
            });
        }
    } catch (e) {
        console.error('[processOilServiceOverdue]', e);
    }
}
