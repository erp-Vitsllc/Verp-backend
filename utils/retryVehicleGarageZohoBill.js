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
export async function retryVehicleGarageZohoBill(
    asset,
    serviceId,
    { serviceTypeLabel = '', reqUser = null } = {},
) {
    const service = asset?.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');

    const remark = parseRemark(service);
    const multiBills = Array.isArray(remark.zohoBills) ? remark.zohoBills : [];
    const allMultiDone =
        multiBills.length > 0 && multiBills.every((b) => String(b?.zohoBillId || '').trim());
    if (allMultiDone || (String(remark.zohoBillId || '').trim() && !multiBills.length)) {
        // Still try fines for any bill that got Zoho id but never got a fine stamp.
        try {
            const { createGarageZohoBillVehicleDamageFines } = await import(
                './createGarageZohoBillVehicleDamageFines.js'
            );
            const label =
                String(serviceTypeLabel || '').trim() ||
                String(service.serviceType || asset?.activeServiceWorkflow?.serviceTypeLabel || '').trim() ||
                'Vehicle Service';
            await createGarageZohoBillVehicleDamageFines({
                asset,
                service,
                reqUser,
                serviceTypeLabel: label,
            });
            asset.markModified('services');
            await asset.save();
        } catch (fineErr) {
            console.error(
                '[GarageZohoFine] retry (already billed) Vehicle Damage failed:',
                fineErr?.message || fineErr,
            );
        }
        return {
            ok: true,
            skipped: true,
            billId: String(remark.zohoBillId || multiBills[0]?.zohoBillId || '').trim(),
            billNumber: String(remark.zohoBillNumber || multiBills[0]?.zohoBillNumber || '').trim(),
            message: 'Zoho bill already linked for this garage service.',
        };
    }

    const approved =
        Boolean(remark.accountsApprovedAt) ||
        Boolean(remark.accountsBillingApprovedAt) ||
        Boolean(remark.vehicleServiceCompleted) ||
        Boolean(remark.shopServiceLiveAt) ||
        String(remark.workflowStage || '').toLowerCase().includes('scheduled') ||
        String(remark.workflowStage || '').toLowerCase() === 'complete' ||
        String(remark.workflowStage || '').toLowerCase() === 'pending_billing' ||
        String(remark.workflowStage || '').toLowerCase() === 'billed';
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

    if (result?.ok) {
        try {
            const { createGarageZohoBillVehicleDamageFines } = await import(
                './createGarageZohoBillVehicleDamageFines.js'
            );
            result.vehicleDamageFineSync = await createGarageZohoBillVehicleDamageFines({
                asset,
                service,
                reqUser,
                serviceTypeLabel: label,
            });
        } catch (fineErr) {
            console.error(
                '[GarageZohoFine] retry Vehicle Damage create failed:',
                fineErr?.message || fineErr,
            );
            result.vehicleDamageFineSync = {
                ok: false,
                message: fineErr?.message || 'Vehicle Damage fine create failed',
            };
        }
    }

    asset.markModified('services');
    await asset.save();

    return result;
}
