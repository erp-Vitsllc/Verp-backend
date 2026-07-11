import AssetItem from '../models/AssetItem.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendVehicleServiceWorkflowEmail } from './sendVehicleServiceWorkflowEmail.js';
import { syncDashboardAction } from './syncDashboard.js';
import { applyServiceActiveState } from './assetOperationalFlags.js';
import { getWorkflowContextForService } from './vehicleServiceWorkflowResolve.js';

export const SHOP_SERVICE_SCHEDULED_STAGE = 'scheduled_service';

export const SHOP_SERVICE_TYPE_LABELS = ['Tire Change', 'Mechanical Work', 'Body Work', 'Accident Repair'];

function parseRemark(service) {
    try {
        return service?.remark ? JSON.parse(service.remark) : {};
    } catch {
        return {};
    }
}

function utcDayStart(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function resolveServiceWindowDates(wf, remark) {
    const startRaw =
        remark.serviceStartDate || remark.scheduledServiceDate || wf?.scheduledServiceDate || null;
    const endRaw = remark.serviceEndDate || remark.serviceWindowEndDate || wf?.serviceWindowEndDate || null;
    const startD = startRaw ? new Date(startRaw) : null;
    const endD = endRaw ? new Date(endRaw) : null;
    return {
        startD: startD && !Number.isNaN(startD.getTime()) ? startD : null,
        endD: endD && !Number.isNaN(endD.getTime()) ? endD : null,
    };
}

function uniqRecipients(list) {
    const seen = new Set();
    const out = [];
    for (const row of list || []) {
        const id = row?._id ? String(row._id) : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(row);
    }
    return out;
}

async function notifyShopServiceRecipients({
    asset,
    serviceRecordId,
    recipients,
    serviceTypeLabel,
    actionLabel,
    detailLine,
    linkPath,
    dashboardMeta,
}) {
    for (const recipient of uniqRecipients(recipients)) {
        if (!recipient) continue;
        await sendVehicleServiceWorkflowEmail({
            recipient,
            asset,
            stageLabel: actionLabel,
            actionLabel,
            detailLine,
            linkPath,
        });
        if (recipient._id) {
            await syncDashboardAction({
                requestId: asset._id,
                requestType: 'Vehicle Service Request',
                status: 'Pending',
                assignedTo: recipient._id,
                subjectEmployee: asset.assignedTo,
                requestedByName: actionLabel,
                extra1: `${asset.assetId} — ${serviceTypeLabel}`,
                extra2: detailLine,
                extra3: dashboardMeta,
            });
        }
    }
}

async function notifyShopServiceScheduled({
    asset,
    serviceRecordId,
    serviceTypeLabel,
    actorName,
    startD,
    linkPath,
    dashboardMeta,
}) {
    const populated = await AssetItem.findById(asset._id)
        .populate({
            path: 'assignedTo',
            select: 'firstName lastName employeeId companyEmail workEmail',
            populate: {
                path: 'primaryReportee',
                select: 'firstName lastName employeeId companyEmail workEmail',
            },
        })
        .lean();
    if (!populated) return;

    const adminOfficer = await getDepartmentHOD('admincontroller');
    const assignee = populated.assignedTo || null;
    const plate = [populated.plateEmirate, populated.plateNumber].filter(Boolean).join(' ').trim();
    const startLabel = startD ? startD.toISOString().slice(0, 10) : 'the scheduled date';
    const detailLine = `${actorName || 'Accounts'} approved garage details for ${populated.assetId || ''}${plate ? ` (${plate})` : ''}. Service is scheduled — start date ${startLabel}.`;

    await notifyShopServiceRecipients({
        asset: populated,
        serviceRecordId,
        recipients: [adminOfficer, assignee],
        serviceTypeLabel,
        actionLabel: `${serviceTypeLabel} scheduled`,
        detailLine,
        linkPath,
        dashboardMeta,
    });

    const fresh = await AssetItem.findById(asset._id);
    if (fresh?.activeServiceWorkflow) {
        fresh.activeServiceWorkflow.shopServiceScheduledNotifiedAt = new Date();
        fresh.markModified('activeServiceWorkflow');
        await fresh.save();
    }
}

async function notifyShopServiceWentLiveIfNeeded({
    asset,
    serviceRecordId,
    serviceTypeLabel,
    linkPath,
    dashboardMeta,
    detailLine,
}) {
    const wf = asset?.activeServiceWorkflow;
    if (!wf || wf.shopServiceLiveNotifiedAt) return false;

    const populated = await AssetItem.findById(asset._id)
        .populate({
            path: 'assignedTo',
            select: 'firstName lastName employeeId companyEmail workEmail',
            populate: {
                path: 'primaryReportee',
                select: 'firstName lastName employeeId companyEmail workEmail',
            },
        })
        .lean();
    if (!populated) return false;

    const adminOfficer = await getDepartmentHOD('admincontroller');
    const assignee = populated.assignedTo || null;
    const plate = [populated.plateEmirate, populated.plateNumber].filter(Boolean).join(' ').trim();
    const message =
        detailLine ||
        `${serviceTypeLabel} for ${populated.assetId || ''}${plate ? ` (${plate})` : ''} has started today. The vehicle is now on service.`;

    await notifyShopServiceRecipients({
        asset: populated,
        serviceRecordId,
        recipients: [adminOfficer, assignee],
        serviceTypeLabel,
        actionLabel: 'Vehicle on service',
        detailLine: message,
        linkPath,
        dashboardMeta,
    });

    const fresh = await AssetItem.findById(asset._id);
    if (fresh?.activeServiceWorkflow) {
        fresh.activeServiceWorkflow.shopServiceLiveNotifiedAt = new Date();
        fresh.markModified('activeServiceWorkflow');
        await fresh.save();
    }

    return true;
}

export function isShopServiceWorkflowRecord(wf, service) {
    const label = String(wf?.serviceTypeLabel || service?.serviceType || '').trim();
    return SHOP_SERVICE_TYPE_LABELS.includes(label);
}

export function isShopServiceLive(asset, service) {
    const remark = parseRemark(service);
    if (String(remark.shopServiceLiveAt || '').trim()) return true;
    const serviceId = service?._id;
    if (serviceId) {
        const { wf } = getWorkflowContextForService(asset, serviceId);
        return Boolean(wf?.shopServiceLiveAt);
    }
    const wf = asset?.activeServiceWorkflow || {};
    return Boolean(wf.shopServiceLiveAt);
}

/**
 * After Accounts approves garage — move tire / mechanical / body work to scheduled_service and notify Admin + assignee.
 */
export async function advanceShopServiceToScheduledAfterAccountsApprove(
    asset,
    wf,
    actorName,
    {
        serviceTypeLabel,
        linkPath,
        dashboardMeta,
        appendActivity,
    },
) {
    const serviceRecordId = wf.serviceRecordId;
    const service = asset.services?.id?.(serviceRecordId);
    if (!service) throw new Error('Service record not found');

    const remark = parseRemark(service);
    const { startD, endD } = resolveServiceWindowDates(wf, remark);
    if (!startD || !endD) {
        throw new Error('Service start and end dates are required before Accounts approval.');
    }

    wf.stage = SHOP_SERVICE_SCHEDULED_STAGE;
    wf.accountsHold = null;
    wf.scheduledServiceDate = startD;
    wf.serviceWindowEndDate = endD;
    wf.serviceDurationEmailSentAt = null;
    wf.shopServiceLiveAt = null;
    wf.shopServiceScheduledNotifiedAt = null;
    wf.shopServiceLiveNotifiedAt = null;

    remark.workflowStage = SHOP_SERVICE_SCHEDULED_STAGE;
    remark.accountsApprovedAt = new Date().toISOString();
    remark.accountsApprovedByName = actorName || '';
    service.remark = JSON.stringify(remark);

    if (typeof appendActivity === 'function') {
        appendActivity(service, {
            type: 'accounts_approved',
            byName: actorName,
            note: 'Garage and service dates approved — service scheduled',
        });
    }

    asset.activeServiceWorkflow = wf;
    asset.markModified('activeServiceWorkflow');
    asset.markModified('services');
    await asset.save();

    await notifyShopServiceScheduled({
        asset,
        serviceRecordId,
        serviceTypeLabel,
        actorName,
        startD,
        linkPath,
        dashboardMeta,
    });

    await activateShopServiceOnStartDate(asset, {
        serviceTypeLabel,
        linkPath,
        dashboardMeta,
        byName: actorName || 'System',
        force: false,
        notify: true,
    });

    return asset;
}

/**
 * Flip tire / mechanical / body work to On Service when the scheduled start date is reached.
 */
export async function activateShopServiceOnStartDate(
    asset,
    {
        serviceTypeLabel,
        linkPath,
        dashboardMeta,
        byName = 'System',
        force = false,
        notify = true,
        detailLine,
    } = {},
) {
    const wf = asset?.activeServiceWorkflow;
    if (!wf || String(wf.stage || '').toLowerCase() !== SHOP_SERVICE_SCHEDULED_STAGE) return false;
    if (String(wf.serviceTypeLabel || '').trim() !== String(serviceTypeLabel || '').trim()) return false;
    if (wf.shopServiceLiveAt) return false;

    const service = asset.services?.id?.(wf.serviceRecordId);
    if (!service) return false;

    const remark = parseRemark(service);
    const { startD } = resolveServiceWindowDates(wf, remark);
    if (!startD) return false;

    const today = utcDayStart(new Date());
    const startUtc = utcDayStart(startD);
    if (!force && (startUtc == null || today < startUtc)) return false;

    const liveAt = new Date();
    wf.shopServiceLiveAt = liveAt;
    remark.shopServiceLiveAt = liveAt.toISOString();
    remark.workflowStage = SHOP_SERVICE_SCHEDULED_STAGE;
    service.remark = JSON.stringify(remark);

    asset.onServiceActive = true;
    applyServiceActiveState(asset);
    asset.markModified('services');
    asset.markModified('activeServiceWorkflow');
    await asset.save();

    if (notify) {
        await notifyShopServiceWentLiveIfNeeded({
            asset,
            serviceRecordId: wf.serviceRecordId,
            serviceTypeLabel,
            linkPath,
            dashboardMeta,
            detailLine,
        });
    }

    return true;
}

/** Cron + page load: activate shop services whose start date is today or earlier. */
export async function processShopServiceStartDateActivation() {
    try {
        for (const serviceTypeLabel of SHOP_SERVICE_TYPE_LABELS) {
            const items = await AssetItem.find({
                'activeServiceWorkflow.stage': SHOP_SERVICE_SCHEDULED_STAGE,
                'activeServiceWorkflow.serviceTypeLabel': serviceTypeLabel,
                $or: [
                    { 'activeServiceWorkflow.shopServiceLiveAt': { $exists: false } },
                    { 'activeServiceWorkflow.shopServiceLiveAt': null },
                ],
                onServiceActive: { $ne: true },
            })
                .select('_id activeServiceWorkflow')
                .limit(500)
                .lean();

            for (const row of items) {
                const asset = await AssetItem.findById(row._id);
                if (!asset) continue;
                const wf = asset.activeServiceWorkflow || {};
                const linkPath =
                    serviceTypeLabel === 'Tire Change'
                        ? `/HRM/Asset/Vehicle/details/${asset._id}/tire-change/${wf.serviceRecordId}`
                        : serviceTypeLabel === 'Mechanical Work'
                          ? `/HRM/Asset/Vehicle/details/${asset._id}/mechanical-work/${wf.serviceRecordId}`
                          : serviceTypeLabel === 'Body Work'
                            ? `/HRM/Asset/Vehicle/details/${asset._id}/body-work/${wf.serviceRecordId}`
                            : `/HRM/Asset/Vehicle/details/${asset._id}/accident-repair/${wf.serviceRecordId}`;
                const dashboardMeta = JSON.stringify({
                    vehicleId: String(asset._id),
                    serviceRecordId: String(wf.serviceRecordId || ''),
                    serviceType: serviceTypeLabel,
                    detailsPath: linkPath,
                });
                await activateShopServiceOnStartDate(asset, {
                    serviceTypeLabel,
                    linkPath,
                    dashboardMeta,
                    byName: 'System',
                    notify: true,
                });
            }
        }
    } catch (e) {
        console.error('[processShopServiceStartDateActivation]', e);
    }
}
