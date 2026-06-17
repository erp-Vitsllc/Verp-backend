import EmployeeBasic from '../models/EmployeeBasic.js';
import { syncDashboardAction } from './syncDashboard.js';

/**
 * After Asset Controller rejects a Loss & Damage request, notify the original
 * requester via the dashboard / notification bar (email is sent separately).
 */
export async function notifyLossDamageRejectedToRequester({
    asset,
    requesterId,
    reviewerDisplayName = 'Asset Controller',
    actionedBy = null,
    rejectReason = '',
    accessoryLabel = '',
}) {
    if (!asset?._id || !requesterId) return;

    const requester = await EmployeeBasic.findById(requesterId)
        .select('_id employeeId firstName lastName companyEmail workEmail')
        .lean();
    if (!requester?._id) return;

    const assigneeId = asset.assignedTo?._id || asset.assignedTo;
    const subjectEmp = assigneeId
        ? await EmployeeBasic.findById(assigneeId)
            .select('_id employeeId firstName lastName')
            .lean()
        : requester;

    const assetLabel = accessoryLabel
        ? `${asset.assetId || 'Asset'} — ${asset.name || ''} (Accessory: ${accessoryLabel})`
        : `${asset.assetId || 'Asset'} — ${asset.name || ''}`.trim();

    const outcomeExtra1 = accessoryLabel
        ? `[Loss & Damage] Accessory request rejected — you may update and submit again.`
        : `[Loss & Damage] Your request was rejected — you may update and submit again.`;

    try {
        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Asset Loss Damage',
            assignedTo: requester._id,
            status: 'Rejected',
            skipPendingCompletion: true,
            subjectEmployee: subjectEmp || requester,
            lossDamageNotifyAssignee: requester,
            requestedByName: reviewerDisplayName,
            actionedBy,
            comment: rejectReason || '',
            extra1: outcomeExtra1,
            extra2: assetLabel,
            extra3: JSON.stringify({
                lossDamageViewerRole: 'requester',
                outcome: 'reject',
                ...(accessoryLabel ? { accessoryLabel } : {}),
            }),
        });
    } catch (err) {
        console.error('[notifyLossDamageRejectedToRequester] dashboard sync failed:', err?.message || err);
    }
}
