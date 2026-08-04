import DashboardAction from '../models/DashboardAction.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { actorMayManageOilService } from './oilServiceWorkflow.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendVehicleServiceWorkflowEmail } from './sendVehicleServiceWorkflowEmail.js';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';

export const CAR_WASH_STAGE_ACCOUNTS = 'pending_accounts';
export const CAR_WASH_STAGE_PENDING_BILLING = 'pending_billing';
export const CAR_WASH_STAGE_COMPLETE = 'complete';
export const CAR_WASH_STAGE_BILLED = 'billed';
export const CAR_WASH_STAGE_REJECTED = 'rejected';

export const CAR_WASH_PAYMENT_PENDING = 'pending';
export const CAR_WASH_PAYMENT_NOT_PAID = 'not_paid';
export const CAR_WASH_PAYMENT_BILLED = 'billed';

export function isCarWashServiceRecord(service, wf = null) {
    if (String(wf?.serviceTypeLabel || '').trim() === 'Car Wash') return true;
    return String(service?.serviceType || '').trim() === 'Car Wash';
}

export function parseCarWashRemark(service) {
    if (!service?.remark) return {};
    if (typeof service.remark === 'object') return service.remark;
    try {
        return JSON.parse(service.remark);
    } catch {
        return {};
    }
}

export function normalizeCarWashMonthKey(ym) {
    const m = String(ym || '').trim().match(/^(\d{4})-(\d{1,2})/);
    if (!m) return '';
    const month = parseInt(m[2], 10);
    if (!month || month < 1 || month > 12) return '';
    return `${m[1]}-${String(month).padStart(2, '0')}`;
}

function isRejectedCarWashService(service, asset) {
    const serviceId = toIdString(service?._id);
    const stage = String(
        service?.workflowSnapshot?.stage ||
            (serviceId &&
            toIdString(asset?.activeServiceWorkflow?.serviceRecordId) === serviceId
                ? asset?.activeServiceWorkflow?.stage
                : '') ||
            '',
    ).toLowerCase();
    return stage === 'rejected';
}

/** Latest occupied car-wash month key (`yyyy-MM`), or empty. */
export function getLatestOccupiedCarWashMonth(asset, { excludeServiceId = null } = {}) {
    const occupied = [];
    const services = Array.isArray(asset?.services) ? asset.services : [];
    const excludeId = toIdString(excludeServiceId);
    for (const service of services) {
        if (String(service?.serviceType || '').trim() !== 'Car Wash') continue;
        if (excludeId && toIdString(service?._id) === excludeId) continue;
        if (isRejectedCarWashService(service, asset)) continue;
        const remark = parseCarWashRemark(service);
        const monthKey = normalizeCarWashMonthKey(remark.carWashMonth);
        if (monthKey) occupied.push(monthKey);
    }
    if (!occupied.length) return '';
    occupied.sort();
    return occupied[occupied.length - 1];
}

/** One car wash per vehicle per month (rejected requests do not occupy the month). */
export function findExistingCarWashForMonth(asset, month, { excludeServiceId = null } = {}) {
    const monthKey = normalizeCarWashMonthKey(month);
    if (!monthKey || !asset) return null;
    const excludeId = toIdString(excludeServiceId);
    const services = Array.isArray(asset.services) ? asset.services : [];
    for (const service of services) {
        if (String(service?.serviceType || '').trim() !== 'Car Wash') continue;
        if (excludeId && toIdString(service?._id) === excludeId) continue;
        if (isRejectedCarWashService(service, asset)) continue;
        const remark = parseCarWashRemark(service);
        if (normalizeCarWashMonthKey(remark.carWashMonth) === monthKey) {
            return service;
        }
    }
    return null;
}

function toIdString(v) {
    if (!v) return null;
    if (typeof v === 'string') return v;
    if (v._id) return v._id.toString();
    if (v.toString) return v.toString();
    return null;
}

/** Same create/manage roles as other vehicle service types. */
export async function actorMayManageCarWashRequest(reqUser, asset) {
    return actorMayManageOilService(reqUser, asset);
}

export function carWashDetailsPath(vehicleId, serviceRecordId) {
    if (!vehicleId || !serviceRecordId) return null;
    return `/HRM/Asset/Vehicle/details/${vehicleId}?tab=service&carWashServiceId=${serviceRecordId}`;
}

export function carWashDashboardMeta(asset, serviceRecordId) {
    return JSON.stringify({
        vehicleId: asset?._id ? String(asset._id) : '',
        serviceRecordId: serviceRecordId ? String(serviceRecordId) : '',
        detailsPath: carWashDetailsPath(asset?._id, serviceRecordId) || '',
        serviceType: 'Car Wash',
    });
}

