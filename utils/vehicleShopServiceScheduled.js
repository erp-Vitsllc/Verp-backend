import AssetItem from '../models/AssetItem.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';
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

/** Company / work only — never personalEmail (birthday mails only). */
function resolveRecipientEmail(emp) {
    if (!emp) return '';
    return String(resolveEmployeeEmail(emp).email || '').trim();
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

    // Formal "Vehicle Service Scheduled Notification" is sent when Admin completes
    // Schedule/Reschedule (see sendFormalVehicleServiceScheduledAfterAdminSchedule) — not here after Accounts.

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
 * Open Accounts Approve after HR (Oil-style) — Schedule/garage is NOT required.
 * Also used after Admin submits garage when Accounts was not opened yet (legacy pending_admin_officer).
 * Accounts approve then calls advanceShopServiceToScheduledAfterAccountsApprove.
 * Ready / On Service still waits for BOTH Accounts approve + Schedule dates.
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
        openedBy = 'garage', // 'hr' | 'garage'
    } = {},
) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    const remark = parseRemark(service);
    const { wf, bindActive } = getWorkflowContextForService(asset, serviceId);
    if (!wf) throw new Error('Workflow not found');

    // Already opened / past Accounts Approve — do not re-open or re-email.
    const stageNow = String(wf.stage || '').toLowerCase();
    if (
        String(remark.accountsOpenedAt || '').trim() ||
        String(remark.accountsApprovedAt || '').trim() ||
        stageNow === SHOP_SERVICE_SCHEDULED_STAGE ||
        stageNow === SHOP_SERVICE_PENDING_BILLING ||
        stageNow === SHOP_SERVICE_BILLED
    ) {
        return asset;
    }

    const accounts = await getDepartmentHOD('accounts');
    if (!accounts?._id) {
        throw new Error('No Accounts assignee is configured in the company flowchart.');
    }

    const hr = await getDepartmentHOD('hr');
    // Close HR's Schedule/HR open task when Accounts opens (HR already approved).
    if (hr?._id) {
        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Service Request',
            status: 'Approved',
            assignedTo: hr._id,
            actionedBy: null,
            comment: 'HR approved — Accounts Approve opened',
            subjectEmployee: asset.assignedTo,
            requestedByName: actorName || '',
            extra1: `${asset.assetId || ''} — ${serviceTypeLabel || 'Service'}`,
            extra2: 'HR approved',
            extra3: dashboardMeta || '',
        });
    }

    remark.workflowStage = SHOP_SERVICE_PENDING_ACCOUNTS;
    if (openedBy === 'garage') {
        remark.accountsGarageSubmittedAt = new Date().toISOString();
    }
    remark.accountsOpenedAt = remark.accountsOpenedAt || new Date().toISOString();
    service.remark = JSON.stringify(remark);

    if (typeof appendActivity === 'function') {
        appendActivity(service, {
            type: openedBy === 'hr' ? 'hr_approved' : 'garage_updated',
            byName: actorName,
            note:
                openedBy === 'hr'
                    ? `${serviceTypeLabel || 'Service'} HR approved — Accounts Approve opened (Schedule may still be open)`
                    : `${serviceTypeLabel || 'Service'} scheduled details submitted — awaiting Accounts Approve`,
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
        String(remark.serviceStartDate || remark.scheduledServiceDate || '').slice(0, 10) || '';
    const detailLine =
        openedBy === 'hr'
            ? `HR approved ${serviceTypeLabel || 'service'} for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''}. Review amount/quotation and approve${startLabel ? ` (start ${startLabel})` : ''}. Schedule/Reschedule may still be completed in parallel by Admin.`
            : `${actorName || 'Admin'} submitted schedule/garage details for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''}. Review amount/quotation and approve${startLabel ? ` (start ${startLabel})` : ''}.`;
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
            actionLabel:
                openedBy === 'hr'
                    ? `${serviceTypeLabel || 'Service'} — HR approved`
                    : `${serviceTypeLabel || 'Service'} — Schedule submitted`,
            detailLine:
                openedBy === 'hr'
                    ? `HR approved ${serviceTypeLabel || 'service'} for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''}. Accounts will review next. Complete Schedule/Reschedule if not done yet — Ready/On Service needs both.`
                    : `Schedule/garage details for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''} were submitted. Accounts will review next.`,
            detailRows: scheduleRows,
            serviceReqNo: resolveServiceReqNo(service, remark),
            linkPath: linkPath || undefined,
        }).catch(() => {});
    }

    return asset;
}

/**
 * After Schedule/garage is saved while Accounts already approved — move to scheduled_service.
 * Used when HR opened Accounts first and Admin finishes Schedule later (oil parallel).
 */
