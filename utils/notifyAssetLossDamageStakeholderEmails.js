import { getDepartmentHOD } from './getDepartmentHOD.js';
import { resolveAssetControllerEmployee } from './assetApprovalHelpers.js';
import { sendAssetActionApprovalEmail } from './sendAssetActionApprovalEmail.js';
import { sendAssignedEmployeeActionEmail } from './sendAssignedEmployeeActionEmail.js';
import { sendAssetLossDamageDecisionEmail } from './sendAssetLossDamageDecisionEmail.js';
import { pickEffectiveEmail } from './resolveEmployeeEmail.js';

async function loadEmployeeWithReportee(id) {
    if (!id) return null;
    const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
    return EmployeeBasic.findById(id)
        .select('firstName lastName employeeId companyEmail workEmail primaryReportee status profileStatus')
        .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail status profileStatus')
        .lean();
}

function pushUnique(list, emp) {
    if (!emp?._id) return;
    const id = String(emp._id);
    if (list.some((r) => String(r._id) === id)) return;
    list.push(emp);
}

function isSameEmployee(a, b) {
    if (!a?._id || !b?._id) return false;
    return String(a._id) === String(b._id);
}

/**
 * On L&D / accessory action request: email approver (AC) and assignee (both parties).
 * Approver already receives the approval email; assignee gets an informational copy.
 */
export async function notifyLossDamageRequestStakeholders({
    asset,
    actionType,
    approver,
    requesterName,
    reason,
    attachments = [],
    accessoryLabel = '',
    assignee = null,
    targetAssignee = null,
}) {
    const displayName = accessoryLabel
        ? `${asset.name} - Accessory: ${accessoryLabel}`
        : asset.name;

    const emailAsset = {
        ...asset,
        assetId: asset.assetId,
        name: displayName,
        _id: asset._id || asset.id,
    };

    await sendAssetActionApprovalEmail(
        emailAsset,
        accessoryLabel ? actionType : actionType,
        approver,
        { name: requesterName },
        reason || 'No reason provided',
        attachments,
    );

    const recipients = [];
    const assigneeId = assignee?._id || asset.assignedTo?._id || asset.assignedTo;
    const assigneeFull = assignee || (assigneeId ? await loadEmployeeWithReportee(assigneeId) : null);
    if (assigneeFull) pushUnique(recipients, assigneeFull);
    if (targetAssignee) pushUnique(recipients, targetAssignee);

    const acRaw = await getDepartmentHOD('assetcontroller');
    const ac = await resolveAssetControllerEmployee(acRaw);
    const acFull = ac ? await loadEmployeeWithReportee(ac._id) : null;

    for (const emp of recipients) {
        if (!emp || isSameEmployee(emp, approver)) continue;
        if (!pickEffectiveEmail(emp)) continue;
        try {
            const actionLabel = accessoryLabel
                ? `${actionType} Accessory`
                : actionType;
            const details = accessoryLabel
                ? `A ${actionType} request was submitted for accessory "${accessoryLabel}". Reason: ${reason || 'N/A'}`
                : `A ${actionType} request was submitted for your asset. Reason: ${reason || 'N/A'}`;
            await sendAssignedEmployeeActionEmail({
                asset: { ...asset, _id: asset._id || asset.id },
                employee: emp,
                action: actionLabel,
                performedBy: requesterName,
                details,
                attachments,
                customIntro: 'You are receiving this notification because both the asset holder and Asset Controller must be informed:',
            });
        } catch (e) {
            console.error('[notifyLossDamageRequestStakeholders] assignee notify:', e?.message || e);
        }
    }

    if (acFull && !isSameEmployee(acFull, approver) && !recipients.some((r) => isSameEmployee(r, acFull))) {
        try {
            await sendAssignedEmployeeActionEmail({
                asset: { ...asset, _id: asset._id || asset.id },
                employee: acFull,
                action: accessoryLabel ? `${actionType} Accessory` : actionType,
                performedBy: requesterName,
                details: accessoryLabel
                    ? `Accessory "${accessoryLabel}" — ${actionType} request is pending your review.`
                    : `${actionType} request is pending Asset Controller review.`,
                attachments,
                customIntro: 'A loss and damage / transfer notification for your awareness:',
            });
        } catch (e) {
            console.error('[notifyLossDamageRequestStakeholders] AC copy:', e?.message || e);
        }
    }
}

/**
 * On L&D approve/reject: email the original requester when they are not the approver.
 */
export async function notifyLossDamageDecisionToRequester({
    asset,
    requestedBy,
    approver,
    approved,
    reason = '',
    attachments = [],
    accessoryLabel = '',
}) {
    if (!requestedBy?._id || !approver?._id) return;
    if (isSameEmployee(requestedBy, approver)) return;

    await sendAssetLossDamageDecisionEmail({
        asset: { _id: asset._id || asset.id, assetId: asset.assetId, name: asset.name },
        recipient: requestedBy,
        approver,
        approved,
        reason,
        attachments,
        accessoryLabel,
    });
}

/**
 * Accessory transfer: notify source assignee and target assignee after approval.
 */
export async function notifyAccessoryTransferApprovedEmails({
    asset,
    targetAsset,
    accessoryName,
    performedBy,
    attachments = [],
}) {
    const sourceAssigneeId = asset.assignedTo?._id || asset.assignedTo;
    const targetAssigneeId = targetAsset.assignedTo?._id || targetAsset.assignedTo;

    const sourceAssignee = sourceAssigneeId ? await loadEmployeeWithReportee(sourceAssigneeId) : null;
    const targetAssignee = targetAssigneeId ? await loadEmployeeWithReportee(targetAssigneeId) : null;

    const details = `Accessory "${accessoryName}" was transferred from ${asset.assetId} to ${targetAsset.assetId}.`;

    for (const [emp, intro] of [
        [sourceAssignee, 'An accessory was transferred out of your asset:'],
        [targetAssignee, 'An accessory was transferred into your asset:'],
    ]) {
        if (!emp || !pickEffectiveEmail(emp)) continue;
        try {
            await sendAssignedEmployeeActionEmail({
                asset: { _id: targetAsset._id, assetId: targetAsset.assetId, name: targetAsset.name },
                employee: emp,
                action: 'Transfer Accessory',
                performedBy,
                details,
                attachments,
                customIntro: intro,
            });
        } catch (e) {
            console.error('[notifyAccessoryTransferApprovedEmails]', e?.message || e);
        }
    }
}