export function setCarWashPaymentStatusOnService(serviceSub, status) {
    if (!serviceSub) return;
    const remark = { ...parseCarWashRemark(serviceSub), carWashPaymentStatus: status };
    serviceSub.remark = JSON.stringify(remark);
}

/** Close Accounts pending inbox rows for a car wash request. */
export async function closeCarWashPendingDashboardActions(
    assetId,
    serviceRecordId,
    { actionedBy = null, comment = 'Car wash validated' } = {},
) {
    if (!assetId) return;
    const assetObjectId = assetId?._id || assetId;
    const targetServiceId = serviceRecordId ? String(serviceRecordId) : '';

    const pendingRows = await DashboardAction.find({
        requestId: assetObjectId,
        requestType: 'Vehicle Service Request',
        status: 'Pending',
    })
        .select('_id extra3')
        .lean();

    const idsToClose = pendingRows
        .filter((row) => {
            if (!targetServiceId) return true;
            try {
                const meta = typeof row.extra3 === 'object' ? row.extra3 : JSON.parse(String(row.extra3 || '{}'));
                if (!meta?.serviceRecordId) return true;
                return String(meta.serviceRecordId) === targetServiceId;
            } catch {
                return true;
            }
        })
        .map((row) => row._id);

    if (!idsToClose.length) return;

    await DashboardAction.updateMany(
        { _id: { $in: idsToClose } },
        {
            status: 'Approved',
            actionedDate: new Date(),
            actionedBy: actionedBy || null,
            comment,
        },
    );
}

function uniqCarWashNotifyRecipients(list) {
    const seen = new Set();
    const out = [];
    for (const emp of list || []) {
        if (!emp) continue;
        const idKey = String(emp._id || emp.employeeId || '')
            .trim()
            .toLowerCase();
        const { email } = resolveEmployeeEmail(emp);
        const emailKey = String(email || '')
            .trim()
            .toLowerCase();
        const key = idKey || emailKey;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(emp);
    }
    return out;
}

/** Notify vehicle assignee and Admin Officer after Accounts approves a car wash request. */
export async function notifyCarWashAccountsApproved({
    asset,
    serviceRecordId,
    actorName = 'Accounts',
    validatedAmount = null,
} = {}) {
    try {
        if (!asset?._id) return;

        const serviceSub = serviceRecordId ? asset.services?.id?.(serviceRecordId) : null;
        const remark = parseCarWashRemark(serviceSub);
        const plate = [asset.plateEmirate, asset.plateNumber].filter(Boolean).join(' ').trim();
        const amount = validatedAmount ?? serviceSub?.value;
        const amountText =
            Number.isFinite(Number(amount)) && Number(amount) > 0
                ? ` Validated amount: AED ${Number(amount).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                  })}.`
                : '';
        const monthText = remark?.carWashMonth ? ` Car wash month: ${remark.carWashMonth}.` : '';
        const detailLine = `${actorName} stored the car wash Zoho Expense for ${asset.assetId || ''}${
            plate ? ` (${plate})` : ''
        }. Status is now Billed / Complete.${amountText}${monthText}`.trim();
        const linkPath = carWashDetailsPath(asset._id, serviceRecordId);

        let assignee = asset.assignedTo || null;
        if (assignee?._id) {
            assignee = await EmployeeBasic.findById(assignee._id)
                .select('firstName lastName employeeId companyEmail workEmail primaryReportee')
                .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail')
                .lean();
        }

        const adminOfficer = await getDepartmentHOD('admincontroller');
        const recipients = uniqCarWashNotifyRecipients([assignee, adminOfficer]);

        for (const recipient of recipients) {
            const { email } = resolveEmployeeEmail(recipient || {});
            const who =
                `${recipient?.firstName || ''} ${recipient?.lastName || ''}`.trim() ||
                recipient?.employeeId ||
                'Unknown';
            console.log(`[CarWashWorkflow][Email] Expense stored -> ${who} <${email || 'no-company-email'}>`);
            if (!email) continue;

            await sendVehicleServiceWorkflowEmail({
                recipient,
                asset,
                stageLabel: 'Car Wash — Zoho Expense stored',
                actionLabel: 'Car wash complete (Zoho Expense)',
                detailLine,
                linkPath,
            });
        }
    } catch (e) {
        console.error('[CarWashWorkflow] approve notify failed:', e);
    }
}

