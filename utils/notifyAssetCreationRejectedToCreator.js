import { syncDashboardAction } from './syncDashboard.js';
import { sendAssetCreationRejectedEmail } from './sendAssetCreationDecisionEmail.js';
import { resolveAssetCreatorEmployee, isFleetVehicleAssetFields } from './assetApprovalHelpers.js';

/**
 * After creation approval is rejected, notify the asset creator (email + dashboard / notification bar).
 */
export async function notifyAssetCreationRejectedToCreator({
    asset,
    createdByUserId,
    reviewerDisplayName,
    actionedBy,
    rejectReason = '',
    approverRole = 'assetcontroller'
}) {
    const creatorEmp = await resolveAssetCreatorEmployee(createdByUserId);
    if (!creatorEmp?._id) return;

    const fleetVehicle = isFleetVehicleAssetFields({ plateNumber: asset?.plateNumber });
    const approverLabel = approverRole === 'admin' ? 'Administrator' : approverRole === 'hr' ? 'HR' : 'Asset Controller';
    const assetLabel = `${asset?.assetId || 'Asset'} — ${asset?.name || ''}`.trim();
    const outcomeExtra1 = fleetVehicle
        ? '[Vehicle creation] HR did not approve this vehicle. It was returned to Draft — update and resubmit for HR review.'
        : `[Asset creation] Your asset was not approved by ${approverLabel}. Update details and resubmit for review.`;

    try {
        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Asset Approval',
            assignedTo: creatorEmp._id,
            status: 'Rejected',
            skipPendingCompletion: true,
            subjectEmployee: creatorEmp,
            assetCreationNotifyAssignee: creatorEmp,
            requestedByName: reviewerDisplayName || approverLabel,
            actionedBy: actionedBy || null,
            comment: rejectReason || '',
            extra1: outcomeExtra1,
            extra2: assetLabel,
            extra3: JSON.stringify({
                assetCreationViewerRole: 'creator',
                outcome: 'reject',
                assetMongoId: String(asset._id),
                isFleetVehicle: fleetVehicle,
                vehicleMongoId: fleetVehicle ? String(asset._id) : undefined,
            })
        });
    } catch (err) {
        console.error('[notifyAssetCreationRejectedToCreator] dashboard sync failed:', err?.message || err);
    }

    sendAssetCreationRejectedEmail({
        asset,
        recipient: creatorEmp,
        approverRole,
        rejectReason
    }).catch((err) => {
        console.error('[notifyAssetCreationRejectedToCreator] email failed:', err?.message || err);
    });
}
