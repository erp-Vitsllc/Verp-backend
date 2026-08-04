import AssetItem from '../models/AssetItem.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendVehicleServiceWorkflowEmail } from './sendVehicleServiceWorkflowEmail.js';
import { sendVehicleServiceScheduledNotificationEmail } from './sendVehicleServiceScheduledNotificationEmail.js';
import { sendVehicleServiceCompletedNotificationEmail } from './sendVehicleServiceCompletedNotificationEmail.js';
import { syncDashboardAction } from './syncDashboard.js';
import { applyServiceActiveState } from './assetOperationalFlags.js';
import { getWorkflowContextForService } from './vehicleServiceWorkflowResolve.js';

export const SHOP_SERVICE_SCHEDULED_STAGE = 'scheduled_service';
export const SHOP_SERVICE_PENDING_BILLING = 'pending_billing';
export const SHOP_SERVICE_BILLED = 'billed';

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

function resolveRecipientEmail(emp) {
    if (!emp) return '';
    return String(emp.companyEmail || emp.workEmail || emp.personalEmail || emp.email || '').trim();
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

function resolveServiceReqNo(service, remark = {}) {
    return String(
        service?.serviceReqNo ||
            remark.serviceReqNo ||
            remark.vsrNo ||
            remark.requestNo ||
            '',
    ).trim();
}

/** Oil-style schedule rows for shop service emails. */
function buildShopScheduleEmailDetailRows(remark = {}, serviceTypeLabel = 'Vehicle Service') {
    const start =
        String(remark.serviceStartDate || remark.scheduledServiceDate || '').trim().slice(0, 10);
    const end = String(remark.serviceEndDate || remark.serviceWindowEndDate || '').trim().slice(0, 10);
    const garage = String(remark.garageName || remark.vendorName || '').trim();
    const location = String(remark.garageLocation || '').trim();
    const contact = String(remark.garageContact || '').trim();
    const description = String(
        remark.serviceIssue || remark.description || remark.notes || '',
    ).trim();
    const amount =
        Number(remark.hrReviewApprovedAmount) ||
        Number(remark.approvedAmount) ||
        Number(remark.estimatedCost) ||
        Number(remark.garageBillAmount) ||
        0;

    const rows = [];
    rows.push({
        label: 'Status',
        value: `Your vehicle is scheduled for ${serviceTypeLabel || 'service'} (garage)`,
    });
    if (start) rows.push({ label: 'Service start date', value: start });
    if (end) rows.push({ label: 'Service end date', value: end });
    if (garage) rows.push({ label: 'Garage', value: garage });
    if (location) rows.push({ label: 'Garage location', value: location });
    if (contact) rows.push({ label: 'Garage contact', value: contact });
    if (amount > 0) {
        rows.push({
            label: 'Amount',
            value: `AED ${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        });
    }
    if (description) rows.push({ label: 'Description', value: description });
    return rows;
}

function collectCcEmails(people = [], excludeEmail = '') {
    const exclude = String(excludeEmail || '').trim().toLowerCase();
    const set = new Set();
    for (const person of people || []) {
        const email = resolveRecipientEmail(person);
        if (!email) continue;
        if (exclude && email.toLowerCase() === exclude) continue;
        set.add(email);
    }
    return [...set];
}

async function notifyShopServiceRecipients({
    asset,
    serviceRecordId,
    recipients,
    serviceTypeLabel,
    actionLabel,
    detailLine,
    detailRows = [],
    linkPath,
    dashboardMeta,
    cc = [],
}) {
    const serviceReqNo = resolveServiceReqNo(
        (Array.isArray(asset?.services) ? asset.services : []).find(
            (s) => String(s?._id) === String(serviceRecordId),
        ),
        parseRemark(
            (Array.isArray(asset?.services) ? asset.services : []).find(
                (s) => String(s?._id) === String(serviceRecordId),
            ),
        ),
    );
    for (const recipient of uniqRecipients(recipients)) {
        if (!recipient) continue;
        await sendVehicleServiceWorkflowEmail({
            recipient,
            asset,
            stageLabel: actionLabel,
            actionLabel,
            detailLine,
            detailRows,
            serviceReqNo,
            linkPath,
            cc,
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
            select: 'firstName lastName employeeId companyEmail workEmail company',
            populate: [
                {
                    path: 'primaryReportee',
                    select: 'firstName lastName employeeId companyEmail workEmail',
                },
                { path: 'company', select: 'name' },
            ],
        })
        .lean();
    if (!populated) return;

    const service =
        (Array.isArray(populated.services) ? populated.services : []).find(
            (s) => String(s?._id) === String(serviceRecordId),
        ) || null;
    const remark = parseRemark(service);

    // Formal letter-style email: TO assigned user, CC Admin Officer + HR + Accounts + driven-by.
    await sendVehicleServiceScheduledNotificationEmail({
        asset: populated,
        remark,
        service,
        serviceTypeLabel: serviceTypeLabel || service?.serviceType || 'Vehicle Service',
    });

    const adminOfficer = await getDepartmentHOD('admincontroller');
    const plate = [populated.plateEmirate, populated.plateNumber].filter(Boolean).join(' ').trim();
    const startLabel = startD ? startD.toISOString().slice(0, 10) : 'the scheduled date';
    const scheduleRows = buildShopScheduleEmailDetailRows(
        remark,
        serviceTypeLabel || service?.serviceType || 'Vehicle Service',
    );
    const todayUtc = utcDayStart(new Date());
    const startUtc = startD ? utcDayStart(startD) : null;
    const isLiveAlready = startUtc != null && todayUtc != null && startUtc <= todayUtc;

    // Oil parity: if start is in the future, Admin gets Ready-to-Service email with schedule rows.
    if (adminOfficer?._id && !isLiveAlready) {
        await sendVehicleServiceWorkflowEmail({
            recipient: adminOfficer,
            asset: populated,
            stageLabel: `${serviceTypeLabel} — Ready to Service`,
            actionLabel: `${serviceTypeLabel} — Ready to Service`,
            detailLine: `${actorName || 'Accounts'} approved garage details for ${populated.assetId || ''}${plate ? ` (${plate})` : ''}. Status is Ready to Service until ${startLabel}, then On Service. Full service details below.`,
            detailRows: scheduleRows,
            serviceReqNo: resolveServiceReqNo(service, remark),
            linkPath,
        }).catch(() => {});
    }

    // Keep Admin Officer dashboard task for the scheduled window.
    if (adminOfficer?._id) {
        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Service Request',
            status: 'Pending',
            assignedTo: adminOfficer._id,
            subjectEmployee: asset.assignedTo,
            requestedByName: `${serviceTypeLabel} scheduled`,
            extra1: `${populated.assetId} — ${serviceTypeLabel}`,
            extra2: `${actorName || 'Accounts'} approved garage details. Service scheduled — start ${startLabel}${plate ? ` (${plate})` : ''}.`,
            extra3: dashboardMeta,
        });
    }

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
        .select(
            'assetId name plateEmirate plateNumber assignedTo services._id services.serviceReqNo services.serviceType services.remark',
        )
        .lean();
    if (!populated) return false;

    const adminOfficer = await getDepartmentHOD('admincontroller');
    const plate = [populated.plateEmirate, populated.plateNumber].filter(Boolean).join(' ').trim();
    const message =
        detailLine ||
        `${serviceTypeLabel} for ${populated.assetId || ''}${plate ? ` (${plate})` : ''} has started today. The vehicle is now On Service — complete the service when ready.`;

    const service =
        (Array.isArray(populated.services) ? populated.services : []).find(
            (s) => String(s?._id) === String(serviceRecordId),
        ) || null;
    const remark = parseRemark(service);
    const scheduleRows = buildShopScheduleEmailDetailRows(remark, serviceTypeLabel);

    // Oil parity: On Service email goes to Admin only (assignee already got formal scheduled letter).
    if (adminOfficer?._id) {
        await notifyShopServiceRecipients({
            asset: populated,
            serviceRecordId,
            recipients: [adminOfficer],
            serviceTypeLabel,
            actionLabel: `${serviceTypeLabel} — On Service`,
            detailLine: message,
            detailRows: scheduleRows,
            linkPath,
            dashboardMeta,
        });
    }

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

export const SHOP_SERVICE_PENDING_ACCOUNTS = 'pending_accounts';

/**
 * After Admin submits Schedule/Garage — send to Accounts Approve (Oil-style), with email + inbox task.
 * Accounts approve then calls advanceShopServiceToScheduledAfterAccountsApprove.
 */
export async function routeShopServiceToAccountsApproveAfterGarage(
    asset,
    serviceId,
    {
        serviceTypeLabel,
        actorName,
        linkPath,
        dashboardMeta,
        appendActivity,
    } = {},
) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    const remark = parseRemark(service);
    const { wf, bindActive } = getWorkflowContextForService(asset, serviceId);
    if (!wf) throw new Error('Workflow not found');

    const accounts = await getDepartmentHOD('accounts');
    if (!accounts?._id) {
        throw new Error('No Accounts assignee is configured in the company flowchart.');
    }

    remark.workflowStage = SHOP_SERVICE_PENDING_ACCOUNTS;
    remark.accountsGarageSubmittedAt = new Date().toISOString();
    service.remark = JSON.stringify(remark);

    if (typeof appendActivity === 'function') {
        appendActivity(service, {
            type: 'garage_updated',
            byName: actorName,
            note: `${serviceTypeLabel || 'Service'} scheduled details submitted — awaiting Accounts Approve`,
        });
    }

    wf.stage = SHOP_SERVICE_PENDING_ACCOUNTS;
    if (bindActive) {
        asset.activeServiceWorkflow = wf;
    }
    asset.markModified('activeServiceWorkflow');
    asset.markModified('services');
    await asset.save();

    const populated = await AssetItem.findById(asset._id)
        .populate({
            path: 'assignedTo',
            select: 'firstName lastName employeeId companyEmail workEmail',
        })
        .select(
            'assetId name plateEmirate plateNumber assignedTo services._id services.serviceReqNo services.serviceType services.remark',
        )
        .lean();
    const plate = [populated?.plateEmirate, populated?.plateNumber].filter(Boolean).join(' ').trim();
    const startLabel =
        String(remark.serviceStartDate || remark.scheduledServiceDate || '').slice(0, 10) || 'the start date';
    const detailLine = `${actorName || 'Admin'} submitted schedule/garage details for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''}. Review amount/quotation and approve (start ${startLabel}).`;
    const scheduleRows = buildShopScheduleEmailDetailRows(remark, serviceTypeLabel || 'Vehicle Service');

    await syncDashboardAction({
        requestId: asset._id,
        requestType: 'Vehicle Service Request',
        status: 'Pending',
        assignedTo: accounts._id,
        subjectEmployee: populated?.assignedTo,
        requestedByName: actorName || '',
        extra1: `${populated?.assetId || ''} — ${serviceTypeLabel || 'Service'}`,
        extra2: 'Awaiting Accounts Approve',
        extra3: dashboardMeta || '',
    });

    await sendVehicleServiceWorkflowEmail({
        recipient: accounts,
        asset: populated || asset,
        stageLabel: `${serviceTypeLabel || 'Service'} — Accounts Approve`,
        actionLabel: `${serviceTypeLabel || 'Service'} — Accounts Approve`,
        detailLine,
        detailRows: scheduleRows,
        serviceReqNo: resolveServiceReqNo(service, remark),
        linkPath: linkPath || undefined,
    }).catch((err) => {
        console.error('[ShopService] Accounts Approve email failed:', err?.message || err);
    });

    // Oil parity: Admin FYI when Accounts is next (no extra dashboard spam).
    const adminOfficer = await getDepartmentHOD('admincontroller');
    if (adminOfficer?._id && String(adminOfficer._id) !== String(accounts._id)) {
        await sendVehicleServiceWorkflowEmail({
            recipient: adminOfficer,
            asset: populated || asset,
            stageLabel: `${serviceTypeLabel || 'Service'} — sent to Accounts`,
            actionLabel: `${serviceTypeLabel || 'Service'} — Schedule submitted`,
            detailLine: `Schedule/garage details for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''} were submitted. Accounts will review next.`,
            detailRows: scheduleRows,
            serviceReqNo: resolveServiceReqNo(service, remark),
            linkPath: linkPath || undefined,
        }).catch(() => {});
    }

    return asset;
}

/**
 * Email-only schedule update to Admin Officer, HR, assigned user (Oil-style extend/reschedule).
 */
export async function notifyShopScheduleStakeholders({
    asset,
    serviceRecordId,
    remark = {},
    serviceTypeLabel = 'Vehicle Service',
    actionLabel,
    detailLine,
}) {
    const populated = await AssetItem.findById(asset._id || asset)
        .populate({
            path: 'assignedTo',
            select: 'firstName lastName employeeId companyEmail workEmail personalEmail email',
            populate: {
                path: 'primaryReportee',
                select: 'firstName lastName employeeId companyEmail workEmail',
            },
        })
        .select(
            'assetId name plateEmirate plateNumber assignedTo services._id services.serviceReqNo services.serviceType services.remark',
        )
        .lean();
    if (!populated) return;

    const adminOfficer = await getDepartmentHOD('admincontroller');
    const hr = await getDepartmentHOD('hr');
    const accounts = await getDepartmentHOD('accounts');
    const recipients = uniqRecipients([adminOfficer, hr, accounts, populated.assignedTo]);
    if (!recipients.length) return;

    const service =
        (Array.isArray(populated.services) ? populated.services : []).find(
            (s) => String(s?._id) === String(serviceRecordId),
        ) || null;
    const liveRemark = Object.keys(remark || {}).length ? remark : parseRemark(service);
    const rows = buildShopScheduleEmailDetailRows(liveRemark, serviceTypeLabel);
    const linkPath = `/HRM/Asset/Vehicle/details/${populated._id}`;

    for (const recipient of recipients) {
        await sendVehicleServiceWorkflowEmail({
            recipient,
            asset: populated,
            stageLabel: actionLabel,
            actionLabel,
            detailLine,
            detailRows: rows,
            serviceReqNo: resolveServiceReqNo(service, liveRemark),
            linkPath,
        }).catch(() => {});
    }
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
 * After Garage is submitted (or legacy Accounts garage approve) — move to scheduled_service (NO Zoho here).
 * Zoho billing happens after End Service / complete → Accounts billing → billed.
 *
 * @param {object} [options.appendActivity]
 * @param {string} [options.scheduleActivityType='accounts_approved'] activity type for timeline
 * @param {string} [options.scheduleActivityNote]
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
        scheduleActivityType = 'accounts_approved',
        scheduleActivityNote =
        'Garage and service dates approved — service scheduled (Zoho billing after End Service)',
    } = {},
) {
    const serviceRecordId = wf.serviceRecordId;
    const service = asset.services?.id?.(serviceRecordId);
    if (!service) throw new Error('Service record not found');

    const remark = parseRemark(service);
    const { startD, endD } = resolveServiceWindowDates(wf, remark);
    if (!startD || !endD) {
        throw new Error('Service start and end dates are required before scheduling.');
    }

    wf.stage = SHOP_SERVICE_SCHEDULED_STAGE;
    wf.accountsHold = null;
    wf.scheduledServiceDate = startD;
    wf.serviceWindowEndDate = endD;
    wf.serviceDurationEmailSentAt = null;
    wf.shopServiceLiveAt = null;
    wf.shopServiceScheduledNotifiedAt = null;
    wf.shopServiceLiveNotifiedAt = null;
    wf.accountsPendingSince = null;
    wf.accountsReminderAt = null;

    remark.workflowStage = SHOP_SERVICE_SCHEDULED_STAGE;
    remark.accountsApprovedAt = new Date().toISOString();
    remark.accountsApprovedByName = actorName || '';
    service.remark = JSON.stringify(remark);

    if (typeof appendActivity === 'function') {
        appendActivity(service, {
            type: scheduleActivityType,
            byName: actorName,
            note: scheduleActivityNote,
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

    return { asset, zohoBillSync: { ok: true, skipped: true, message: 'Zoho deferred until after End Service.' } };
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

/**
 * After End Service / return complete → send to Accounts for Zoho billing.
 */
export async function routeShopServiceToBillingAfterComplete(
    asset,
    serviceId,
    {
        serviceTypeLabel,
        actorName,
        linkPath,
        dashboardMeta,
        appendActivity,
    } = {},
) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    const remark = parseRemark(service);
    const { wf, bindActive } = getWorkflowContextForService(asset, serviceId);
    if (!wf) throw new Error('Workflow not found');

    remark.vehicleServiceCompleted = 'live';
    remark.vehicleServiceCompletedAt = new Date().toISOString();
    remark.serviceWorkStatus = 'complete';
    remark.workflowStage = SHOP_SERVICE_PENDING_BILLING;
    remark.serviceCompletedByName = actorName || remark.serviceCompletedByName || '';
    service.remark = JSON.stringify(remark);

    if (typeof appendActivity === 'function') {
        appendActivity(service, {
            type: 'service_completed',
            byName: actorName,
            note: `${serviceTypeLabel || 'Service'} complete — sent to Accounts for Zoho billing`,
        });
    }

    wf.stage = SHOP_SERVICE_PENDING_BILLING;
    asset.activeServiceWorkflow = wf;
    if (bindActive) {
        const { applyPostServiceOperationalState } = await import('./assetOperationalFlags.js');
        applyPostServiceOperationalState(asset, { statusBeforeService: wf.previousStatus || null });
        asset.onServiceActive = false;
    }
    asset.markModified('activeServiceWorkflow');
    asset.markModified('services');
    await asset.save();

    const accounts = await getDepartmentHOD('accounts');
    if (!accounts?._id) {
        throw new Error('No Accounts assignee is configured in the company flowchart.');
    }

    const populated = await AssetItem.findById(asset._id)
        .populate({
            path: 'assignedTo',
            select: 'firstName lastName employeeId companyEmail workEmail personalEmail email company',
            populate: { path: 'company', select: 'name' },
        })
        .lean();
    const plate = [populated?.plateEmirate, populated?.plateNumber].filter(Boolean).join(' ').trim();
    const detailLine = `${serviceTypeLabel || 'Service'} for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''} is complete. Review billing and submit to Zoho (Billed only if Zoho succeeds).`;

    await sendVehicleServiceCompletedNotificationEmail({
        asset: populated || asset,
        remark,
        service,
    });

    await syncDashboardAction({
        requestId: asset._id,
        requestType: 'Vehicle Service Request',
        status: 'Pending',
        assignedTo: accounts._id,
        actionedBy: null,
        comment: detailLine,
        subjectEmployee: populated?.assignedTo,
        requestedByName: actorName || '',
        extra1: `${populated?.assetId || ''} — ${serviceTypeLabel || 'Service'}`,
        extra2: 'Awaiting Accounts billing (Zoho)',
        extra3: dashboardMeta || '',
    });

    // Oil parity: Accounts Make Payment email (recipient + stageLabel + detail rows).
    const scheduleRows = buildShopScheduleEmailDetailRows(remark, serviceTypeLabel || 'Vehicle Service');
    await sendVehicleServiceWorkflowEmail({
        recipient: accounts,
        asset: populated || asset,
        stageLabel: `${serviceTypeLabel || 'Service'} — Make Payment`,
        actionLabel: `${serviceTypeLabel || 'Service'} — Make Payment`,
        detailLine,
        detailRows: scheduleRows,
        serviceReqNo: resolveServiceReqNo(service, remark),
        linkPath: linkPath || undefined,
    }).catch((err) => {
        console.error('[ShopService] Accounts Make Payment email failed:', err?.message || err);
    });

    return asset;
}

/**
 * Accounts billing after End Service — Zoho must succeed, then billed.
 */
export async function advanceShopBillingAfterAccountsApprove(
    asset,
    wf,
    actorName,
    { serviceTypeLabel, appendActivity } = {},
) {
    const serviceRecordId = wf.serviceRecordId;
    const service = asset.services?.id?.(serviceRecordId);
    if (!service) throw new Error('Service record not found');
    if (String(wf.stage || '').toLowerCase() !== SHOP_SERVICE_PENDING_BILLING) {
        throw new Error('Service is not awaiting Accounts billing.');
    }

    let zohoBillSync = null;
    try {
        const { syncVehicleGarageServiceToZoho } = await import('./syncVehicleGarageServiceToZoho.js');
        zohoBillSync = await syncVehicleGarageServiceToZoho({
            asset,
            service,
            serviceTypeLabel,
        });
    } catch (err) {
        zohoBillSync = { ok: false, message: err?.message || 'Zoho bill sync failed' };
        console.error('[GarageZoho] post-complete billing:', err);
    }

    asset.markModified('services');

    if (!zohoBillSync?.ok) {
        if (typeof appendActivity === 'function') {
            appendActivity(service, {
                type: 'zoho_bill_failed',
                byName: actorName,
                note: zohoBillSync?.message || 'Zoho bill failed — billing blocked',
            });
            asset.markModified('services');
        }
        await asset.save();
        throw new Error(
            zohoBillSync?.message ||
            'Zoho bill must be created successfully before status can become Billed.',
        );
    }

    const remark = parseRemark(service);
    remark.workflowStage = SHOP_SERVICE_BILLED;
    remark.billingStatus = 'billed';
    remark.accountsBillingApprovedAt = new Date().toISOString();
    remark.accountsBillingApprovedByName = actorName || '';
    service.remark = JSON.stringify(remark);

    if (typeof appendActivity === 'function') {
        appendActivity(service, {
            type: 'accounts_approved',
            byName: actorName,
            note: 'Accounts billing approved — Zoho bill created',
        });
        appendActivity(service, {
            type: 'zoho_bill_created',
            byName: actorName,
            note: zohoBillSync.message || 'Zoho bill created — Billed',
        });
    }

    wf.stage = SHOP_SERVICE_BILLED;
    wf.completedAt = new Date();
    asset.activeServiceWorkflow = wf;
    asset.markModified('activeServiceWorkflow');
    asset.markModified('services');
    await asset.save();

    await syncDashboardAction({
        requestId: asset._id,
        requestType: 'Vehicle Service Request',
        status: 'Approved',
        assignedTo: (await getDepartmentHOD('accounts'))?._id,
        actionedBy: null,
        comment: `${serviceTypeLabel || 'Service'} billed`,
        subjectEmployee: asset.assignedTo,
        requestedByName: actorName || '',
        extra1: `${asset.assetId || ''} — ${serviceTypeLabel || 'Service'}`,
        extra2: 'Billed',
        extra3: '',
    });

    // Oil parity: after Make Payment / Zoho billed → Admin TO, HR + assignee CC.
    try {
        const populated = await AssetItem.findById(asset._id)
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId companyEmail workEmail personalEmail email',
                populate: {
                    path: 'primaryReportee',
                    select: 'firstName lastName employeeId companyEmail workEmail',
                },
            })
            .select(
                'assetId name plateEmirate plateNumber assignedTo services._id services.serviceReqNo services.serviceType services.remark',
            )
            .lean();
        const adminOfficer = await getDepartmentHOD('admincontroller');
        const hr = await getDepartmentHOD('hr');
        const plate = [populated?.plateEmirate, populated?.plateNumber].filter(Boolean).join(' ').trim();
        const detailLine = `${serviceTypeLabel || 'Service'} for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''} is billed (Zoho). Service workflow is complete.`;
        const adminTo = resolveRecipientEmail(adminOfficer);
        if (adminOfficer?._id && adminTo) {
            const cc = collectCcEmails([hr, populated?.assignedTo], adminTo);
            await sendVehicleServiceWorkflowEmail({
                recipient: adminOfficer,
                asset: populated || asset,
                stageLabel: `${serviceTypeLabel || 'Service'} completed`,
                actionLabel: `${serviceTypeLabel || 'Service'} completed`,
                detailLine,
                detailRows: buildShopScheduleEmailDetailRows(remark, serviceTypeLabel || 'Vehicle Service'),
                serviceReqNo: resolveServiceReqNo(service, remark),
                cc,
            });
        }
    } catch (err) {
        console.error('[ShopService] Post-billed completion email failed:', err?.message || err);
    }

    return { asset, zohoBillSync };
}