/**
 * Accounts stores Zoho Expense after car wash submit → billed/complete only on Zoho success.
 * Car Wash uses Expenses only (not Bills).
 */
export async function advanceCarWashBillingAfterAccountsApprove(asset, wf, actorName) {
    const serviceRecordId = wf.serviceRecordId;
    const service = asset.services?.id?.(serviceRecordId);
    if (!service) throw new Error('Service record not found');

    const stage = String(wf.stage || '').toLowerCase();
    if (stage !== CAR_WASH_STAGE_PENDING_BILLING && stage !== CAR_WASH_STAGE_ACCOUNTS) {
        throw new Error('Car wash is not awaiting Accounts Zoho Expense.');
    }

    const amount = Number(service.value);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('A valid amount is required before creating the Zoho Expense.');
    }

    const remark = parseCarWashRemark(service);
    const expenseAccountId = String(remark.expenseAccountId || '').trim();
    const paidThroughAccountId = String(remark.paidThroughAccountId || '').trim();
    if (!expenseAccountId || !paidThroughAccountId) {
        throw new Error('Expense Account and Paid Through are required before creating the Zoho Expense.');
    }
    if (expenseAccountId === paidThroughAccountId) {
        throw new Error('Expense Account and Paid Through must be different accounts.');
    }

    let zohoExpenseSync = null;
    try {
        const { syncCarWashToZohoExpense } = await import('./syncCarWashToZohoExpense.js');
        zohoExpenseSync = await syncCarWashToZohoExpense({
            asset,
            service,
            expenseAccountId,
            expenseAccountName: remark.expenseAccountName || '',
            paidThroughAccountId,
            paidThroughAccountName: remark.paidThroughAccountName || '',
            expenseName: remark.zohoExpenseName || '',
            organizationId: remark.zohoOrganizationId || '',
        });
    } catch (err) {
        zohoExpenseSync = { ok: false, message: err?.message || 'Zoho Expense sync failed' };
        console.error('[CarWash] Accounts Zoho Expense sync:', err);
    }

    asset.markModified('services');

    if (!zohoExpenseSync?.ok) {
        await asset.save();
        throw new Error(
            zohoExpenseSync?.message ||
                'Zoho Expense must be created successfully before status becomes Complete.',
        );
    }

    const liveRemark = parseCarWashRemark(asset.services.id(serviceRecordId));
    wf.stage = CAR_WASH_STAGE_BILLED;
    liveRemark.workflowStage = CAR_WASH_STAGE_BILLED;
    liveRemark.billingStatus = 'billed';
    liveRemark.carWashPaymentStatus = CAR_WASH_PAYMENT_BILLED;
    liveRemark.vehicleServiceCompleted = 'live';
    liveRemark.vehicleServiceCompletedAt = new Date().toISOString();
    liveRemark.accountsBillingApprovedAt = new Date().toISOString();
    liveRemark.accountsBillingApprovedByName = actorName || '';
    liveRemark.zohoExpenseId = zohoExpenseSync.expenseId || liveRemark.zohoExpenseId || '';
    liveRemark.zohoExpenseNumber = zohoExpenseSync.expenseNumber || '';
    liveRemark.zohoOrganizationId = zohoExpenseSync.organizationId || liveRemark.zohoOrganizationId || '';
    liveRemark.zohoExpenseName = zohoExpenseSync.expenseName || liveRemark.zohoExpenseName || '';
    liveRemark.expenseAccountId = zohoExpenseSync.expenseAccountId || expenseAccountId;
    liveRemark.expenseAccountName =
        zohoExpenseSync.expenseAccountName || liveRemark.expenseAccountName || '';
    liveRemark.paidThroughAccountId = zohoExpenseSync.paidThroughAccountId || paidThroughAccountId;
    liveRemark.paidThroughAccountName =
        zohoExpenseSync.paidThroughAccountName || liveRemark.paidThroughAccountName || '';
    asset.services.id(serviceRecordId).remark = JSON.stringify(liveRemark);

    asset.activeServiceWorkflow = wf;
    asset.markModified('activeServiceWorkflow');
    asset.markModified('services');
    await asset.save();

    await notifyCarWashAccountsApproved({
        asset,
        serviceRecordId,
        actorName,
        validatedAmount: amount,
    });

    // Keep response shape compatible with older callers (zohoBill* aliases).
    return {
        asset,
        zohoExpenseSync,
        zohoBillSync: {
            ok: true,
            billId: zohoExpenseSync.expenseId,
            message: zohoExpenseSync.message,
        },
    };
}