export async function maybeAdvanceShopToScheduledAfterGarageIfAccountsDone(
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
    if (!service) return asset;
    const remark = parseRemark(service);
    const { wf } = getWorkflowContextForService(asset, serviceId);
    if (!wf) return asset;

    const accountsDone = Boolean(String(remark.accountsApprovedAt || '').trim());
    if (!accountsDone) return asset;

    const stage = String(wf.stage || '').toLowerCase();
    if (stage === SHOP_SERVICE_SCHEDULED_STAGE || stage === SHOP_SERVICE_PENDING_BILLING || stage === SHOP_SERVICE_BILLED) {
        return asset;
    }

    const { startD, endD } = resolveServiceWindowDates(wf, remark);
    if (!startD || !endD) return asset;

    return advanceShopServiceToScheduledAfterAccountsApprove(asset, wf, actorName, {
        serviceTypeLabel,
        linkPath,
        dashboardMeta,
        appendActivity,
        scheduleActivityType: 'garage_updated',
        scheduleActivityNote:
            'Schedule completed after Accounts Approve — service scheduled (Zoho billing after End Service)',
        skipAccountsStamp: true,
    });
}

/**
 * Formal "Vehicle Service Scheduled Notification" after Admin completes Schedule / Reschedule.
 * TO assigned · CC Admin Officer + HR + Accounts + driven-by.
 * (Not sent after Accounts approval.)
 */
export async function sendFormalVehicleServiceScheduledAfterAdminSchedule({
    asset,
    serviceRecordId,
    serviceTypeLabel = 'Vehicle Service',
} = {}) {
    const populated = await AssetItem.findById(asset._id || asset)
        .populate({
            path: 'assignedTo',
            select: 'firstName lastName employeeId companyEmail workEmail personalEmail email company',
            populate: [
                {
                    path: 'primaryReportee',
                    select: 'firstName lastName employeeId companyEmail workEmail',
                },
                { path: 'company', select: 'name' },
            ],
        })
        .lean();
    if (!populated) return { ok: false, reason: 'no-asset' };

    const service =
        (Array.isArray(populated.services) ? populated.services : []).find(
            (s) => String(s?._id) === String(serviceRecordId),
        ) || null;
    const remark = parseRemark(service);

    return sendVehicleServiceScheduledNotificationEmail({
        asset: populated,
        remark,
        service,
        serviceTypeLabel: serviceTypeLabel || service?.serviceType || 'Vehicle Service',
    });
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
        'Accounts approved — service scheduled when Schedule dates are set (Zoho billing after End Service)',
        skipAccountsStamp = false,
    } = {},
) {
    const serviceRecordId = wf.serviceRecordId;
    const service = asset.services?.id?.(serviceRecordId);
    if (!service) throw new Error('Service record not found');

    const remark = parseRemark(service);
    if (!skipAccountsStamp && String(remark.accountsApprovedAt || '').trim()) {
        throw new Error('Accounts has already approved this service.');
    }
    if (!skipAccountsStamp) {
        remark.accountsApprovedAt = new Date().toISOString();
        remark.accountsApprovedByName = actorName || '';
    }

    const { startD, endD } = resolveServiceWindowDates(wf, remark);

    // Oil parity: Accounts may approve before Schedule is complete.
    // Ready / On Service only after BOTH Accounts stamp + start/end dates.
    if (!startD || !endD) {
        remark.workflowStage = SHOP_SERVICE_PENDING_ACCOUNTS;
        service.remark = JSON.stringify(remark);
        wf.stage = SHOP_SERVICE_PENDING_ACCOUNTS;
        asset.activeServiceWorkflow = wf;
        asset.markModified('activeServiceWorkflow');
        asset.markModified('services');
        await asset.save();

        if (typeof appendActivity === 'function') {
            appendActivity(service, {
                type: scheduleActivityType,
                byName: actorName,
                note: 'Accounts approved quotation — awaiting Schedule/Reschedule dates before Ready / On Service',
            });
            asset.markModified('services');
            await asset.save();
        }

        const accounts = await getDepartmentHOD('accounts');
        if (accounts?._id) {
            await syncDashboardAction({
                requestId: asset._id,
                requestType: 'Vehicle Service Request',
                status: 'Approved',
                assignedTo: accounts._id,
                comment: 'Accounts approved — awaiting Schedule dates',
                subjectEmployee: asset.assignedTo,
                requestedByName: actorName || '',
                extra1: `${asset.assetId || ''} — ${serviceTypeLabel || 'Service'}`,
                extra2: 'Accounts approved — awaiting Schedule',
                extra3: dashboardMeta || '',
            });
        }

        const adminOfficer = await getDepartmentHOD('admincontroller');
        const populated = await AssetItem.findById(asset._id)
            .populate('assignedTo', 'firstName lastName employeeId companyEmail workEmail')
            .lean();
        const plate = [populated?.plateEmirate, populated?.plateNumber].filter(Boolean).join(' ').trim();
        if (adminOfficer?._id) {
            await syncDashboardAction({
                requestId: asset._id,
                requestType: 'Vehicle Service Request',
                status: 'Pending',
                assignedTo: adminOfficer._id,
                subjectEmployee: populated?.assignedTo,
                requestedByName: actorName || '',
                extra1: `${populated?.assetId || ''} — ${serviceTypeLabel || 'Service'}`,
                extra2: 'Complete Schedule/Reschedule (Accounts already approved)',
                extra3: dashboardMeta || '',
            });
            await sendVehicleServiceWorkflowEmail({
                recipient: adminOfficer,
                asset: populated || asset,
                stageLabel: `${serviceTypeLabel || 'Service'} — Schedule required`,
                actionLabel: `${serviceTypeLabel || 'Service'} — Schedule required`,
                detailLine: `Accounts approved ${serviceTypeLabel || 'service'} for ${populated?.assetId || ''}${plate ? ` (${plate})` : ''}. Complete Schedule/Reschedule so the vehicle can go Ready / On Service.`,
                detailRows: buildShopScheduleEmailDetailRows(remark, serviceTypeLabel || 'Vehicle Service'),
                serviceReqNo: resolveServiceReqNo(service, remark),
                linkPath: linkPath || undefined,
            }).catch(() => {});
        }

        return {
            asset,
            waitingForSchedule: true,
            zohoBillSync: { ok: true, skipped: true, message: 'Zoho deferred until after End Service.' },
        };
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
    if (!skipAccountsStamp) {
        remark.accountsApprovedAt = remark.accountsApprovedAt || new Date().toISOString();
        remark.accountsApprovedByName = remark.accountsApprovedByName || actorName || '';
    }
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

    const accountsHod = await getDepartmentHOD('accounts');
    if (accountsHod?._id && !skipAccountsStamp) {
        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Service Request',
            status: 'Approved',
            assignedTo: accountsHod._id,
            comment: 'Accounts approved — service scheduled',
            subjectEmployee: asset.assignedTo,
            requestedByName: actorName || '',
            extra1: `${asset.assetId || ''} — ${serviceTypeLabel || 'Service'}`,
            extra2: 'Accounts approved',
            extra3: dashboardMeta || '',
        });
    }

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
    // Ready / On Service only after Accounts Approve + Schedule dates.
    if (!String(remark.accountsApprovedAt || '').trim()) return false;
    const { startD, endD } = resolveServiceWindowDates(wf, remark);
    if (!startD || !endD) return false;

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
    wf.serviceWorkCompleted = true;
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

    // Complete Service → clear Admin inbox; Zoho / Make Payment stays Accounts-only.
    try {
        const { closeAdminOfficerServiceTrackNotification } = await import(
            './vehicleServiceAdminOfficerNotification.js'
        );
        await closeAdminOfficerServiceTrackNotification({
            assetId: asset._id,
            serviceRecordId: serviceId,
            comment: `${serviceTypeLabel || 'Service'} complete — Accounts billing`,
            requestedByName: actorName || '',
        });
    } catch (closeErr) {
        console.error(
            '[ShopService] Close Admin Officer on complete failed:',
            closeErr?.message || closeErr,
        );
    }

    return asset;
}

