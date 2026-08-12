import mongoose from 'mongoose';
import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import DashboardAction from '../models/DashboardAction.js';
import { isFleetVehicleProfileActive } from './assetApprovalHelpers.js';
import { getDepartmentHOD, isUserActiveInFlowchart } from './getDepartmentHOD.js';
import { syncDashboardAction } from './syncDashboard.js';
import {
    closeAdminOfficerServiceTrackNotification,
    notifyAdminOfficerOnVehicleServiceCreated,
} from './vehicleServiceAdminOfficerNotification.js';
import { sendVehicleServiceWorkflowEmail } from './sendVehicleServiceWorkflowEmail.js';
import { sendVehicleServiceScheduledNotificationEmail } from './sendVehicleServiceScheduledNotificationEmail.js';
import { sendVehicleServiceCompletedNotificationEmail } from './sendVehicleServiceCompletedNotificationEmail.js';
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
import { remarkHasGaragePayAccount } from './syncVehicleGarageServiceToZoho.js';

const STAGE_SCHEDULED = 'scheduled_service';
const STAGE_COMPLETE = 'complete';
const STAGE_PENDING_HR = 'pending_hr';
const STAGE_PENDING_ACCOUNTS = 'pending_accounts';
const STAGE_BILLED = 'billed';

const normEmpId = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');

/** Copy Service Details garage invoice (shopInvoice) into Zoho bill attachment remark fields. */
function seedGarageBillAttachmentFromShopInvoice(serviceRow) {
    if (!serviceRow) return false;
    const remark = parseOilServiceRemark(serviceRow);
    const shopKey = String(serviceRow.shopInvoice || remark.garageInvoiceUrl || '').trim();
    if (!shopKey) return false;
    if (String(remark.garageAttachmentUrl || remark.garageBillAttachmentUrl || '').trim()) {
        return false;
    }
    remark.garageAttachmentUrl = shopKey;
    remark.garageBillAttachmentUrl = shopKey;
    remark.garageAttachmentName =
        String(remark.garageAttachmentName || remark.garageInvoiceName || remark.shopInvoiceName || '').trim() ||
        'garage-invoice.pdf';
    serviceRow.remark = JSON.stringify(remark);
    return true;
}

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
    const stage = String(wf.stage || '').toLowerCase();
    if (
        stage === STAGE_COMPLETE ||
        stage === STAGE_PENDING_HR ||
        stage === STAGE_PENDING_ACCOUNTS ||
        stage === 'rejected'
    ) {
        return false;
    }
    if (wf.oilServiceLiveAt) return true;
    const remark = parseOilServiceRemark(service);
    if (remark?.oilServiceLiveAt) {
        // Live flag alone is not enough once payment approval stages start.
        if (
            String(remark.workflowStage || '').toLowerCase() === STAGE_PENDING_HR ||
            String(remark.workflowStage || '').toLowerCase() === STAGE_PENDING_ACCOUNTS ||
            String(remark.workflowStage || '').toLowerCase() === STAGE_COMPLETE
        ) {
            return false;
        }
        return true;
    }
    if (!ctx.bindActive) return false;
    return asset?.onServiceActive === true && String(wf.stage || '').toLowerCase() === STAGE_SCHEDULED;
}

export function isOilServiceWaitingForStartDate(asset, service = null) {
    const wf = asset?.activeServiceWorkflow || {};
    if (!isOilServiceWorkflowRecord(wf, service)) return false;
    if (String(wf.stage || '').toLowerCase() !== STAGE_SCHEDULED) return false;
    return !isOilServiceLive(asset, service);
}

export function oilServiceDetailsPath(vehicleId, serviceRecordId, { focus = '' } = {}) {
    if (!vehicleId || !serviceRecordId) return null;
    const base = `/HRM/Asset/Vehicle/details/${vehicleId}/oil-service/${serviceRecordId}`;
    const focusKey = String(focus || '').trim().toLowerCase();
    if (focusKey === 'payment' || focusKey === 'accounts_payment') {
        return `${base}?focus=payment`;
    }
    return base;
}

function oilServiceDashboardMeta(asset, serviceRecordId, oilStage = '') {
    const stage = String(oilStage || '').trim();
    const focus =
        stage.toLowerCase() === 'accounts_payment' || stage.toLowerCase() === 'accounts_quote'
            ? stage.toLowerCase() === 'accounts_payment'
                ? 'payment'
                : ''
            : '';
    const path = oilServiceDetailsPath(asset?._id, serviceRecordId, { focus });
    return JSON.stringify({
        vehicleId: asset?._id ? String(asset._id) : '',
        serviceRecordId: serviceRecordId ? String(serviceRecordId) : '',
        serviceType: 'Oil Service',
        detailsPath: path || '',
        ...(stage ? { oilStage: stage } : {}),
        ...(focus ? { focus } : {}),
    });
}

function parseOilDashboardMeta(extra3) {
    if (!extra3) return null;
    try {
        return typeof extra3 === 'object' ? extra3 : JSON.parse(String(extra3));
    } catch {
        return null;
    }
}

/**
 * Close pending Vehicle Service Request dashboard rows for a service
 * (optionally for one assignee / oilStage). Does not close Admin Officer track rows.
 */
async function closeOilServiceStageDashboardActions(
    assetId,
    serviceRecordId,
    { assignedTo = null, oilStage = null, comment = 'Step completed', actionedBy = null } = {},
) {
    if (!assetId || !serviceRecordId) return;
    const assetObjectId = assetId?._id || assetId;
    const targetServiceId = String(serviceRecordId);
    const query = {
        requestId: assetObjectId,
        requestType: 'Vehicle Service Request',
        status: 'Pending',
        ...(assignedTo ? { assignedTo } : {}),
    };
    const pendingRows = await DashboardAction.find(query).select('_id extra3').lean();
    const idsToClose = pendingRows
        .filter((row) => {
            const meta = parseOilDashboardMeta(row.extra3);
            if (!meta || meta.adminOfficerServiceTrack) return false;
            if (String(meta.serviceRecordId || '') !== targetServiceId) return false;
            if (oilStage && String(meta.oilStage || '') !== String(oilStage)) return false;
            return true;
        })
        .map((row) => row._id);
    if (!idsToClose.length) return;
    await DashboardAction.updateMany(
        { _id: { $in: idsToClose } },
        {
            status: 'Approved',
            actionedDate: new Date(),
            actionedBy: actionedBy || null,
            comment: comment || 'Step completed',
        },
    );
}

function parseOilServiceDashboardMeta(extra3) {
    if (!extra3) return null;
    try {
        return typeof extra3 === 'object' ? extra3 : JSON.parse(String(extra3));
    } catch {
        return null;
    }
}

