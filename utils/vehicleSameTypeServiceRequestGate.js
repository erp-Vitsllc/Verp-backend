/**
 * Blocks a new vehicle service when the latest request of the same type
 * on that vehicle is not Completed. Matches the Service tab Status column.
 */

const GATED_VEHICLE_SERVICE_TYPES = new Set([
    'Oil Service',
    'Tire Change',
    'Mechanical Work',
    'Body Work',
    'Accident Repair',
    'Car Wash',
]);

const SHOP_WORK_TYPES = new Set([
    'Tire Change',
    'Mechanical Work',
    'Body Work',
    'Accident Repair',
]);

function idStr(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'object') {
        if (typeof value.$oid === 'string') return value.$oid;
        if (value._id != null && value._id !== value) return idStr(value._id);
    }
    return String(value).trim();
}

function parseRemark(service) {
    if (!service?.remark) return {};
    if (typeof service.remark === 'object') return service.remark;
    try {
        const parsed = JSON.parse(service.remark);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function serviceTypeKey(service) {
    const direct = String(service?.serviceType || '').trim();
    if (direct) return direct;
    return String(parseRemark(service)?.serviceType || '').trim();
}

function chronologyMs(service) {
    for (const candidate of [service?.createdAt, service?.date]) {
        if (candidate == null || candidate === '') continue;
        const time = new Date(candidate).getTime();
        if (Number.isFinite(time)) return time;
    }
    const id = idStr(service?._id);
    if (/^[a-f0-9]{24}$/i.test(id)) return parseInt(id.slice(0, 8), 16) * 1000;
    return 0;
}

function activeWorkflowMatch(service, asset) {
    const serviceId = idStr(service?._id);
    const workflow = asset?.activeServiceWorkflow || {};
    return Boolean(serviceId && idStr(workflow.serviceRecordId) === serviceId);
}

function oilStage(service, asset) {
    const remark = parseRemark(service);
    const remarkStage = String(remark.workflowStage || remark.stage || '').toLowerCase().trim();
    const billingStatus = String(remark.billingStatus || '').toLowerCase().trim();

    if (String(remark.vehicleServiceCompleted || '').toLowerCase() === 'live' && remarkStage) {
        if (remarkStage === 'billed' || billingStatus === 'billed') return 'billed';
        return remarkStage;
    }
    if (remarkStage === 'billed' || billingStatus === 'billed' || String(remark.zohoBillId || '').trim()) {
        return 'billed';
    }
    const workflow = asset?.activeServiceWorkflow || {};
    return String(
        (activeWorkflowMatch(service, asset) ? workflow.stage : '') ||
            service?.workflowSnapshot?.stage ||
            remarkStage ||
            '',
    )
        .toLowerCase()
        .trim();
}

function shopStage(service, asset) {
    const remark = parseRemark(service);
    const remarkStage = String(remark.workflowStage || remark.stage || '').toLowerCase().trim();
    if (String(remark.vehicleServiceCompleted || '').toLowerCase() === 'live' && remarkStage) {
        return remarkStage;
    }
    const workflow = asset?.activeServiceWorkflow || {};
    const candidates = [
        activeWorkflowMatch(service, asset) ? workflow.stage : '',
        remarkStage,
        service?.workflowSnapshot?.stage,
        remark.stage,
    ]
        .map((value) => String(value || '').toLowerCase().trim())
        .filter(Boolean);
    if (candidates.includes('pending_billing')) return 'pending_billing';
    if (candidates.includes('billed')) return 'billed';
    return candidates[0] || '';
}

function isOilTableRow(service, asset) {
    const remark = parseRemark(service);
    const requestStatus = String(remark.requestStatus || '').toLowerCase();
    if (requestStatus === 'draft' || requestStatus === 'pending' || requestStatus === 'submitted') return true;
    if (service?.workflowSnapshot?.stage) return true;
    if (activeWorkflowMatch(service, asset)) return true;
    return String(remark.vehicleServiceCompleted || '').toLowerCase() === 'live';
}

function isShopTableRow(service, asset) {
    return isOilTableRow(service, asset);
}

function isCarWashTableRow(service, asset) {
    const remark = parseRemark(service);
    const requestStatus = String(remark.requestStatus || '').toLowerCase();
    const paymentStatus = String(remark.carWashPaymentStatus || '').toLowerCase();
    if (requestStatus === 'draft' || requestStatus === 'submitted') return true;
    if (paymentStatus === 'pending' || paymentStatus === 'not_paid') return true;
    if (service?.workflowSnapshot?.stage) return true;
    const workflow = asset?.activeServiceWorkflow || {};
    return (
        activeWorkflowMatch(service, asset) &&
        String(workflow.serviceTypeLabel || '') === 'Car Wash'
    );
}

function isOilListCompleted(service, asset) {
    const remark = parseRemark(service);
    const requestStatus = String(remark.requestStatus || '').toLowerCase();
    if (requestStatus === 'draft' || requestStatus === 'pending') return false;
    const stage = oilStage(service, asset);
    const workDone = String(remark.vehicleServiceCompleted || '').toLowerCase() === 'live';
    if (stage === 'billed' || String(remark.billingStatus || '').toLowerCase() === 'billed') return true;
    if (
        stage === 'pending_billing' ||
        stage === 'complete' ||
        workDone ||
        String(remark.serviceWorkStatus || '').toLowerCase() === 'complete'
    ) {
        return true;
    }
    return stage === 'rejected';
}

function isShopListCompleted(service, asset) {
    const remark = parseRemark(service);
    const requestStatus = String(remark.requestStatus || '').toLowerCase();
    const stage = shopStage(service, asset);
    const workDone = String(remark.vehicleServiceCompleted || '').toLowerCase() === 'live';
    if (requestStatus === 'draft') return false;
    if (stage === 'billed' || String(remark.billingStatus || '').toLowerCase() === 'billed') return true;
    if (
        stage === 'pending_billing' ||
        stage === 'complete' ||
        workDone ||
        String(remark.serviceWorkStatus || '').toLowerCase() === 'complete'
    ) {
        return true;
    }
    if (requestStatus === 'pending') return false;
    return stage === 'rejected';
}

function isCarWashListCompleted(service, asset) {
    const remark = parseRemark(service);
    const requestStatus = String(remark.requestStatus || '').toLowerCase();
    if (requestStatus === 'draft') return false;
    const workflow = asset?.activeServiceWorkflow || {};
    const stage = String(
        service?.workflowSnapshot?.stage ||
            (activeWorkflowMatch(service, asset) ? workflow.stage : '') ||
            remark.workflowStage ||
            '',
    ).toLowerCase();
    const paymentStatus = String(remark.carWashPaymentStatus || '').toLowerCase();
    const billingStatus = String(remark.billingStatus || '').toLowerCase();
    if (stage === 'rejected') return true;
    if (stage === 'billed' || billingStatus === 'billed' || paymentStatus === 'billed') return true;
    if (stage === 'pending_billing' || stage === 'pending_accounts') return true;
    return paymentStatus === 'not_paid' || stage === 'complete';
}

function isListed(service, asset, serviceType) {
    if (serviceType === 'Oil Service') return isOilTableRow(service, asset);
    if (serviceType === 'Car Wash') return isCarWashTableRow(service, asset);
    if (SHOP_WORK_TYPES.has(serviceType)) return isShopTableRow(service, asset);
    return false;
}

function isCompleted(service, asset, serviceType) {
    if (serviceType === 'Oil Service') return isOilListCompleted(service, asset);
    if (serviceType === 'Car Wash') return isCarWashListCompleted(service, asset);
    if (SHOP_WORK_TYPES.has(serviceType)) return isShopListCompleted(service, asset);
    return true;
}

export function sameTypeVehicleServiceRequestBlockMessage(serviceType) {
    const type = String(serviceType || 'service').trim() || 'service';
    return `The latest ${type} for this vehicle is still pending. Request another ${type} only after it is completed.`;
}

/** @returns {string|null} Error message when a new same-type request must be refused. */
export function getSameTypeVehicleServiceRequestBlock(asset, serviceType) {
    const type = String(serviceType || '').trim();
    if (!GATED_VEHICLE_SERVICE_TYPES.has(type)) return null;

    const latest = (Array.isArray(asset?.services) ? asset.services : [])
        .filter((service) => serviceTypeKey(service) === type)
        .filter((service) => isListed(service, asset, type))
        .sort((a, b) => {
            const timeA = chronologyMs(a);
            const timeB = chronologyMs(b);
            if (timeA !== timeB) return timeB - timeA;
            return idStr(b?._id).localeCompare(idStr(a?._id));
        })[0];

    if (!latest || isCompleted(latest, asset, type)) return null;
    return sameTypeVehicleServiceRequestBlockMessage(type);
}
