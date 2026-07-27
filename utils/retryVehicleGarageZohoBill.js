import { syncVehicleGarageServiceToZoho } from './syncVehicleGarageServiceToZoho.js';

function parseRemark(service) {
    try {
        return service?.remark ? JSON.parse(service.remark) : {};
    } catch {
        return {};
    }
}

/**
 * Retry Zoho bill create after Accounts approve when the first attempt failed
 * (e.g. missing bill_number). Safe no-op if bill already linked.
 */
export async function retryVehicleGarageZohoBill(asset, serviceId, { serviceTypeLabel = '' } = {}) {
    const service = asset?.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');

    const remark = parseRemark(service);
    if (String(remark.zohoBillId || '').trim()) {
        return {
            ok: true,
            skipped: true,
            billId: String(remark.zohoBillId).trim(),
            billNumber: String(remark.zohoBillNumber || '').trim(),
            message: 'Zoho bill already linked for this garage service.',
        };
    }

    const approved =
        Boolean(remark.accountsApprovedAt) ||
        Boolean(remark.vehicleServiceCompleted) ||
        Boolean(remark.shopServiceLiveAt) ||
        String(remark.workflowStage || '').toLowerCase().includes('scheduled') ||
        String(remark.workflowStage || '').toLowerCase() === 'complete';
    if (!approved) {
        throw new Error(
            'Garage Zoho bill can only be created after Accounts approval (or oil service completion).',
        );
    }

    const label =
        String(serviceTypeLabel || '').trim() ||
        String(service.serviceType || asset?.activeServiceWorkflow?.serviceTypeLabel || '').trim() ||
        'Vehicle Service';

    const result = await syncVehicleGarageServiceToZoho({
        asset,
        service,
        serviceTypeLabel: label,
        organizationId: String(remark.zohoOrganizationId || '').trim(),
    });

    asset.markModified('services');
    await asset.save();

    return result;
}
