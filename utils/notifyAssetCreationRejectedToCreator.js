import { syncDashboardAction } from './syncDashboard.js';
import { sendAssetCreationRejectedEmail } from './sendAssetCreationDecisionEmail.js';
import { resolveAssetCreatorEmployee } from './assetApprovalHelpers.js';

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

    const assetLabel = `${asset?.assetId || 'Asset'} — ${asset?.name || ''}`.trim();
    const outcomeExtra1 =
        '[Asset creation] Your asset was not approved. Update details and resubmit for Asset Controller review.';

    try {
        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Asset Approval',
            assignedTo: String(creatorEmp._id),
            status: 'Rejected',
            skipPendingCompletion: true,
            subjectEmployee: creatorEmp,
            assetCreationNotifyAssignee: creatorEmp,
            requestedByName: reviewerDisplayName || 'Asset Controller',
            actionedBy: actionedBy || null,
            comment: rejectReason || '',
            extra1: outcomeExtra1,
            extra2: assetLabel,
            extra3: JSON.stringify({
                assetCreationViewerRole: 'creator',
                outcome: 'reject',
                assetMongoId: String(asset._id)
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