/** Clear pending vehicle-service bell rows when an oil service is finished.
 * Skips Accounts Make Payment rows while cash billing is still open (pending_accounts).
 */
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

    let keepAccountsPaymentOpen = false;
    if (targetServiceId) {
        try {
            const assetDoc = await AssetItem.findById(assetObjectId)
                .select('services activeServiceWorkflow')
                .lean();
            const service = (assetDoc?.services || []).find((s) => String(s._id) === targetServiceId);
            if (service) {
                const remark = parseOilServiceRemark(service);
                const stage = String(
                    remark.workflowStage ||
                    (String(assetDoc?.activeServiceWorkflow?.serviceRecordId || '') === targetServiceId
                        ? assetDoc?.activeServiceWorkflow?.stage
                        : '') ||
                    service?.workflowSnapshot?.stage ||
                    '',
                ).toLowerCase();
                const billed =
                    stage === 'billed' ||
                    String(remark.billingStatus || '').toLowerCase() === 'billed' ||
                    Boolean(String(remark.zohoBillId || '').trim());
                keepAccountsPaymentOpen =
                    !billed &&
                    (stage === 'pending_accounts' ||
                        String(remark.billingStatus || '').toLowerCase() === 'pending');
            }
        } catch {
            keepAccountsPaymentOpen = false;
        }
    }

    const idsToClose = pendingRows
        .filter((row) => {
            const meta = parseOilServiceDashboardMeta(row.extra3);
            // Admin Officer create-track stays open until closeAdminOfficerServiceTrackNotification.
            if (meta?.adminOfficerServiceTrack) return false;
            if (!targetServiceId) return true;
            if (!meta?.serviceRecordId) return true;
            if (String(meta.serviceRecordId) !== targetServiceId) return false;
            if (
                keepAccountsPaymentOpen &&
                ['accounts_payment', 'accounts_quote'].includes(String(meta.oilStage || '').toLowerCase())
            ) {
                return false;
            }
            return true;
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
 * Important: Cash Complete Service sets vehicleServiceCompleted=live while stage is still
 * pending_accounts (Make Payment / Zoho). Do NOT close Accounts Make Payment bells until billed.
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

    const rows = await DashboardAction.find(rowQuery).select('_id requestId extra3 requestedByName extra1').lean();
    if (!rows.length) return;

    const idsToLoad = [...new Set(rows.map((row) => String(row.requestId || '')).filter(Boolean))];
    const assets = await AssetItem.find({ _id: { $in: idsToLoad } })
        .select('_id services activeServiceWorkflow')
        .lean();
    const assetMap = Object.fromEntries(assets.map((asset) => [String(asset._id), asset]));

    const isOilCashBillingStillOpen = (remark = {}, wf = {}, service = null, meta = {}) => {
        const oilStage = String(meta?.oilStage || '').toLowerCase();
        const remarkStage = String(remark.workflowStage || '').toLowerCase();
        const snapStage = String(service?.workflowSnapshot?.stage || '').toLowerCase();
        const wfStage =
            service && String(wf.serviceRecordId || '') === String(service._id || '')
                ? String(wf.stage || '').toLowerCase()
                : '';
        const stage = remarkStage || wfStage || snapStage;
        const billed =
            stage === 'billed' ||
            String(remark.billingStatus || '').toLowerCase() === 'billed' ||
            Boolean(String(remark.zohoBillId || '').trim());
        if (billed) return false;
        if (oilStage === 'accounts_payment' || oilStage === 'accounts_quote') return true;
        if (stage === 'pending_accounts') return true;
        if (
            String(remark.billingStatus || '').toLowerCase() === 'pending' &&
            isOilServiceCashPayment(remark)
        ) {
            return true;
        }
        return false;
    };

    const staleIds = [];
    for (const row of rows) {
        const asset = assetMap[String(row.requestId || '')];
        if (!asset) continue;

        const meta = parseOilServiceDashboardMeta(row.extra3);
        // Never heal-close Admin Officer create-track (stays until Billed / Zoho).
        if (meta?.adminOfficerServiceTrack) continue;

        const serviceRecordId = meta?.serviceRecordId ? String(meta.serviceRecordId) : '';
        const service = serviceRecordId
            ? (asset.services || []).find((s) => String(s._id) === serviceRecordId)
            : null;
        const wf = asset.activeServiceWorkflow || {};

        if (service) {
            const remark = parseOilServiceRemark(service);
            const serviceType = String(
                meta?.serviceType || service?.serviceType || remark?.serviceType || '',
            ).trim();
            const isOilService =
                serviceType === 'Oil Service' ||
                /\bOil Service\b/i.test(String(row.extra1 || '')) ||
                Boolean(meta?.oilStage);

            // Keep Accounts Zoho / Make Payment tasks until the bill is created (Oil cash only).
            if (isOilService && isOilCashBillingStillOpen(remark, wf, service, meta)) {
                continue;
            }
            // Only Oil Service uses vehicleServiceCompleted=live as "done" for heal.
            // Mechanical / Body / Car Wash / Tire also set live during billing — do not close them here.
            if (
                isOilService &&
                String(remark.vehicleServiceCompleted || '').toLowerCase() === 'live'
            ) {
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

        if (String(wf.stage || '').toLowerCase() === 'complete') {
            if (!serviceRecordId || String(wf.serviceRecordId || '') === serviceRecordId) {
                staleIds.push(row._id);
            }
        }
        // pending_accounts is still an open Accounts Make Payment step — never heal-close by stage alone.
        if (String(wf.stage || '').toLowerCase() === 'pending_accounts') {
            const oilStage = String(meta?.oilStage || '').toLowerCase();
            if (oilStage === 'accounts_payment' || oilStage === 'accounts_quote' || !oilStage) {
                // already handled above when service exists; if no service meta, keep row
                continue;
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

/** Cash payment (not warranty) — requires HR then Accounts → Zoho bill. */
export function isOilServiceCashPayment(remarkOrService) {
    if (!remarkOrService) return true;
    const remark =
        remarkOrService.remark != null || remarkOrService.serviceType != null
            ? parseOilServiceRemark(remarkOrService)
            : remarkOrService;
    return String(remark?.amountMode || '').toLowerCase() !== 'warranty';
}

/** Garage + dates required before Schedule is considered complete (tick / HR / Accounts). */
export function isOilScheduleFieldsComplete(remark = {}) {
    const garage = String(remark.garageName || remark.vendorName || '').trim();
    const location = String(remark.garageLocation || '').trim();
    const contact = String(remark.garageContact || '').trim();
    const start = String(remark.serviceStartDate || remark.scheduledServiceDate || '').trim();
    const end = String(remark.serviceEndDate || remark.nextChangeMonth || '').trim();
    return Boolean(garage && location && contact && start && end);
}

/** Admin Schedule OK submitted with all required garage/date fields. */
export function isOilScheduleStepComplete(remark = {}) {
    const submitted = String(remark.requestStatus || '').toLowerCase() === 'submitted';
    return submitted && isOilScheduleFieldsComplete(remark);
}

function assertOilScheduleStepComplete(remark, actionLabel = 'this step') {
    if (isOilScheduleStepComplete(remark)) return;
    const missing = [];
    if (String(remark.requestStatus || '').toLowerCase() !== 'submitted') {
        missing.push('Admin Schedule OK (submit)');
    }
    if (!String(remark.garageName || remark.vendorName || '').trim()) missing.push('Garage name');
    if (!String(remark.garageLocation || '').trim()) missing.push('Garage location');
    if (!String(remark.garageContact || '').trim()) missing.push('Garage contact');
    if (!String(remark.serviceStartDate || remark.scheduledServiceDate || '').trim()) {
        missing.push('Service start date');
    }
    if (!String(remark.serviceEndDate || remark.nextChangeMonth || '').trim()) {
        missing.push('Service end date');
    }
    throw new Error(
        `Admin must complete Schedule and Reschedule before ${actionLabel}. Still required: ${missing.join(', ')}.`,
    );
}

/**
 * After Initiate Service (Cash): open Schedule + HR together.
 * Bootstraps pending_hr workflow and emails/dashboard-tasks Admin Officer + HR.
 */
export async function bootstrapOilCashAfterInitiate(asset, serviceId, { byName = 'User' } = {}) {
    const service = asset.services?.id?.(serviceId);
    if (!service || String(service.serviceType || '').trim() !== 'Oil Service') return null;

    const remark = parseOilServiceRemark(service);
    if (!isOilServiceCashPayment(remark)) return null;
    if (!String(remark.oilServiceInitiatedAt || '').trim()) return null;
    if (String(remark.hrScheduleApprovedAt || '').trim()) return null;

    const existingWf = asset.activeServiceWorkflow;
    const alreadyBootstrapped =
        existingWf &&
        String(existingWf.serviceRecordId) === String(service._id) &&
        ['pending_hr', 'scheduled_service', 'pending_accounts', 'billed', 'complete'].includes(
            String(existingWf.stage || '').toLowerCase(),
        );
    if (alreadyBootstrapped && String(existingWf.stage || '').toLowerCase() !== 'pending_hr') {
        return null;
    }

    remark.workflowStage = STAGE_PENDING_HR;
    remark.oilScheduleHrOpenedAt = remark.oilScheduleHrOpenedAt || new Date().toISOString();
    service.remark = JSON.stringify(remark);

    if (!alreadyBootstrapped) {
        const previousStatus = asset.status;
        asset.activeServiceWorkflow = {
            serviceRecordId: service._id,
            stage: STAGE_PENDING_HR,
            previousStatus,
            serviceTypeLabel: 'Oil Service',
            scheduledServiceDate: null,
            serviceWindowEndDate: null,
            serviceDurationEmailSentAt: null,
            oilServiceOverdueNotifiedAt: null,
            oilServiceCompleteDueNotifiedAt: null,
            oilServiceLiveAt: null,
            oilScheduleHrNotifiedAt: new Date(),
            history: [],
        };
        recordOilServiceActivity(asset, service, service._id, {
            type: 'service_updated',
            byName,
            note: 'Oil service initiated — Schedule and HR Approval open together',
        });
    } else if (!existingWf.oilScheduleHrNotifiedAt) {
        asset.activeServiceWorkflow.oilScheduleHrNotifiedAt = new Date();
    }

    persistWorkflowSnapshot(asset);
    asset.markModified('services');
    asset.markModified('activeServiceWorkflow');
    await asset.save();

    if (alreadyBootstrapped && existingWf?.oilScheduleHrNotifiedAt) {
        return asset;
    }

    const populated = await AssetItem.findById(asset._id)
        .populate('assignedTo', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
        .lean();
    const hr = await getDepartmentHOD('hr');
    const adminOfficer = await getDepartmentHOD('admincontroller');
    if (!hr?._id) {
        console.warn('[OilService] No HR flowchart assignee — skipping Schedule/HR open notify.');
        return populated;
    }

    const plate = [populated?.plateEmirate, populated?.plateNumber].filter(Boolean).join(' ').trim();
    const detailLine = `${byName} initiated an oil service for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''
        }. Schedule/Reschedule (Admin) and HR Approval are open together — Admin may change dates anytime; HR approves once.`;

    await notifyStakeholders({
        asset: populated,
        serviceRecordId: service._id,
        recipients: [adminOfficer, hr].filter(Boolean),
        actionLabel: 'Oil service — Schedule & HR Approval',
        detailLine,
        oilStage: 'schedule_hr_open',
    });

    return populated;
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

export async function userIsOilServiceAccounts(reqUser) {
    return userMatchesFlowchartRole(reqUser, 'accounts');
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

/** Schedule / Reschedule — Admin / Admin Officer / Asset Controller / super user (not HR/Accounts alone). */
export async function actorMayAdminScheduleShopService(reqUser) {
    if (await isReqUserSystemSuperUser(reqUser)) return true;
    // Admin Officer (admincontroller), Admin, Administrator, Admin Officer label, Asset Controller
    if (await userIsOilServiceAdminOfficer(reqUser)) return true;
    if (await userMatchesFlowchartRole(reqUser, 'admin')) return true;
    if (await userMatchesFlowchartRole(reqUser, 'administrator')) return true;
    if (await userMatchesFlowchartRole(reqUser, 'adminofficer')) return true;
    if (await userIsOilServiceAssetController(reqUser)) return true;
    return false;
}

export async function userMayEditOilServiceDates(reqUser, asset, serviceId) {
    if (await isReqUserSystemSuperUser(reqUser)) return true;
    if (!asset || !serviceId) return false;

    const service = asset.services?.id?.(serviceId);
    if (!service) return false;

    const remark = parseOilServiceRemark(service);
    const reqStatus = String(remark.requestStatus || '').toLowerCase();
    const initiated =
        reqStatus === 'submitted' || Boolean(String(remark.oilServiceInitiatedAt || '').trim());
    if (!initiated) return false;
    if (!['draft', 'pending', 'submitted'].includes(reqStatus)) return false;

    const { wf } = getWorkflowContextForService(asset, serviceId);
    // Warranty / pre-bootstrap: Admin may save garage+dates onto remark before submit-request.
    if (!wf || !isOilServiceWorkflowRecord(wf, service)) {
        return (
            ['draft', 'pending'].includes(reqStatus) &&
            (await actorMayAdminScheduleShopService(reqUser))
        );
    }

    const stage = String(wf.stage || '').toLowerCase();
    // Admin Officer may schedule/reschedule anytime until Complete Service / billed.
    if (
        stage === STAGE_COMPLETE ||
        stage === STAGE_PENDING_ACCOUNTS ||
        stage === STAGE_BILLED ||
        stage === 'rejected'
    ) {
        return false;
    }
    if (stage !== STAGE_SCHEDULED && stage !== STAGE_PENDING_HR) return false;

    // Same roles as shop Schedule: Admin / Admin Officer / Asset Controller / super user
    if (await actorMayAdminScheduleShopService(reqUser)) return true;

    if (
        reqStatus === 'submitted' &&
        stage === STAGE_SCHEDULED &&
        isOilServiceWaitingForStartDate(asset, service)
    ) {
        return actorMayManageOilService(reqUser, asset);
    }

    return false;
}

/**
 * Accounts may approve the cash quote after HR has approved the schedule.
 * Records approval only — Zoho bill still happens later from Make Payment.
 */
export async function userMayApproveOilAccountsQuote(reqUser, asset, serviceId) {
    if (await isReqUserSystemSuperUser(reqUser)) return true;
    if (!asset || !serviceId) return false;

    const service = asset.services?.id?.(serviceId);
    if (!service) return false;
    const { wf } = getWorkflowContextForService(asset, serviceId);
    if (!wf) return false;
    if (!isOilServiceWorkflowRecord(wf, service)) return false;
    if (!isOilServiceCashPayment(service)) return false;

    const stage = String(wf.stage || '').toLowerCase();
    // After HR, stage is scheduled_service. Also allow while still pending_hr if HR already stamped.
    const remark = parseOilServiceRemark(service);
    const hrDone = Boolean(String(remark.hrScheduleApprovedAt || remark.hrPaymentApprovedAt || '').trim());
    if (stage === STAGE_PENDING_HR && !hrDone) return false;
    if (stage !== STAGE_SCHEDULED && stage !== STAGE_PENDING_HR) return false;
    if (String(remark.accountsQuoteApprovedAt || '').trim()) return false;

    return userIsOilServiceAccounts(reqUser);
}

/** Accounts quote approval — records approval only, does not create Zoho bill.
 * Optional paymentPatch: { amountMode, paymentMethod, description } — Accounts may edit before approve.
 */
export async function approveOilAccountsQuote(asset, serviceId, reqUser, paymentPatch = {}) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    const { wf, bindActive } = getWorkflowContextForService(asset, serviceId);
    if (!wf) throw new Error('No active oil service workflow.');

    const remark = parseOilServiceRemark(service);
    // Must still be cash when Accounts opens this step (initiated as cash / HR path).
    if (!isOilServiceCashPayment(remark)) {
        throw new Error('Accounts quote approval only applies to cash oil services.');
    }

    const stage = String(wf.stage || '').toLowerCase();
    const hrDone = Boolean(String(remark.hrScheduleApprovedAt || remark.hrPaymentApprovedAt || '').trim());
    if (stage === STAGE_PENDING_HR && !hrDone) {
        throw new Error('Accounts approval is available after HR Approval.');
    }
    if (stage !== STAGE_SCHEDULED && !(stage === STAGE_PENDING_HR && hrDone)) {
        if (stage !== STAGE_SCHEDULED) {
            throw new Error('Accounts approval is only available after HR has approved the schedule.');
        }
    }
    if (String(remark.accountsQuoteApprovedAt || '').trim()) {
        throw new Error('Accounts has already approved this quotation.');
    }
    // Accounts follows HR only — Schedule remains parallel (Admin can finish anytime before Complete).

    // Accounts may edit payment type + method on approve.
    const rawType = String(paymentPatch?.amountMode || '').toLowerCase().trim();
    const nextType =
        rawType === 'warranty'
            ? 'warranty'
            : rawType === 'amount' || rawType === 'cash'
                ? 'amount'
                : '';
    if (nextType) {
        remark.amountMode = nextType;
    }
    if (String(remark.amountMode || '').toLowerCase() === 'warranty') {
        delete remark.paymentMethod;
    } else {
        const rawMethod = String(paymentPatch?.paymentMethod || remark.paymentMethod || '')
            .toLowerCase()
            .trim();
        const nextMethod =
            rawMethod === 'acc_pay' || rawMethod === 'accpay' || rawMethod === 'account_pay'
                ? 'acc_pay'
                : rawMethod === 'bank_transfer' ||
                    rawMethod === 'banktransfer' ||
                    rawMethod === 'bank transfer'
                    ? 'bank_transfer'
                    : rawMethod === 'cash' || rawMethod === 'amount'
                        ? 'cash'
                        : '';
        if (nextMethod) {
            remark.paymentMethod = nextMethod;
        } else if (!String(remark.paymentMethod || '').trim()) {
            remark.paymentMethod = 'cash';
        }
        if (!nextType && !String(remark.amountMode || '').trim()) {
            remark.amountMode = 'amount';
        }
    }

    const accountsDescription = String(paymentPatch?.description || '').trim();
    if (accountsDescription) {
        remark.accountsReviewDescription = accountsDescription;
    } else {
        delete remark.accountsReviewDescription;
    }

    const switchedToWarranty = String(remark.amountMode || '').toLowerCase() === 'warranty';
    const actorName = await getRequesterName(reqUser);
    remark.accountsQuoteApprovedAt = new Date().toISOString();
    remark.accountsQuoteApprovedByName = actorName;
    // Ensure we are on scheduled_service after both approvals.
    if (stage === STAGE_PENDING_HR || switchedToWarranty) {
        wf.stage = STAGE_SCHEDULED;
        remark.workflowStage = STAGE_SCHEDULED;
    }
    service.remark = JSON.stringify(remark);

    recordOilServiceActivity(asset, service, serviceId, {
        type: 'accounts_quote_approved',
        byName: actorName,
        note: switchedToWarranty
            ? 'Accounts approved — payment type set to Warranty'
            : `Accounts approved quotation (${remark.paymentMethod || 'cash'}) — Ready to Service / On Service on start date`,
        meta: {
            amountMode: remark.amountMode || '',
            paymentMethod: remark.paymentMethod || '',
            ...(accountsDescription ? { description: accountsDescription } : {}),
        },
    });

    // Lock oil change / next service dates on the vehicle from the approved schedule.
    applyOilChangeDatesFromSchedule(asset, remark);

    commitWorkflowContext(asset, serviceId, { wf, bindActive });
    asset.markModified('services');
    await asset.save();

    const accounts = await getDepartmentHOD('accounts');
    await closeOilServiceStageDashboardActions(asset._id, serviceId, {
        assignedTo: accounts?._id || null,
        oilStage: 'accounts_quote',
        comment: 'Accounts approved quotation',
        actionedBy: reqUser?.employeeObjectId || reqUser?._id || null,
    });

    // After Accounts Approve, go On Service immediately when start date is today/past.
    const startD = resolveServiceStartDate(remark) || wf.scheduledServiceDate;
    const today = utcDayStart(new Date());
    const startUtc = utcDayStart(startD);
    let wentLive = false;
    if (startUtc != null && today != null && today >= startUtc) {
        const fresh = await AssetItem.findById(asset._id);
        if (fresh) {
            wentLive = await activateOilServiceOnStartDate(fresh, {
                byName: actorName || 'System',
                force: true,
                notify: true,
            });
            asset.activeServiceWorkflow = fresh.activeServiceWorkflow;
            asset.onServiceActive = fresh.onServiceActive;
            asset.status = fresh.status;
            asset.services = fresh.services;
        }
    }

    const populatedForMail = await AssetItem.findById(asset._id)
        .populate({
            path: 'assignedTo',
            select: `${OIL_EMP_EMAIL_SELECT} company`,
            populate: { path: 'company', select: 'name' },
        })
        .lean();
    const plate = [populatedForMail?.plateEmirate, populatedForMail?.plateNumber]
        .filter(Boolean)
        .join(' ')
        .trim();
    const startLabel = startD ? new Date(startD).toISOString().slice(0, 10) : '';

    // Formal "Vehicle Service Scheduled Notification" is sent when Admin completes
    // Schedule/Reschedule — not after Accounts approval.

    // If start date is in the future, Admin dashboard only: Ready to Service (awaits start date).
    if (!wentLive) {
        const adminOfficer = await getDepartmentHOD('admincontroller');
        if (adminOfficer?._id && populatedForMail) {
            await notifyStakeholders({
                asset: populatedForMail,
                serviceRecordId: serviceId,
                recipients: [adminOfficer],
                actionLabel: 'Oil service — Ready to Service',
                detailLine: `Accounts approved quotation for ${populatedForMail?.assetId || ''}${plate ? ` (${plate})` : ''}. Status is Ready to Service until ${startLabel}, then On Service. Full service details below.`,
                detailRows: buildOilScheduleEmailDetailRows(remark),
                oilStage: 'ready_to_service',
            });
        }
    }

    return asset;
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

const OIL_EMP_EMAIL_SELECT =
    'firstName lastName employeeId companyEmail workEmail personalEmail email';

/** Vehicle “Car driven by” from oil service remark. */
async function resolveOilDrivenByEmployee(remark = {}) {
    const raw = String(remark?.carDrivenByEmployeeId || '').trim();
    if (!raw) return null;
    if (mongoose.Types.ObjectId.isValid(raw)) {
        return EmployeeBasic.findById(raw).select(OIL_EMP_EMAIL_SELECT).lean();
    }
    return EmployeeBasic.findOne({ employeeId: raw }).select(OIL_EMP_EMAIL_SELECT).lean();
}

/** Vehicle owner from oil service remark (Vehicle assigned / owner field). */
async function resolveOilVehicleOwnerEmployee(remark = {}) {
    const raw = String(remark?.vehicleOwnerEmployeeId || '').trim();
    if (!raw) return null;
    if (mongoose.Types.ObjectId.isValid(raw)) {
        return EmployeeBasic.findById(raw).select(OIL_EMP_EMAIL_SELECT).lean();
    }
    return EmployeeBasic.findOne({ employeeId: raw }).select(OIL_EMP_EMAIL_SELECT).lean();
}

/** Detail rows for post–Complete Service owner/assignee email. */
function buildOilCompletedEmailDetailRows(asset = {}, remark = {}) {
    const fmtKm = (value) => {
        if (value == null || value === '') return '';
        const n = Number(value);
        if (!Number.isFinite(n)) return String(value);
        return `${n.toLocaleString()} KM`;
    };
    const start =
        String(remark.serviceStartDate || remark.scheduledServiceDate || '').trim().slice(0, 10) ||
        formatOilDueDateLabel(resolveServiceStartDate(remark));
    const end =
        String(remark.serviceEndDate || '').trim().slice(0, 10) ||
        formatOilDueDateLabel(resolveServiceEndDate(remark));
    const nextDate =
        String(remark.nextServiceDate || '').trim().slice(0, 10) ||
        String(remark.nextChangeMonth || '').trim() ||
        formatOilDueDateLabel(asset.nextServiceDate);
    const handOver = String(remark.handOverDate || '').trim().slice(0, 10);
    const returnDate = String(remark.returnDate || '').trim().slice(0, 10);
    const garage = String(remark.garageName || remark.vendorName || '').trim();
    const location = String(remark.garageLocation || '').trim();
    const contact = String(remark.garageContact || '').trim();
    const description = String(
        remark.serviceIssue || remark.accountsReviewDescription || remark.description || '',
    ).trim();

    const rows = [
        { label: 'Service status', value: 'Oil service completed' },
        { label: 'Current KM', value: fmtKm(asset.currentKilometer) },
        {
            label: 'KM note',
            value: 'If the current kilometer reading is not correct, please update it on the vehicle profile in VeRP.',
        },
        { label: 'Next oil service KM', value: fmtKm(remark.nextChangeKm) },
        { label: 'Next oil change date', value: nextDate },
        { label: 'Service start date', value: start },
        { label: 'Service end date', value: end },
        { label: 'Hand over date', value: handOver },
        { label: 'Return date', value: returnDate },
        { label: 'Garage', value: garage },
        { label: 'Garage location', value: location },
        { label: 'Garage contact', value: contact },
        { label: 'Description', value: description },
    ];
    return rows.filter((row) => String(row.value || '').trim());
}

/**
 * After Complete Service — email vehicle owner + assigned user with next oil change details.
 * Email only (no dashboard task).
 */
async function notifyOilServiceCompletedOwnerAndAssignee({
    asset,
    serviceRecordId,
    remark = {},
}) {
    const populated = await AssetItem.findById(asset._id || asset)
        .select(
            'assetId name plateEmirate plateNumber currentKilometer nextServiceDate oilChangeDate assignedTo',
        )
        .populate('assignedTo', OIL_EMP_EMAIL_SELECT)
        .lean();
    if (!populated) return;

    const [owner, assigneeResolved] = await Promise.all([
        resolveOilVehicleOwnerEmployee(remark),
        (async () => {
            let assignee = populated.assignedTo || null;
            if (assignee && (!assignee.firstName || !resolveEmployeeEmail(assignee).email)) {
                const id = assignee._id || assignee;
                if (id && mongoose.Types.ObjectId.isValid(String(id))) {
                    assignee = await EmployeeBasic.findById(id).select(OIL_EMP_EMAIL_SELECT).lean();
                }
            }
            return assignee;
        })(),
    ]);

    const recipients = uniqRecipients([assigneeResolved, owner]);
    if (!recipients.length) {
        console.warn('[OilService] No owner/assignee email for completion notice.');
        return;
    }

    const plate = [populated.plateEmirate, populated.plateNumber].filter(Boolean).join(' ').trim();
    const detailRows = buildOilCompletedEmailDetailRows(populated, remark);
    const linkPath = oilServiceDetailsPath(populated._id, serviceRecordId);
    const detailLine = `Oil service for ${populated.assetId || 'your vehicle'}${plate ? ` (${plate})` : ''} is complete. Next oil change details are below — if the current KM is not correct, please update it.`;

    for (const recipient of recipients) {
        await sendOilEmail({
            recipient,
            asset: populated,
            actionLabel: 'Oil service completed — next oil change',
            detailLine,
            detailRows,
            serviceRecordId,
            linkPath,
        });
    }
    console.log(
        `[OilService] Completion mail (owner/assignee) -> ${recipients
            .map((r) => `${r.firstName || ''} ${r.lastName || ''}`.trim() || r.employeeId)
            .join(', ')}`,
    );
}

/**
 * Sync vehicle oilChangeDate / lastServiceDate / nextServiceDate from the oil schedule.
 * Start → oil change / last service; end / nextChangeMonth → next service due.
 */
function applyOilChangeDatesFromSchedule(asset, remark = {}) {
    if (!asset) return false;
    let changed = false;
    const start = resolveServiceStartDate(remark);
    if (start && !Number.isNaN(start.getTime())) {
        asset.oilChangeDate = start;
        asset.lastServiceDate = start;
        changed = true;
    }
    const next = resolveNextOilServiceDateFromRemark(remark, asset);
    if (next && !Number.isNaN(next.getTime())) {
        asset.nextServiceDate = next;
        changed = true;
    }
    return changed;
}

/** Admin / HR / assigned user / vehicle driven by — email recipients for schedule updates. */
async function resolveOilScheduleMailRecipients(assetDoc, remark = {}) {
    const [adminOfficer, hr, driver] = await Promise.all([
        getDepartmentHOD('admincontroller'),
        getDepartmentHOD('hr'),
        resolveOilDrivenByEmployee(remark),
    ]);

    let assignee = assetDoc?.assignedTo || null;
    if (assignee && (!assignee.firstName || !resolveEmployeeEmail(assignee).email)) {
        const assigneeId = assignee._id || assignee;
        if (assigneeId && mongoose.Types.ObjectId.isValid(String(assigneeId))) {
            assignee = await EmployeeBasic.findById(assigneeId).select(OIL_EMP_EMAIL_SELECT).lean();
        }
    }

    return uniqRecipients([adminOfficer, hr, assignee, driver]);
}

/**
 * Email-only schedule update to Admin Officer, HR, assigned user, and vehicle driven by.
 * (No new dashboard tasks — avoids inbox spam on every reschedule.)
 */
async function notifyOilScheduleStakeholders({
    asset,
    serviceRecordId,
    remark = {},
    actionLabel,
    detailLine,
    detailRows = null,
}) {
    const populated =
        asset?.assignedTo && (asset.assignedTo.firstName || asset.assignedTo.companyEmail)
            ? asset
            : await AssetItem.findById(asset._id || asset)
                .populate('assignedTo', OIL_EMP_EMAIL_SELECT)
                .lean();
    if (!populated) return;

    const recipients = await resolveOilScheduleMailRecipients(populated, remark);
    if (!recipients.length) return;

    const rows = Array.isArray(detailRows) ? detailRows : buildOilScheduleEmailDetailRows(remark);
    const linkPath = oilServiceDetailsPath(populated._id, serviceRecordId);
    for (const recipient of recipients) {
        await sendOilEmail({
            recipient,
            asset: populated,
            actionLabel,
            detailLine,
            detailRows: rows,
            serviceRecordId,
            linkPath,
        });
    }
    console.log(
        `[OilService] Schedule mail (${actionLabel}) -> ${recipients
            .map((r) => `${r.firstName || ''} ${r.lastName || ''}`.trim() || r.employeeId)
            .join(', ')}`,
    );
}

/** Full schedule details for oil service emails (garage, location, contact, dates, description). */
function buildOilScheduleEmailDetailRows(remark = {}) {
    const start =
        String(remark.serviceStartDate || remark.scheduledServiceDate || '').trim().slice(0, 10) ||
        formatOilDueDateLabel(resolveServiceStartDate(remark));
    const end =
        String(remark.serviceEndDate || '').trim().slice(0, 10) ||
        formatOilDueDateLabel(resolveServiceEndDate(remark));
    const next =
        String(remark.nextChangeMonth || '').trim() ||
        formatOilDueDateLabel(resolveNextOilServiceDateFromRemark(remark, null));
    const garage = String(remark.garageName || remark.vendorName || '').trim();
    const location = String(remark.garageLocation || '').trim();
    const contact = String(remark.garageContact || '').trim();
    const description = String(
        remark.serviceIssue ||
        remark.accountsReviewDescription ||
        remark.description ||
        remark.notes ||
        '',
    ).trim();
    const paymentType = String(remark.amountMode || '').toLowerCase();
    const paymentMethod = String(remark.paymentMethod || '').trim();

    const rows = [];
    rows.push({ label: 'Status', value: 'Your vehicle is scheduled for oil service (garage)' });
    if (start) rows.push({ label: 'Service start date', value: start });
    if (end) rows.push({ label: 'Service end date', value: end });
    if (next) rows.push({ label: 'Next oil change', value: next });
    if (garage) rows.push({ label: 'Garage', value: garage });
    if (location) rows.push({ label: 'Garage location', value: location });
    if (contact) rows.push({ label: 'Garage contact', value: contact });
    if (paymentType === 'warranty') {
        rows.push({ label: 'Payment', value: 'Warranty' });
    } else if (paymentType || paymentMethod) {
        rows.push({
            label: 'Payment',
            value: [paymentType === 'amount' ? 'Cash' : paymentType, paymentMethod]
                .filter(Boolean)
                .join(' · '),
        });
    }
    if (description) rows.push({ label: 'Description', value: description });
    return rows;
}

/** Resolve VSR No from asset.services for email subject/body. */
function resolveOilServiceReqNo(asset, serviceRecordId) {
    if (!asset || !serviceRecordId) return '';
    const services = Array.isArray(asset.services) ? asset.services : [];
    const service =
        (typeof asset.services?.id === 'function' ? asset.services.id(serviceRecordId) : null) ||
        services.find((s) => String(s?._id) === String(serviceRecordId)) ||
        null;
    const stored = String(service?.serviceReqNo || '').trim();
    if (stored) return stored;

    const assetId = String(asset.assetId || '').trim();
    if (assetId && service?._id && services.length) {
        const idx = services.findIndex((s) => String(s?._id) === String(service._id));
        if (idx >= 0) return `${assetId}-${String(idx + 1).padStart(3, '0')}`;
    }
    return '';
}

async function sendOilEmail({
    recipient,
    asset,
    actionLabel,
    detailLine,
    detailRows = [],
    serviceRecordId = '',
    serviceReqNo = '',
    linkPath,
    cc = [],
}) {
    const who = `${recipient?.firstName || ''} ${recipient?.lastName || ''}`.trim() || recipient?.employeeId || 'Unknown';
    const { email } = resolveEmployeeEmail(recipient || {});
    console.log(`[OilService][Email] ${actionLabel} -> ${who} <${email || 'no-email'}>`);
    if (!email) return;

    let vsr = String(serviceReqNo || '').trim() || resolveOilServiceReqNo(asset, serviceRecordId);
    // Lean/populated assets often omit services — fetch VSR when needed.
    if (!vsr && serviceRecordId && asset?._id) {
        try {
            const slim = await AssetItem.findById(asset._id)
                .select('assetId services._id services.serviceReqNo')
                .lean();
            vsr = resolveOilServiceReqNo(slim, serviceRecordId);
        } catch {
            /* keep empty */
        }
    }
    const rows = Array.isArray(detailRows) ? [...detailRows] : [];
    if (vsr && !rows.some((r) => /^vsr(\s*no\.?)?$/i.test(String(r?.label || '')))) {
        rows.unshift({ label: 'VSR No', value: vsr });
    }

    await sendVehicleServiceWorkflowEmail({
        recipient,
        asset,
        stageLabel: 'Oil service',
        actionLabel,
        detailLine,
        detailRows: rows,
        serviceReqNo: vsr,
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
            serviceRecordId,
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

async function notifyStakeholders({
    asset,
    serviceRecordId,
    recipients,
    actionLabel,
    detailLine,
    detailRows = [],
    oilStage = '',
}) {
    const linkPath = oilServiceDetailsPath(asset._id, serviceRecordId);
    const list = uniqRecipients(recipients);
    for (const recipient of list) {
        await sendOilEmail({
            recipient,
            asset,
            actionLabel,
            detailLine,
            detailRows,
            serviceRecordId,
            linkPath,
        });
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
                extra3: oilServiceDashboardMeta(asset, serviceRecordId, oilStage),
            });
        }
    }
}

/**
 * Admin Officer dashboard/task when oil goes On Service.
 * Assignees already get the formal "Vehicle Service Scheduled Notification" on Accounts Approve
 * (cash) or Admin schedule (warranty) — do not send the short On Service letter to them again.
 */
async function notifyOilServiceWentLiveIfNeeded(asset, serviceRecordId, { detailLine } = {}) {
    const wf = asset?.activeServiceWorkflow;
    if (!wf || wf.oilServiceLiveNotifiedAt) return false;

    const populated = await AssetItem.findById(asset._id)
        .populate('assignedTo', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
        .select(
            'assetId name plateEmirate plateNumber assignedTo services._id services.serviceReqNo services.serviceType services.remark',
        )
        .lean();
    if (!populated) return false;

    const adminOfficer = await getDepartmentHOD('admincontroller');
    const plate = [populated?.plateEmirate, populated?.plateNumber].filter(Boolean).join(' ').trim();
    const message =
        detailLine ||
        `Oil service for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''} has started today. The vehicle is now On Service — complete the service when ready.`;

    const service =
        (Array.isArray(populated.services) &&
            populated.services.find((s) => String(s._id) === String(serviceRecordId))) ||
        null;
    const remark = parseOilServiceRemark(service);
    const scheduleRows = buildOilScheduleEmailDetailRows(remark);

    if (adminOfficer?._id) {
        await closeOilServiceStageDashboardActions(asset._id, serviceRecordId, {
            assignedTo: adminOfficer._id,
            oilStage: 'ready_to_service',
            comment: 'Service started — On Service',
        });
        await notifyStakeholders({
            asset: populated,
            serviceRecordId,
            recipients: [adminOfficer],
            actionLabel: 'Oil service — On Service',
            detailLine: message,
            detailRows: scheduleRows,
            oilStage: 'on_service',
        });
    }

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
    const looksLikeObjectId = (value) => /^[a-fA-F0-9]{24}$/.test(String(value || '').trim());
    if (reqUser.employeeObjectId) {
        const emp = await EmployeeBasic.findById(reqUser.employeeObjectId)
            .select('firstName lastName')
            .lean();
        if (emp) {
            const n = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();
            if (n) return n;
        }
    }
    const rawName = (reqUser.name && String(reqUser.name).trim()) || '';
    if (rawName && !looksLikeObjectId(rawName)) return rawName;
    return 'User';
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
        schedule_submitted: STAGE_SCHEDULED,
        schedule_resubmitted: STAGE_SCHEDULED,
        initiate_edited: 'pending',
        service_completed: STAGE_SCHEDULED,
        hr_approved: STAGE_PENDING_HR,
        accounts_approved: STAGE_PENDING_ACCOUNTS,
        zoho_bill_created: STAGE_PENDING_ACCOUNTS,
    };
    const actionByType = {
        service_created: 'created',
        service_updated: 'updated',
        service_scheduled: 'scheduled',
        on_service: 'on_service',
        date_change: 'date_change',
        schedule_submitted: 'schedule_submitted',
        schedule_resubmitted: 'schedule_resubmitted',
        initiate_edited: 'initiate_edited',
        service_completed: 'completed',
        hr_approved: 'approve',
        accounts_approved: 'approve',
        zoho_bill_created: 'approve',
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
        oilServiceLiveAt: wf.oilServiceLiveAt || null,
    };
}

/** Prefer YYYY-MM-DD calendar keys to avoid UTC/local off-by-one on date-only fields. */
function toDateKey(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
    }
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}

function utcDayStart(value) {
    const key = toDateKey(value);
    if (!key) {
        const d = value ? new Date(value) : new Date();
        if (Number.isNaN(d.getTime())) return null;
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }
    const [y, m, day] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, day);
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
    // Only skip when this oil row is already live — do not use onServiceActive alone
    // (stale flag blocks submit save when start date is today).
    if (wf.oilServiceLiveAt) return false;

    const service = asset.services?.id?.(wf.serviceRecordId);
    if (!service) return false;

    const remark = parseOilServiceRemark(service);
    if (remark?.oilServiceLiveAt) return false;

    // Cash: Accounts must approve quotation before Ready/On Service.
    if (isOilServiceCashPayment(remark) && !String(remark.accountsQuoteApprovedAt || '').trim()) {
        return false;
    }
    // Never go Ready/On Service if Admin skipped garage/date fields.
    if (!isOilScheduleFieldsComplete(remark)) {
        return false;
    }

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
 * Submit oil service assignment (Schedule at least once).
 * Cash: dates stored; Schedule + HR already open from initiate (do not re-notify HR).
 * Warranty: scheduled_service (then On Service on start date).
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
    if (!isOilScheduleFieldsComplete(remark)) {
        assertOilScheduleStepComplete(
            { ...remark, requestStatus: 'submitted' },
            'submitting the schedule',
        );
    }

    const requesterName = await getRequesterName(req.user);
    const previousStatus = asset.status;
    const isCash = isOilServiceCashPayment(remark);
    const hrAlreadyApproved = Boolean(
        String(remark.hrScheduleApprovedAt || remark.hrPaymentApprovedAt || '').trim(),
    );
    const priorWf = asset.activeServiceWorkflow;
    const sameServiceWf =
        priorWf?.serviceRecordId && String(priorWf.serviceRecordId) === String(service._id);
    const scheduleHrAlreadyOpen =
        isCash &&
        sameServiceWf &&
        (Boolean(priorWf.oilScheduleHrNotifiedAt) ||
            String(priorWf.stage || '').toLowerCase() === STAGE_PENDING_HR ||
            Boolean(String(remark.oilScheduleHrOpenedAt || '').trim()));

    remark.requestStatus = 'submitted';
    remark.assignmentSubmittedAt = new Date().toISOString();
    remark.oilServiceScheduledAt = remark.assignmentSubmittedAt;
    remark.requestedByName = requesterName;
    {
        const { applyScheduleSubmitStatus } = await import('./vehicleServiceScheduleSubmitStatus.js');
        applyScheduleSubmitStatus(remark, {
            alreadySubmitted: false,
            actorName: requesterName,
        });
    }
    if (isCash) {
        remark.workflowStage = hrAlreadyApproved ? STAGE_SCHEDULED : STAGE_PENDING_HR;
    } else {
        remark.workflowStage = STAGE_SCHEDULED;
    }
    service.remark = JSON.stringify(remark);
    appendOilServiceActivity(service, {
        type: 'schedule_submitted',
        byName: requesterName,
        note: `Schedule submitted · Service window: ${String(startD).slice(0, 10)} – ${String(endD).slice(0, 10)}`,
    });

    if (priorWf?.serviceRecordId && String(priorWf.serviceRecordId) !== String(service._id)) {
        persistWorkflowSnapshot(asset);
    }

    const nextStage = isCash
        ? hrAlreadyApproved
            ? STAGE_SCHEDULED
            : STAGE_PENDING_HR
        : STAGE_SCHEDULED;
    const priorPlain = sameServiceWf
        ? typeof priorWf.toObject === 'function'
            ? priorWf.toObject()
            : { ...priorWf }
        : {};

    asset.activeServiceWorkflow = {
        ...priorPlain,
        serviceRecordId: service._id,
        stage: nextStage,
        previousStatus: sameServiceWf ? priorWf.previousStatus || previousStatus : previousStatus,
        serviceTypeLabel: 'Oil Service',
        scheduledServiceDate: startD,
        serviceWindowEndDate: endD,
        serviceDurationEmailSentAt: sameServiceWf ? priorWf.serviceDurationEmailSentAt || null : null,
        oilServiceOverdueNotifiedAt: sameServiceWf ? priorWf.oilServiceOverdueNotifiedAt || null : null,
        oilServiceCompleteDueNotifiedAt: sameServiceWf
            ? priorWf.oilServiceCompleteDueNotifiedAt || null
            : null,
        oilServiceLiveAt: sameServiceWf ? priorWf.oilServiceLiveAt || null : null,
        oilScheduleHrNotifiedAt: sameServiceWf ? priorWf.oilScheduleHrNotifiedAt || null : null,
        history: sameServiceWf && Array.isArray(priorWf.history) ? [...priorWf.history] : [],
    };

    recordOilServiceActivity(asset, service, service._id, {
        type: 'service_scheduled',
        byName: requesterName,
        note: isCash
            ? hrAlreadyApproved
                ? 'Oil service schedule submitted — HR already approved'
                : 'Oil service schedule submitted — HR Approval still open'
            : 'Oil service scheduled',
    });

    if (!asset.activeServiceWorkflow.oilServiceLiveAt) {
        asset.onServiceActive = false;
    }
    persistWorkflowSnapshot(asset);
    asset.markModified('services');
    asset.markModified('activeServiceWorkflow');
    await asset.save();

    const accountsQuoteDone = Boolean(String(remark.accountsQuoteApprovedAt || '').trim());
    if (
        (!isCash || (hrAlreadyApproved && accountsQuoteDone)) &&
        !asset.activeServiceWorkflow.oilServiceLiveAt
    ) {
        const today = utcDayStart(new Date());
        const startUtc = utcDayStart(startD);
        if (startUtc != null && today != null && today >= startUtc) {
            const fresh = await AssetItem.findById(asset._id);
            if (fresh) {
                await activateOilServiceOnStartDate(fresh, {
                    byName: requesterName,
                    force: true,
                    notify: !isCash,
                });
                asset.activeServiceWorkflow = fresh.activeServiceWorkflow;
                asset.onServiceActive = fresh.onServiceActive;
                asset.status = fresh.status;
                asset.services = fresh.services;
            }
        }
    }

    const populated = await AssetItem.findById(asset._id)
        .populate({
            path: 'assignedTo',
            select: 'firstName lastName employeeId companyEmail workEmail personalEmail email company',
            populate: { path: 'company', select: 'name' },
        })
        .lean();
    const hr = await getDepartmentHOD('hr');
    const adminOfficer = await getDepartmentHOD('admincontroller');

    const plate = [populated?.plateEmirate, populated?.plateNumber].filter(Boolean).join(' ').trim();
    const startLabel = startD.toISOString().slice(0, 10);

    // Formal scheduled letter when Admin completes Schedule/Reschedule (cash + warranty).
    // TO assigned · CC Admin + HR + Accounts + driven-by — not after Accounts approval.
    await sendVehicleServiceScheduledNotificationEmail({
        asset: populated,
        remark,
        service,
        serviceTypeLabel: 'Oil Service',
    });

    if (isCash) {
        if (!hrAlreadyApproved && !scheduleHrAlreadyOpen) {
            if (!hr?._id) {
                throw new Error('No HR assignee is configured in the company flowchart.');
            }
            await notifyStakeholders({
                asset: populated,
                serviceRecordId: service._id,
                recipients: [adminOfficer, hr].filter(Boolean),
                actionLabel: 'Oil service — Schedule & HR Approval',
                detailLine: `${requesterName} scheduled an oil service for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''} (start ${startLabel}). HR Approval is open.`,
                oilStage: 'schedule_hr_open',
            });
        }
    } else {
        const isLive = isOilServiceLive(
            populated,
            populated?.services?.find?.((s) => String(s._id) === String(service._id)),
        );
        const detailLine = isLive
            ? `${requesterName} submitted an oil service request for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''}. The vehicle is now on service.`
            : `${requesterName} scheduled an oil service for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''}. Service starts on ${startLabel}.`;

        if (isLive) {
            await notifyOilServiceWentLiveIfNeeded(populated, service._id, { detailLine });
        } else {
            await notifyStakeholders({
                asset: populated,
                serviceRecordId: service._id,
                recipients: [adminOfficer].filter(Boolean),
                actionLabel: 'Oil service — Ready to Service',
                detailLine,
                oilStage: 'ready_to_service',
            });
        }
    }

    return populated;
}

function oilServiceEndDateReached(asset, service) {
    const remark = parseOilServiceRemark(service);
    const endRaw =
        remark.serviceEndDate ||
        remark.nextChangeMonth ||
        asset?.activeServiceWorkflow?.serviceWindowEndDate ||
        null;
    if (!endRaw) return false;
    const endUtc = utcDayStart(new Date(endRaw));
    const today = utcDayStart(new Date());
    return endUtc != null && today != null && today >= endUtc;
}

/** Complete Service: On Service required (cash also needs schedule once + Accounts quote). */
function oilServiceCompleteAllowed(asset, service) {
    if (!isOilServiceLive(asset, service)) return false;
    const remark = parseOilServiceRemark(service);
    if (String(remark.requestStatus || '').toLowerCase() !== 'submitted') return false;
    if (isOilServiceCashPayment(remark) && !String(remark.accountsQuoteApprovedAt || '').trim()) {
        return false;
    }
    return true;
}

/**
 * Save oil service details draft (no workflow advance).
 */
export async function saveOilServiceDetailsDraft(asset, serviceId, serviceUpdates) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    const { wf, bindActive } = getWorkflowContextForService(asset, serviceId);
    if (!wf || wf.stage !== STAGE_SCHEDULED) {
        throw new Error('Complete Service can only be saved while the service is active.');
    }
    if (!oilServiceCompleteAllowed(asset, service)) {
        throw new Error(
            'Complete Service unlocks on On Service after Schedule (at least once) and Accounts Approve (cash).',
        );
    }

    const remark = parseOilServiceRemark(service);
    remark.serviceDetailsDraft = true;
    remark.serviceDetailsDraftAt = new Date().toISOString();
    if (serviceUpdates?.remark) {
        await mergeWorkflowServiceRecord(asset, serviceId, serviceUpdates);
    } else {
        service.remark = JSON.stringify({ ...remark, ...parseOilServiceRemark(service) });
    }

    seedGarageBillAttachmentFromShopInvoice(asset.services.id(serviceId));

    commitWorkflowContext(asset, serviceId, { wf, bindActive });
    asset.markModified('services');
    await asset.save();
    return asset;
}

/**
 * Submit oil service details (Complete Service).
 * - Warranty → complete (no Zoho).
 * - Cash → work complete → pending_accounts (Make Payment / Zoho) → billed.
 */
export async function submitOilServiceDetails(asset, serviceId, serviceUpdates, req) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    const { wf, bindActive } = getWorkflowContextForService(asset, serviceId);
    if (!wf || wf.stage !== STAGE_SCHEDULED) {
        throw new Error('Complete Service can only be submitted while the service is active.');
    }
    if (!oilServiceCompleteAllowed(asset, service)) {
        throw new Error(
            'Complete Service unlocks on On Service after Schedule (at least once) and Accounts Approve (cash).',
        );
    }

    if (serviceUpdates && typeof serviceUpdates === 'object') {
        await mergeWorkflowServiceRecord(asset, serviceId, serviceUpdates);
    }

    seedGarageBillAttachmentFromShopInvoice(asset.services.id(serviceId));

    const remark = parseOilServiceRemark(asset.services.id(serviceId));
    if (!String(remark.returnDate || '').trim() || !String(remark.handOverDate || '').trim()) {
        throw new Error('Return date and hand over date are required before completing the service.');
    }

    const serviceEndRaw =
        remark.serviceEndDate ||
        remark.nextChangeMonth ||
        asset?.activeServiceWorkflow?.serviceWindowEndDate ||
        '';
    const handOverKey = String(remark.handOverDate || '').trim().slice(0, 10);
    const returnKey = String(remark.returnDate || '').trim().slice(0, 10);
    const endKey = (() => {
        const raw = String(serviceEndRaw || '').trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
        if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
        const d = raw ? new Date(raw) : null;
        if (!d || Number.isNaN(d.getTime())) return '';
        return d.toISOString().slice(0, 10);
    })();
    if (endKey && handOverKey && handOverKey < endKey) {
        throw new Error('Hand over date must be on or after the service end date.');
    }
    if (endKey && returnKey && returnKey < endKey) {
        throw new Error('Return date must be on or after the service end date.');
    }

    const nextServiceRaw =
        remark.nextServiceDate ||
        remark.nextChangeMonth ||
        serviceUpdates?.nextServiceDate ||
        serviceUpdates?.nextServiceMonth ||
        '';
    const nextKey = (() => {
        const raw = String(nextServiceRaw || '').trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
        if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
        const d = raw ? new Date(raw) : null;
        if (!d || Number.isNaN(d.getTime())) return '';
        return d.toISOString().slice(0, 10);
    })();
    if (endKey && nextKey && nextKey <= endKey) {
        throw new Error('Next service date must be after the service end date.');
    }

    const currentKmCandidates = [
        remark.currentKm,
        service?.currentKm,
        service?.kilometer,
        service?.odometer,
        asset?.currentKilometer,
    ];
    let currentKm = null;
    for (const raw of currentKmCandidates) {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) {
            currentKm = n;
            break;
        }
    }
    const nextKmRaw = remark.nextChangeKm ?? serviceUpdates?.nextChangeKm ?? serviceUpdates?.nextServiceKm;
    const nextKm = Number(nextKmRaw);
    if (!Number.isFinite(nextKm) || nextKm < 0) {
        throw new Error('Next service KM is required.');
    }
    if (currentKm != null && nextKm < currentKm) {
        throw new Error(
            `Next service KM must be equal to or more than current KM (${currentKm.toLocaleString()}).`,
        );
    }

    const serviceRow = asset.services.id(serviceId);
    const hasGarageInvoice =
        Boolean(String(serviceRow?.shopInvoice || '').trim()) ||
        Boolean(String(remark.garageInvoiceUrl || '').trim()) ||
        Boolean(String(remark.garageInvoiceName || '').trim()) ||
        Boolean(String(remark.shopInvoiceName || '').trim());
    if (!hasGarageInvoice) {
        throw new Error('Garage invoice is required before completing the service.');
    }

    // Prefer scheduled amount when Complete Service no longer collects charge on the form.
    const totalCharge = Number(
        remark.totalServiceCharge ?? serviceRow?.value ?? remark.garageBillAmount ?? 0,
    );
    if (Number.isFinite(totalCharge) && totalCharge > 0) {
        remark.totalServiceCharge = totalCharge;
        if (!(Number(serviceRow.value) > 0)) {
            serviceRow.value = totalCharge;
        }
    }

    const isCash = isOilServiceCashPayment(remark);
    // Pay Account / Zoho bill are collected on Make Payment (pending_accounts) — not required here.

    const actorName = await getRequesterName(req.user);
    remark.serviceDetailsDraft = false;
    remark.oilServiceEndedAt = new Date().toISOString();
    remark.serviceCompletedByName = actorName;
    if (isCash) {
        remark.billingStatus = 'pending';
    }

    recordOilServiceActivity(asset, service, serviceId, {
        type: 'service_completed',
        byName: actorName,
        note: isCash
            ? 'Oil service ended (complete) — sent to Accounts for Zoho billing'
            : 'Oil service completed',
    });

    if (bindActive) {
        applyPostServiceOperationalState(asset, { statusBeforeService: wf.previousStatus || null });
        asset.onServiceActive = false;
    }

    // Persist next oil change on the vehicle from Complete Service form.
    const completedNext =
        String(remark.nextServiceDate || '').trim().slice(0, 10) ||
        (/^\d{4}-\d{2}$/.test(String(remark.nextChangeMonth || '').trim())
            ? `${String(remark.nextChangeMonth).trim()}-01`
            : '');
    if (completedNext) {
        const nextD = new Date(completedNext);
        if (!Number.isNaN(nextD.getTime())) asset.nextServiceDate = nextD;
    }
    const handOverOrEnd =
        String(remark.handOverDate || remark.serviceEndDate || '').trim().slice(0, 10);
    if (handOverOrEnd) {
        const oilD = new Date(handOverOrEnd);
        if (!Number.isNaN(oilD.getTime())) {
            asset.oilChangeDate = oilD;
            asset.lastServiceDate = oilD;
        }
    }

    // --- Cash: End Service (complete) → Accounts → Zoho → billed ---
    if (isCash) {
        wf.stage = STAGE_PENDING_ACCOUNTS;
        remark.workflowStage = STAGE_PENDING_ACCOUNTS;
        remark.vehicleServiceCompleted = 'live';
        remark.vehicleServiceCompletedAt = new Date().toISOString();
        remark.serviceWorkStatus = 'complete';
        asset.services.id(serviceId).remark = JSON.stringify(remark);
        commitWorkflowContext(asset, serviceId, { wf, bindActive });
        asset.markModified('services');
        await asset.save();

        const populated = await AssetItem.findById(asset._id)
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId companyEmail workEmail personalEmail email company',
                populate: { path: 'company', select: 'name' },
            })
            .lean();
        const accounts = await getDepartmentHOD('accounts');
        if (!accounts?._id) {
            throw new Error('No Accounts assignee is configured in the company flowchart.');
        }

        const plate = [populated?.plateEmirate, populated?.plateNumber].filter(Boolean).join(' ').trim();
        const detailLine = `Oil service for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''} is complete. Open Make Payment to create the Zoho bill (Billed only if Zoho succeeds).`;

        const adminOfficerForClose = await getDepartmentHOD('admincontroller');
        await closeOilServiceStageDashboardActions(asset._id, serviceId, {
            assignedTo: adminOfficerForClose?._id || null,
            oilStage: 'on_service',
            comment: 'Complete Service submitted',
            actionedBy: req.user?.employeeObjectId || req.user?._id || null,
        });

        await notifyOilServiceCompletedOwnerAndAssignee({
            asset: populated || asset,
            serviceRecordId: serviceId,
            remark,
        });

        await sendVehicleServiceCompletedNotificationEmail({
            asset: populated || asset,
            remark,
            service: asset.services?.id?.(serviceId) || serviceRow || null,
        });

        // Accounts: email + dashboard task + Vehicle list badge → oil service Make Payment (Zoho).
        await notifyStakeholders({
            asset: populated,
            serviceRecordId: serviceId,
            recipients: [accounts],
            actionLabel: 'Oil service — Make Payment (Zoho)',
            detailLine,
            oilStage: 'accounts_payment',
        });

        console.log(
            `[OilService] Accounts Make Payment notified -> ${accounts.firstName || ''} ${accounts.lastName || ''} (${accounts.employeeId || accounts._id})`,
        );

        return { asset: populated, zohoBillSync: null, routedTo: 'pending_accounts' };
    }

    // --- Warranty: complete immediately (no Zoho) ---
    wf.stage = STAGE_COMPLETE;
    remark.vehicleServiceCompleted = 'live';
    remark.vehicleServiceCompletedAt = new Date().toISOString();
    remark.workflowStage = STAGE_COMPLETE;
    asset.services.id(serviceId).remark = JSON.stringify(remark);

    commitWorkflowContext(asset, serviceId, { wf, bindActive });
    asset.markModified('services');
    await asset.save();

    const populated = await AssetItem.findById(asset._id)
        .populate({
            path: 'assignedTo',
            select: 'firstName lastName employeeId companyEmail workEmail personalEmail email company',
            populate: { path: 'company', select: 'name' },
        })
        .lean();
    const hr = await getDepartmentHOD('hr');
    const adminOfficer = await getDepartmentHOD('admincontroller');
    const assignee = populated?.assignedTo || null;

    const detailLine = `Oil service for ${populated?.assetId || ''} has been completed. The vehicle status has been restored.`;

    await notifyOilServiceCompletedOwnerAndAssignee({
        asset: populated || asset,
        serviceRecordId: serviceId,
        remark,
    });

    await sendVehicleServiceCompletedNotificationEmail({
        asset: populated || asset,
        remark,
        service: asset.services?.id?.(serviceId) || null,
    });

    await notifyOilServiceDetailsCompleted({
        asset: populated,
        serviceRecordId: serviceId,
        adminOfficer,
        hr,
        assignee,
        detailLine,
        actionedBy: req.user?.employeeObjectId || req.user?._id || null,
    });

    return { asset: populated, zohoBillSync: null, routedTo: 'complete' };
}

/**
 * Resolve cash oil service id that still needs Accounts Make Payment (Zoho).
 */
function resolvePendingAccountsOilServiceId(assetDoc) {
    const wf = assetDoc?.activeServiceWorkflow || {};
    const wfStage = String(wf.stage || '').toLowerCase();
    if (wfStage === STAGE_PENDING_ACCOUNTS && wf.serviceRecordId) {
        return String(wf.serviceRecordId);
    }
    for (const s of assetDoc?.services || []) {
        if (String(s?.serviceType || '').trim() !== 'Oil Service') continue;
        const remark = parseOilServiceRemark(s);
        const stage = String(
            remark.workflowStage || s?.workflowSnapshot?.stage || '',
        ).toLowerCase();
        if (stage !== STAGE_PENDING_ACCOUNTS) continue;
        if (!isOilServiceCashPayment(remark)) continue;
        if (
            String(remark.billingStatus || '').toLowerCase() === 'billed' ||
            String(remark.zohoBillId || '').trim()
        ) {
            continue;
        }
        return String(s._id);
    }
    return null;
}

/**
 * Re-open Accounts Make Payment bell/email if cash oil is pending_accounts but the
 * dashboard row was incorrectly auto-closed (legacy heal bug).
 */
export async function ensureOilAccountsMakePaymentNotification(assetDoc) {
    try {
        if (!assetDoc?._id) return false;
        const serviceId = resolvePendingAccountsOilServiceId(assetDoc);
        if (!serviceId) return false;
        const service =
            assetDoc.services?.id?.(serviceId) ||
            (assetDoc.services || []).find?.((s) => String(s._id) === String(serviceId));
        if (!service || String(service.serviceType || '').trim() !== 'Oil Service') return false;
        const remark = parseOilServiceRemark(service);
        if (!isOilServiceCashPayment(remark)) return false;
        if (
            String(remark.billingStatus || '').toLowerCase() === 'billed' ||
            String(remark.zohoBillId || '').trim()
        ) {
            return false;
        }

        const accounts = await getDepartmentHOD('accounts');
        if (!accounts?._id) return false;

        const existing = await DashboardAction.find({
            requestId: assetDoc._id,
            requestType: 'Vehicle Service Request',
            status: 'Pending',
        })
            .select('_id extra3 assignedTo')
            .lean();
        const hasPaymentRow = existing.some((row) => {
            const meta = parseOilServiceDashboardMeta(row.extra3);
            return (
                String(meta?.serviceRecordId || '') === String(serviceId) &&
                String(meta?.oilStage || '').toLowerCase() === 'accounts_payment'
            );
        });
        if (hasPaymentRow) return false;

        const populated = await AssetItem.findById(assetDoc._id)
            .populate('assignedTo', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
            .lean();
        const plate = [populated?.plateEmirate, populated?.plateNumber].filter(Boolean).join(' ').trim();
        const detailLine = `Oil service for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''} is complete. Review billing and submit to create the Zoho bill.`;

        await notifyStakeholders({
            asset: populated,
            serviceRecordId: serviceId,
            recipients: [accounts],
            actionLabel: 'Oil service — Make Payment (Zoho)',
            detailLine,
            oilStage: 'accounts_payment',
        });
        console.log(
            `[OilService] Restored Accounts Make Payment notification for asset ${populated?.assetId || assetDoc._id}`,
        );
        return true;
    } catch (err) {
        console.error('[ensureOilAccountsMakePaymentNotification]', err?.message || err);
        return false;
    }
}

/** Restore missing Accounts Make Payment bells for all (or listed) pending_accounts cash oil services. */
export async function restoreMissingOilAccountsMakePaymentNotifications({ assetIds = null } = {}) {
    try {
        const query = {
            'activeServiceWorkflow.stage': STAGE_PENDING_ACCOUNTS,
            $or: [
                { 'activeServiceWorkflow.serviceTypeLabel': 'Oil Service' },
                { 'services.serviceType': 'Oil Service' },
            ],
        };
        if (Array.isArray(assetIds) && assetIds.length) {
            query._id = { $in: assetIds };
        }
        const assets = await AssetItem.find(query).select(
            'services activeServiceWorkflow assetId plateEmirate plateNumber assignedTo',
        );
        let restored = 0;
        for (const asset of assets) {
            if (await ensureOilAccountsMakePaymentNotification(asset)) restored += 1;
        }
        if (restored) {
            console.log(`[OilService] Restored ${restored} Accounts Make Payment notification(s)`);
        }
        return restored;
    } catch (err) {
        console.error('[restoreMissingOilAccountsMakePaymentNotifications]', err?.message || err);
        return 0;
    }
}

/**
 * HR approved Cash oil schedule → scheduled_service, then On Service when start date is reached.
 */
export async function advanceOilCashAfterHrApprove(asset, wf, actorName) {
    const serviceId = wf.serviceRecordId;
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    const remark = parseOilServiceRemark(service);
    if (!isOilServiceCashPayment(remark)) {
        throw new Error('Only Cash oil services require HR schedule approval before On Service.');
    }
    // Schedule + HR are parallel after Initiate — do not block HR on Schedule OK.

    wf.stage = STAGE_SCHEDULED;
    remark.workflowStage = STAGE_SCHEDULED;
    remark.hrScheduleApprovedAt = new Date().toISOString();
    remark.hrScheduleApprovedByName = actorName || '';
    remark.hrPaymentApprovedAt = remark.hrScheduleApprovedAt;
    remark.hrPaymentApprovedByName = actorName || '';
    service.remark = JSON.stringify(remark);

    recordOilServiceActivity(asset, service, serviceId, {
        type: 'hr_approved',
        byName: actorName,
        note: 'HR approved schedule — awaiting Accounts Approve before Ready / On Service',
    });

    asset.activeServiceWorkflow = wf;
    persistWorkflowSnapshot(asset);
    asset.markModified('activeServiceWorkflow');
    asset.markModified('services');
    await asset.save();

    // Do not activate On Service here — cash waits for Accounts Approve first.

    const populated = await AssetItem.findById(asset._id)
        .populate('assignedTo', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
        .lean();
    const accounts = await getDepartmentHOD('accounts');
    if (!accounts?._id) {
        throw new Error('No Accounts assignee is configured in the company flowchart.');
    }
    const hr = await getDepartmentHOD('hr');
    const plate = [populated?.plateEmirate, populated?.plateNumber].filter(Boolean).join(' ').trim();
    const startD = resolveServiceStartDate(remark) || wf.scheduledServiceDate;
    const startLabel = startD ? new Date(startD).toISOString().slice(0, 10) : '';

    await closeOilServiceStageDashboardActions(asset._id, serviceId, {
        assignedTo: hr?._id || null,
        oilStage: 'hr_approval',
        comment: 'HR approved schedule',
    });
    // Close HR's parallel Schedule/HR open task (Admin keeps schedule task / initiate track).
    await closeOilServiceStageDashboardActions(asset._id, serviceId, {
        assignedTo: hr?._id || null,
        oilStage: 'schedule_hr_open',
        comment: 'HR approved — Schedule/HR open task closed',
    });

    const scheduleRows = buildOilScheduleEmailDetailRows(remark);
    const adminOfficer = await getDepartmentHOD('admincontroller');

    // Accounts: dashboard task + email with full schedule details.
    await notifyStakeholders({
        asset: populated,
        serviceRecordId: serviceId,
        recipients: [accounts],
        actionLabel: 'Oil service — Accounts Approve',
        detailLine: `HR approved the oil service for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''}. Review amount/quotation and approve${startLabel ? ` (start ${startLabel})` : ''}.`,
        detailRows: scheduleRows,
        oilStage: 'accounts_quote',
    });

    // Admin: full-details email when HR approves (no extra dashboard spam).
    if (adminOfficer?._id && String(adminOfficer._id) !== String(accounts._id)) {
        const linkPath = oilServiceDetailsPath(populated._id, serviceId);
        await sendOilEmail({
            recipient: adminOfficer,
            asset: populated,
            actionLabel: 'Oil service — HR approved',
            detailLine: `HR approved the oil service schedule for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''}. Full garage and date details are below. Accounts will review next.`,
            detailRows: scheduleRows,
            serviceRecordId: serviceId,
            linkPath,
        });
    }

    return populated;
}

/**
 * Accounts approved Cash oil payment → Zoho bill must succeed, then billed.
 * Warranty oil skips this path (no Zoho). Car Wash is separate (no Zoho gate here).
 */
export async function advanceOilCashAfterAccountsApprove(asset, wf, actorName) {
    const serviceId = wf.serviceRecordId;
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    const remark = parseOilServiceRemark(service);
    if (!isOilServiceCashPayment(remark)) {
        throw new Error('Only Cash oil services create a Zoho bill on Accounts approve.');
    }

    seedGarageBillAttachmentFromShopInvoice(service);

    const liveForPay = parseOilServiceRemark(service);
    if (!remarkHasGaragePayAccount(liveForPay)) {
        throw new Error(
            'Each payable-from line needs a Chart of Accounts and amount before Accounts can approve and create the Zoho bill.',
        );
    }

    let zohoBillSync = null;
    try {
        const { syncVehicleGarageServiceToZoho } = await import('./syncVehicleGarageServiceToZoho.js');
        zohoBillSync = await syncVehicleGarageServiceToZoho({
            asset,
            service: asset.services.id(serviceId),
            serviceTypeLabel: 'Oil Service',
        });
    } catch (err) {
        zohoBillSync = { ok: false, message: err?.message || 'Zoho bill sync failed' };
        console.error('[OilService] Accounts Zoho bill sync:', err);
    }

    asset.markModified('services');

    if (!zohoBillSync?.ok) {
        recordOilServiceActivity(asset, asset.services.id(serviceId), serviceId, {
            type: 'zoho_bill_failed',
            byName: actorName,
            note: zohoBillSync?.message || 'Zoho bill failed — Accounts approval blocked',
        });
        asset.markModified('services');
        await asset.save();
        throw new Error(
            zohoBillSync?.message ||
            'Zoho bill must be created successfully before status can become Billed.',
        );
    }

    const liveRemark = parseOilServiceRemark(asset.services.id(serviceId));
    wf.stage = STAGE_BILLED;
    liveRemark.workflowStage = STAGE_BILLED;
    liveRemark.billingStatus = 'billed';
    liveRemark.vehicleServiceCompleted = 'live';
    liveRemark.vehicleServiceCompletedAt =
        liveRemark.vehicleServiceCompletedAt || new Date().toISOString();
    liveRemark.accountsPaymentApprovedAt = new Date().toISOString();
    liveRemark.accountsPaymentApprovedByName = actorName || '';
    asset.services.id(serviceId).remark = JSON.stringify(liveRemark);

    recordOilServiceActivity(asset, asset.services.id(serviceId), serviceId, {
        type: 'zoho_bill_created',
        byName: actorName,
        note: zohoBillSync.message || 'Accounts approved — Zoho bill created (Billed)',
    });

    asset.activeServiceWorkflow = wf;
    persistWorkflowSnapshot(asset);
    asset.markModified('activeServiceWorkflow');
    asset.markModified('services');
    await asset.save();

    const populated = await AssetItem.findById(asset._id)
        .populate('assignedTo', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
        .lean();
    const hr = await getDepartmentHOD('hr');
    const adminOfficer = await getDepartmentHOD('admincontroller');
    const assignee = populated?.assignedTo || null;
    const detailLine = `Oil service billed. ${zohoBillSync.message || 'Zoho bill created.'}`;

    await notifyOilServiceDetailsCompleted({
        asset: populated,
        serviceRecordId: serviceId,
        adminOfficer,
        hr,
        assignee,
        detailLine,
        actionedBy: null,
    });

    return { asset: populated, zohoBillSync };
}

/**
 * Admin officer or assignee (while scheduled) may update service start/end dates.
 */
export async function updateOilServiceDates(
    asset,
    serviceId,
    {
        serviceStartDate,
        serviceEndDate,
        garageName,
        garageLocation,
        garageContact,
        zohoVendorId,
        serviceIssue,
        paymentToGarage,
        paymentToGarageAmount,
        paymentToGarageAttachments,
        scheduleDescription,
        remarkPatch,
    },
    reqUser,
) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    const { wf, bindActive } = getWorkflowContextForService(asset, serviceId);
    const remark = parseOilServiceRemark(service);
    const reqStatus = String(remark.requestStatus || '').toLowerCase();
    const initiated =
        reqStatus === 'submitted' || Boolean(String(remark.oilServiceInitiatedAt || '').trim());
    const hasOilWorkflow = Boolean(wf && isOilServiceWorkflowRecord(wf, service));

    // Pre-submit (often warranty): allow Admin to persist garage/dates before submit-request.
    if (!hasOilWorkflow) {
        if (!initiated || !['draft', 'pending'].includes(reqStatus)) {
            throw new Error('Not an oil service workflow.');
        }
    } else {
        const stage = String(wf.stage || '').toLowerCase();
        if (
            stage === STAGE_COMPLETE ||
            stage === STAGE_PENDING_ACCOUNTS ||
            stage === STAGE_BILLED ||
            stage === 'rejected'
        ) {
            throw new Error('Schedule cannot be updated after the service is complete.');
        }
        if (stage !== STAGE_SCHEDULED && stage !== STAGE_PENDING_HR) {
            throw new Error('Service schedule can only be updated before Complete Service.');
        }
    }

    const prevStart = remark.serviceStartDate || '';
    const prevEnd = remark.serviceEndDate || '';
    const actorName = await getRequesterName(reqUser);

    if (serviceStartDate) {
        remark.serviceStartDate = serviceStartDate;
        if (hasOilWorkflow) {
            wf.scheduledServiceDate = new Date(serviceStartDate);
        }
    }
    if (serviceEndDate) {
        remark.serviceEndDate = serviceEndDate;
        remark.nextChangeMonth = String(serviceEndDate).slice(0, 7);
        if (hasOilWorkflow) {
            wf.serviceWindowEndDate = new Date(serviceEndDate);
            wf.serviceDurationEmailSentAt = null;
            wf.oilServiceOverdueNotifiedAt = null;
        }
    }

    const { assertServiceScheduleDates } = await import('./vehicleServiceScheduleDates.js');
    assertServiceScheduleDates(
        remark.serviceStartDate || remark.scheduledServiceDate,
        remark.serviceEndDate || remark.nextChangeMonth || remark.serviceWindowEndDate,
        { requireBoth: true, requireStartFromToday: true },
    );

    if (garageName !== undefined) {
        const name = String(garageName || '').trim();
        remark.garageName = name;
        remark.vendorName = name;
    }
    if (garageLocation !== undefined) {
        remark.garageLocation = String(garageLocation || '').trim();
    }
    if (garageContact !== undefined) {
        remark.garageContact = String(garageContact || '').trim();
    }
    if (zohoVendorId !== undefined) {
        remark.zohoVendorId = String(zohoVendorId || '').trim();
    }
    if (serviceIssue !== undefined) {
        remark.serviceIssue = String(serviceIssue || '').trim();
    }
    if (scheduleDescription !== undefined) {
        remark.scheduleDescription = String(scheduleDescription || '').trim();
        remark.garageScheduleDescription = remark.scheduleDescription;
    }
    if (paymentToGarage !== undefined) {
        const yes = String(paymentToGarage || '').toLowerCase() === 'yes';
        remark.paymentToGarage = yes ? 'yes' : 'no';
        if (!yes) {
            remark.paymentToGarageAmount = undefined;
            remark.paymentToGarageAttachments = [];
        }
    }
    if (paymentToGarageAmount !== undefined && String(remark.paymentToGarage || '') === 'yes') {
        const amount = Number(paymentToGarageAmount);
        remark.paymentToGarageAmount =
            Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : undefined;
    }
    if (remarkPatch && typeof remarkPatch === 'object') {
        if (Array.isArray(remarkPatch.paymentToGarageAttachments)) {
            remark.paymentToGarageAttachments = remarkPatch.paymentToGarageAttachments
                .map((row) => ({
                    name: String(row?.name || '').trim(),
                    url: String(row?.url || '').trim(),
                }))
                .filter((row) => row.url);
        }
        if (remarkPatch.paymentToGarage != null) {
            remark.paymentToGarage = String(remarkPatch.paymentToGarage).toLowerCase() === 'yes' ? 'yes' : 'no';
        }
        if (remarkPatch.paymentToGarageAmount != null && remark.paymentToGarage === 'yes') {
            const amount = Number(remarkPatch.paymentToGarageAmount);
            remark.paymentToGarageAmount =
                Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : undefined;
        }
        if (remarkPatch.scheduleDescription != null) {
            remark.scheduleDescription = String(remarkPatch.scheduleDescription || '').trim();
            remark.garageScheduleDescription = remark.scheduleDescription;
        }
    }

    service.remark = JSON.stringify(remark);
    asset.markModified('services');

    if (Array.isArray(paymentToGarageAttachments) && paymentToGarageAttachments.length) {
        const { mergeWorkflowServiceRecord } = await import(
            '../controllers/vehicleServiceWorkflowController.js'
        );
        await mergeWorkflowServiceRecord(asset, serviceId, {
            remark: JSON.stringify({
                paymentToGarage: remark.paymentToGarage,
                paymentToGarageAmount: remark.paymentToGarageAmount,
                paymentToGarageAttachments: remark.paymentToGarageAttachments || [],
                scheduleDescription: remark.scheduleDescription,
                garageScheduleDescription: remark.garageScheduleDescription,
            }),
            paymentToGarageAttachments,
        });
        // Reload remark after upload merge so later stringify keeps new URLs.
        Object.assign(remark, parseOilServiceRemark(asset.services.id(serviceId)));
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
        if (hasOilWorkflow) {
            syncOilActivityToWorkflowHistory(asset, serviceId, entry);
        }
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
        if (hasOilWorkflow) {
            syncOilActivityToWorkflowHistory(asset, serviceId, entry);
        }
    }

    service.remark = JSON.stringify(remark);
    if (serviceIssue !== undefined) {
        service.description = String(serviceIssue || '').trim();
    }

    const startChanged =
        Boolean(serviceStartDate) &&
        String(prevStart).slice(0, 10) !== String(serviceStartDate).slice(0, 10);
    const endChanged =
        Boolean(serviceEndDate) &&
        String(prevEnd).slice(0, 10) !== String(serviceEndDate).slice(0, 10);

    // Keep vehicle oil change / next service dates aligned with Admin reschedule.
    applyOilChangeDatesFromSchedule(asset, remark);

    const scheduleAlreadySubmitted =
        ['submitted', 'resubmitted'].includes(
            String(remark.scheduleSubmitStatus || '')
                .trim()
                .toLowerCase(),
        ) ||
        Boolean(String(remark.scheduleSubmittedAt || '').trim()) ||
        Boolean(String(remark.garageSubmittedByName || '').trim()) ||
        // Legacy: schedule was completed before scheduleSubmitStatus existed.
        (Boolean(String(remark.oilServiceScheduledAt || '').trim()) &&
            isOilScheduleFieldsComplete(remark));

    // Mark resubmitted when Admin updates Schedule after first submit.
    if (scheduleAlreadySubmitted) {
        const { applyScheduleSubmitStatus } = await import('./vehicleServiceScheduleSubmitStatus.js');
        const submitMeta = applyScheduleSubmitStatus(remark, {
            alreadySubmitted: true,
            actorName,
        });
        service.remark = JSON.stringify(remark);
        appendOilServiceActivity(service, {
            type: 'schedule_resubmitted',
            byName: actorName,
            note: `Schedule resubmitted${
                startChanged || endChanged
                    ? ` · Window: ${String(remark.serviceStartDate || remark.scheduledServiceDate || '').slice(0, 10)} – ${String(remark.serviceEndDate || remark.serviceWindowEndDate || '').slice(0, 10)}`
                    : ''
            }`,
        });
        if (hasOilWorkflow && submitMeta.isResubmit) {
            syncOilActivityToWorkflowHistory(asset, serviceId, {
                type: 'schedule_resubmitted',
                byName: actorName,
                note: 'Schedule resubmitted',
            });
        }
    } else {
        service.remark = JSON.stringify(remark);
    }

    if (hasOilWorkflow) {
        commitWorkflowContext(asset, serviceId, { wf, bindActive });
    }
    asset.markModified('services');
    await asset.save();

    // Reschedule: formal scheduled letter when Admin updates Schedule after first Done.
    if (scheduleAlreadySubmitted && isOilScheduleFieldsComplete(remark)) {
        const populatedForMail = await AssetItem.findById(asset._id)
            .populate({
                path: 'assignedTo',
                select: `${OIL_EMP_EMAIL_SELECT} company`,
                populate: { path: 'company', select: 'name' },
            })
            .lean();
        const serviceForMail =
            (populatedForMail?.services || []).find((s) => String(s?._id) === String(serviceId)) ||
            service ||
            null;
        await sendVehicleServiceScheduledNotificationEmail({
            asset: populatedForMail || asset,
            remark,
            service: serviceForMail,
            serviceTypeLabel: 'Oil Service',
        });
    }

    if (hasOilWorkflow && (startChanged || endChanged)) {
        const populated = await AssetItem.findById(asset._id)
            .populate('assignedTo', OIL_EMP_EMAIL_SELECT)
            .lean();
        const plate = [populated?.plateEmirate, populated?.plateNumber]
            .filter(Boolean)
            .join(' ')
            .trim();
        const startLabel = String(remark.serviceStartDate || '').slice(0, 10);
        const endLabel = String(remark.serviceEndDate || '').slice(0, 10);
        const parts = [];
        if (startChanged) {
            parts.push(
                `start ${String(prevStart).slice(0, 10) || '—'} → ${startLabel || '—'}`,
            );
        }
        if (endChanged) {
            parts.push(`end ${String(prevEnd).slice(0, 10) || '—'} → ${endLabel || '—'}`);
        }
        await notifyOilScheduleStakeholders({
            asset: populated || asset,
            serviceRecordId: serviceId,
            remark,
            actionLabel: 'Oil service — schedule updated',
            detailLine: `Your vehicle${plate ? ` (${plate})` : ''} oil service schedule was updated by Admin. Please review the garage details and dates below${parts.length ? ` (${parts.join('; ')})` : ''}.`,
        });
    }

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

    const { assertServiceScheduleDates } = await import('./vehicleServiceScheduleDates.js');
    assertServiceScheduleDates(
        remark.serviceStartDate || remark.scheduledServiceDate,
        endDate,
        { requireBoth: false, requireStartFromToday: false },
    );

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
    applyOilChangeDatesFromSchedule(asset, remark);
    commitWorkflowContext(asset, serviceId, { wf, bindActive });
    asset.markModified('services');
    await asset.save();

    if (String(prevEnd).slice(0, 10) !== endDate) {
        const populated = await AssetItem.findById(asset._id)
            .populate('assignedTo', OIL_EMP_EMAIL_SELECT)
            .lean();
        const plate = [populated?.plateEmirate, populated?.plateNumber]
            .filter(Boolean)
            .join(' ')
            .trim();
        await notifyOilScheduleStakeholders({
            asset: populated || asset,
            serviceRecordId: serviceId,
            remark,
            actionLabel: 'Oil service — schedule updated',
            detailLine: `Your vehicle${plate ? ` (${plate})` : ''} oil service end date was extended by Admin. Please review the garage details and dates below (end ${String(prevEnd).slice(0, 10) || '—'} → ${endDate}).`,
        });
    }

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

/**
 * Source row for auto-create due check: latest completed oil service only.
 * Open pending/in-progress rows must not drive due (their serviceEndDate is not next-due).
 */
function findPreviousCompletedOilServiceRowForDue(asset) {
    const services = Array.isArray(asset?.services) ? asset.services : [];
    return (
        services
            .filter((s) => String(s.serviceType || '').trim() === 'Oil Service')
            .filter((s) => isApprovedOilServiceRow(asset, s))
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

/**
 * Next oil due date for auto-create — must NOT use serviceEndDate / schedule end.
 * Those are when the current garage visit ends, not when the next oil change is due.
 */
function resolveNextOilDueDateFromRemark(remark, asset) {
    const remarkNext = String(remark?.nextServiceDate || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(remarkNext)) {
        return new Date(remarkNext.slice(0, 10));
    }
    if (asset?.nextServiceDate) {
        const assetNext = new Date(asset.nextServiceDate);
        if (!Number.isNaN(assetNext.getTime())) return assetNext;
    }
    // Legacy month-only field (first day of that month).
    const month = String(remark?.nextChangeMonth || '').trim();
    if (/^\d{4}-\d{2}$/.test(month)) {
        return new Date(`${month}-01`);
    }
    return null;
}

/** @deprecated Prefer resolveNextOilDueDateFromRemark for due checks. */
function resolveNextOilServiceDateFromRemark(remark, asset) {
    return resolveNextOilDueDateFromRemark(remark, asset);
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
 * 1) vehicle current km == previous completed row next oil change km, or
 * 2) previous completed row next oil service date == today.
 * Never uses service end / schedule end as the due date.
 */
function evaluateOilServiceDue(asset, previousRow) {
    if (!previousRow) {
        return { due: false, dateDue: false, kmDue: false, nextDate: null, nextKm: null };
    }

    const previousRemark = parseOilServiceRemark(previousRow);
    const today = utcDayStart(new Date());
    const nextDate = resolveNextOilDueDateFromRemark(previousRemark, asset);
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
 * When the previous completed oil service has next service date == today
 * or current km == next change km, create a pending oil service row and email
 * Admin Officer, assigned user, and Management.
 */
export async function maybeAutoCreateOilServiceDue(assetDoc) {
    if (!assetDoc) return false;
    if (!String(assetDoc.plateNumber || '').trim()) return false;
    if (!isFleetVehicleProfileActive(assetDoc)) return false;
    // Only block when an auto-created due request is already open (not by previous-row status).
    if (hasOpenAutoCreatedOilService(assetDoc)) return false;

    const previousRow = findPreviousCompletedOilServiceRowForDue(assetDoc);
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
        serviceReqNo: await allocateNextServiceReqNo(assetDoc),
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

/**
 * Cron: On Service + end date = today → Admin email + dashboard/bell to Complete Service.
 */
export async function processOilServiceCompleteDueReminder() {
    try {
        const items = await AssetItem.find({
            'activeServiceWorkflow.stage': STAGE_SCHEDULED,
            'activeServiceWorkflow.serviceTypeLabel': 'Oil Service',
            onServiceActive: true,
        })
            .select('assetId name plateNumber plateEmirate activeServiceWorkflow assignedTo onServiceActive')
            .limit(500)
            .lean();

        const today = utcDayStart(new Date());
        const adminOfficer = await getDepartmentHOD('admincontroller');
        if (!adminOfficer?._id) return;

        for (const row of items) {
            const wf = row.activeServiceWorkflow;
            if (!wf?.serviceWindowEndDate || !wf?.serviceRecordId) continue;
            if (wf.oilServiceCompleteDueNotifiedAt) continue;
            const end = utcDayStart(wf.serviceWindowEndDate);
            if (end == null || today !== end) continue;

            const asset = await AssetItem.findById(row._id).populate(
                'assignedTo',
                'firstName lastName employeeId companyEmail workEmail personalEmail email',
            );
            if (!asset?.activeServiceWorkflow) continue;
            const serviceSub = asset.services?.id?.(asset.activeServiceWorkflow.serviceRecordId);
            if (String(serviceSub?.serviceType || '').trim() !== 'Oil Service') continue;
            if (!isOilServiceLive(asset, serviceSub)) continue;

            asset.activeServiceWorkflow.oilServiceCompleteDueNotifiedAt = new Date();
            asset.markModified('activeServiceWorkflow');
            await asset.save();

            const plate = [asset.plateEmirate, asset.plateNumber].filter(Boolean).join(' ').trim();
            const detailLine = `Oil service end date is today for ${asset.assetId || ''}${plate ? ` (${plate})` : ''
                }. Please submit Complete Service.`;

            await notifyStakeholders({
                asset: asset.toObject ? asset.toObject() : asset,
                serviceRecordId: wf.serviceRecordId,
                recipients: [adminOfficer],
                actionLabel: 'Oil service — Complete Service due',
                detailLine,
                oilStage: 'complete_due',
            });
        }
    } catch (e) {
        console.error('[processOilServiceCompleteDueReminder]', e);
    }
}
