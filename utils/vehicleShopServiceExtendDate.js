import {
    actorMayManageOilService,
    actorMayManageTireChangeRequest,
    getRequesterName,
    isOilServiceWorkflowRecord,
    updateOilServiceEndDateExtend,
} from './oilServiceWorkflow.js';
import { SHOP_SERVICE_TYPE_LABELS } from './vehicleShopServiceScheduled.js';
import { isReqUserSystemSuperUser } from './systemSuperUser.js';
import {
    commitWorkflowContext,
    getWorkflowContextForService,
} from './vehicleServiceWorkflowResolve.js';

const BLOCKED_STAGES = new Set(['complete', 'rejected']);

function parseRemark(service) {
    try {
        return service?.remark ? JSON.parse(service.remark) : {};
    } catch {
        return {};
    }
}

function isSubmittedRemark(remark) {
    const status = String(remark?.requestStatus || '').toLowerCase();
    return status === 'submitted' || status === 'approved';
}

function appendShopServiceActivity(service, entry) {
    const remark = parseRemark(service);
    const log = Array.isArray(remark.tireActivityLog) ? remark.tireActivityLog : [];
    log.push({ ...entry, at: new Date().toISOString() });
    remark.tireActivityLog = log;
    service.remark = JSON.stringify(remark);
}

export function isExtendDateServiceType(serviceTypeLabel) {
    const label = String(serviceTypeLabel || '').trim();
    return label === 'Oil Service' || SHOP_SERVICE_TYPE_LABELS.includes(label);
}

export async function userMayExtendServiceEndDate(reqUser, asset, serviceId) {
    if (await isReqUserSystemSuperUser(reqUser)) return true;
    if (!asset || !serviceId) return false;

    const service = asset.services?.id?.(serviceId);
    if (!service) return false;

    const { wf } = getWorkflowContextForService(asset, serviceId);
    if (!wf) return false;
    if (!isExtendDateServiceType(wf.serviceTypeLabel)) return false;

    const stage = String(wf.stage || '').toLowerCase();
    if (BLOCKED_STAGES.has(stage)) return false;

    const remark = parseRemark(service);
    if (!isSubmittedRemark(remark)) return false;

    if (String(wf.serviceTypeLabel || '').trim() === 'Oil Service') {
        return actorMayManageOilService(reqUser, asset);
    }

    return actorMayManageTireChangeRequest(reqUser, asset);
}

export async function updateShopServiceExtendDate(asset, serviceId, { serviceEndDate }, reqUser) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');

    const { wf, bindActive } = getWorkflowContextForService(asset, serviceId);
    if (!wf) {
        throw new Error('No workflow found for this service.');
    }
    if (!isExtendDateServiceType(wf.serviceTypeLabel)) {
        throw new Error('This service type does not support extend date updates.');
    }

    const endDate = String(serviceEndDate || '').trim().slice(0, 10);
    if (!endDate) throw new Error('Extend date is required');

    const parsedEnd = new Date(endDate);
    if (Number.isNaN(parsedEnd.getTime())) throw new Error('Invalid extend date');

    const { assertServiceScheduleDates, normalizeServiceScheduleDate } = await import(
        './vehicleServiceScheduleDates.js'
    );
    const existingRemark = parseRemark(service);
    const startKey = normalizeServiceScheduleDate(
        existingRemark.serviceStartDate ||
            existingRemark.scheduledServiceDate ||
            wf.scheduledServiceDate,
    );
    assertServiceScheduleDates(startKey, endDate, {
        requireBoth: Boolean(startKey),
        requireStartFromToday: false,
    });

    if (String(wf.serviceTypeLabel || '').trim() === 'Oil Service') {
        if (!isOilServiceWorkflowRecord(wf, service)) {
            throw new Error('Not an oil service workflow.');
        }
        await updateOilServiceEndDateExtend(asset, serviceId, { serviceEndDate: endDate }, reqUser);
        return asset;
    }

    const remark = parseRemark(service);
    const prevEnd = String(remark.serviceEndDate || remark.serviceWindowEndDate || '').slice(0, 10);
    const actorName = await getRequesterName(reqUser);

    remark.serviceEndDate = endDate;
    remark.serviceWindowEndDate = endDate;
    remark.serviceReturnDate = endDate;
    remark.accidentReturnDate = endDate;

    wf.serviceWindowEndDate = parsedEnd;
    wf.serviceDurationEmailSentAt = null;

    if (prevEnd && prevEnd !== endDate) {
        appendShopServiceActivity(service, {
            type: 'date_change',
            byName: actorName,
            note: 'Extend date updated',
            field: 'end',
            from: prevEnd,
            to: endDate,
        });
    }

    service.remark = JSON.stringify(remark);
    commitWorkflowContext(asset, serviceId, { wf, bindActive });
    asset.markModified('services');
    await asset.save();

    // One formal scheduled letter (same as Schedule/Reschedule) — no duplicate workflow blast.
    if (prevEnd && prevEnd !== endDate) {
        try {
            const { sendFormalVehicleServiceScheduledAfterAdminSchedule } = await import(
                './vehicleShopServiceScheduled.js'
            );
            await sendFormalVehicleServiceScheduledAfterAdminSchedule({
                asset,
                serviceRecordId: serviceId,
                serviceTypeLabel: String(wf.serviceTypeLabel || service.serviceType || 'Vehicle Service'),
            });
        } catch (err) {
            console.error('[ShopService] Extend date email failed:', err?.message || err);
        }
    }

    return asset;
}