/**
 * Accounts billing after End Service — Zoho must succeed, then billed.
 */
export async function advanceShopBillingAfterAccountsApprove(
    asset,
    wf,
    actorName,
    { serviceTypeLabel, appendActivity, reqUser = null } = {},
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

    // Vehicle Damage fine(s) from bill payables — only after Zoho success.
    let vehicleDamageFineSync = null;
    try {
        const { createGarageZohoBillVehicleDamageFines } = await import(
            './createGarageZohoBillVehicleDamageFines.js'
        );
        vehicleDamageFineSync = await createGarageZohoBillVehicleDamageFines({
            asset,
            service,
            reqUser,
            serviceTypeLabel,
        });
    } catch (fineErr) {
        console.error(
            '[GarageZohoFine] post-bill Vehicle Damage create failed:',
            fineErr?.message || fineErr,
        );
        vehicleDamageFineSync = {
            ok: false,
            message: fineErr?.message || 'Vehicle Damage fine create failed',
        };
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
        if (vehicleDamageFineSync?.count > 0) {
            appendActivity(service, {
                type: 'vehicle_damage_fines_created',
                byName: actorName,
                note:
                    vehicleDamageFineSync.message ||
                    `Vehicle Damage fine(s) created (${vehicleDamageFineSync.count})`,
            });
        }
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

    // Idempotent — Admin track already cleared on Complete; safe if still open.
    try {
        const { closeAdminOfficerServiceTrackNotification } = await import(
            './vehicleServiceAdminOfficerNotification.js'
        );
        await closeAdminOfficerServiceTrackNotification({
            assetId: asset._id,
            serviceRecordId,
            comment: `${serviceTypeLabel || 'Service'} billed`,
            requestedByName: actorName || '',
        });
    } catch (closeErr) {
        console.error('[ShopService] Close Admin Officer track failed:', closeErr?.message || closeErr);
    }

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

    return { asset, zohoBillSync, vehicleDamageFineSync };
}
