/**
 * Shared pending vs completed rule for vehicle services.
 *
 * Pending: Draft, Request Initiated, Awaiting HR/Accounts, Ready/Scheduled, On Service.
 * Completed: Complete, Billed, Rejected (and billing/payment after work is done).
 */

const VEHICLE_SERVICE_TYPES = new Set([
    'Oil Service',
    'Tire Change',
    'Mechanical Work',
    'Body Work',
    'Accident Repair',
    'Car Wash',
]);

function parseServiceRemark(service) {
    if (!service?.remark || typeof service.remark !== 'string') return {};
    try {
        const parsed = JSON.parse(service.remark);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function serviceTypeOf(service) {
    const st = String(service?.serviceType || '').trim();
    if (st) return st;
    const remark = parseServiceRemark(service);
    return String(remark.serviceType || remark.serviceTypeLabel || '').trim();
}

export function isPendingVehicleService(asset, service) {
    if (!service) return false;
    const remark = parseServiceRemark(service);
    const requestStatus = String(remark.requestStatus || '').toLowerCase();
    const serviceStatus = String(remark.serviceStatus || remark.accidentServiceStatus || '')
        .toLowerCase()
        .replace(/\s+/g, '_');
    const workStatus = String(remark.serviceWorkStatus || '')
        .toLowerCase()
        .replace(/\s+/g, '_');
    const billingStatus = String(remark.billingStatus || '').toLowerCase();
    const zohoPaymentStatus = String(remark.zohoPaymentStatus || '').toLowerCase();
    const zohoBillStatus = String(remark.zohoBillStatus || '').toLowerCase();
    const carWashPay = String(remark.carWashPaymentStatus || '').toLowerCase();
    const completedFlag = String(remark.vehicleServiceCompleted || '').toLowerCase();
    const isCarWash =
        String(service.serviceType || '').trim() === 'Car Wash' ||
        String(remark.serviceTypeLabel || '').trim() === 'Car Wash';

    const activeWf = asset?.activeServiceWorkflow || {};
    const activeMatch =
        activeWf?.serviceRecordId && String(activeWf.serviceRecordId) === String(service._id || '');
    const stage = String(
        service?.workflowSnapshot?.stage ||
            (activeMatch ? activeWf.stage : '') ||
            remark.workflowStage ||
            remark.stage ||
            '',
    )
        .toLowerCase()
        .trim();

    if (stage === 'rejected' || stage === 'cancelled' || stage === 'canceled') return false;

    if (
        billingStatus === 'paid' ||
        zohoPaymentStatus === 'paid' ||
        zohoBillStatus === 'paid' ||
        carWashPay === 'paid'
    ) {
        return false;
    }

    const zohoBills = Array.isArray(remark.zohoBills) ? remark.zohoBills : [];
    const hasZohoBill =
        Boolean(String(remark.zohoBillId || remark.zohoBillNumber || '').trim()) ||
        zohoBills.some((row) =>
            Boolean(String(row?.zohoBillId || row?.bill_id || row?.billId || row?.zohoBillNumber || '').trim()),
        );
    if (billingStatus === 'billed' || stage === 'billed' || carWashPay === 'billed' || hasZohoBill) {
        return false;
    }

    if (['live', 'complete', 'completed'].includes(completedFlag)) return false;
    if (['complete', 'completed', 'pending_billing'].includes(stage)) return false;
    if (serviceStatus === 'complete' || serviceStatus === 'completed') return false;
    if (workStatus === 'complete' || workStatus === 'completed') return false;

    if (isCarWash && (stage === 'pending_accounts' || Boolean(carWashPay))) return false;

    if (['draft', 'pending', 'submitted'].includes(requestStatus)) return true;
    if (activeMatch && stage) return true;
    if (stage) return true;
    return false;
}

export function countVehicleServicePendingCompleted(asset) {
    const services = Array.isArray(asset?.services) ? asset.services : [];
    let pendingServiceCount = 0;
    let completedServiceCount = 0;
    for (const service of services) {
        const type = serviceTypeOf(service);
        if (type && !VEHICLE_SERVICE_TYPES.has(type)) continue;
        if (isPendingVehicleService(asset, service)) {
            pendingServiceCount += 1;
            continue;
        }
        if (type) completedServiceCount += 1;
    }
    return { pendingServiceCount, completedServiceCount };
}
