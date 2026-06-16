import nodemailer from 'nodemailer';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';
import { resolveEmployeeEmailTargets } from './resolveEmployeeEmail.js';
import { normalizePdfAttachments } from './normalizeEmailAttachments.js';

function outcomeText(actionType, asset, approved) {
    const original = asset?.pendingActionDetails?.originalActionType;
    if (!approved) return 'rejected — no change was made to the asset';
    if (actionType === 'Leave') return 'approved — asset is now On Leave';
    if (original === 'End of Services' || actionType === 'End of Life') {
        return 'approved — asset is now Unassigned (returned to store)';
    }
    return approved ? 'approved' : 'rejected';
}

/**
 * Notifies the transfer requester (asset owner or asset controller) when the other party
 * approves or rejects a Leave / End of Services transfer. Uses company email only.
 */
export const sendAssetTransferDecisionEmail = async ({
    asset,
    actionType,
    recipient,
    approver,
    approved,
    reason = '',
    attachments = [],
}) => {
    try {
        const { to } = resolveEmployeeEmailTargets(recipient);
        if (!to) {
            console.warn('[AssetTransferDecisionEmail] Recipient has no company email, skipping.');
            return;
        }

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;
        if (!emailUser || !emailPass) return;

        let smtpHost = process.env.SMTP_HOST || 'smtp.office365.com';
        if (emailUser.includes('@gmail.com')) smtpHost = 'smtp.gmail.com';

        const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: parseInt(process.env.SMTP_PORT, 10) || 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        });

        const frontendUrl = resolveFrontendBaseUrl();
        const link = `${frontendUrl}/HRM/Asset/details/${asset._id || asset.id}`;
        const att = normalizePdfAttachments(attachments);

        const approverName = approver
            ? `${approver.firstName || ''} ${approver.lastName || ''}`.trim() || approver.employeeId || 'Approver'
            : 'Approver';
        const recipientName = recipient
            ? `${recipient.firstName || ''} ${recipient.lastName || ''}`.trim() || recipient.employeeId || 'User'
            : 'User';

        const displayAction =
            asset?.pendingActionDetails?.originalActionType === 'End of Services'
                ? 'End of Services'
                : actionType;

        const statusLine = outcomeText(actionType, asset, approved);
        const accent = approved ? '#10b981' : '#dc2626';
        const subject = approved
            ? `Approved: ${displayAction} transfer (${asset.assetId})`
            : `Rejected: ${displayAction} transfer (${asset.assetId})`;

        const htmlContent = `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #f8f9fa; padding: 20px; border-bottom: 1px solid #eaeaea;">
                    <h2 style="color: ${accent}; margin: 0;">Asset Transfer ${approved ? 'Approved' : 'Rejected'}</h2>
                    <p style="margin: 5px 0 0; color: #666;">Asset: <strong>${asset.assetId} — ${asset.name}</strong></p>
                </div>
                <div style="padding: 20px;">
                    <p>Dear ${recipientName},</p>
                    <p><strong>${approverName}</strong> has <strong>${approved ? 'approved' : 'rejected'}</strong> your <strong>${displayAction}</strong> transfer request.</p>
                    <p>Result: <strong>${statusLine}</strong>.</p>
                    ${reason ? `<p><strong>Comment:</strong> ${reason}</p>` : ''}
                    <div style="text-align: center; margin-top: 24px;">
                        <a href="${link}" style="background-color: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">View Asset</a>
                    </div>
                </div>
            </div>`;

        await transporter.sendMail({
            fromName: approverName,
            to,
            subject,
            html: htmlContent,
            ...(att.length ? { attachments: att } : {}),
        });

        console.log(`[AssetTransferDecisionEmail] Sent to ${to} (${approved ? 'approved' : 'rejected'})`);
    } catch (error) {
        console.error('[AssetTransferDecisionEmail] Error:', error?.message || error);
    }
};

function hodDisplayAction(actionType, asset) {
    return asset?.pendingActionDetails?.originalActionType === 'End of Services'
        ? 'End of Services'
        : actionType;
}

/**
 * Notifies the asset owner's HOD (primary reportee) for Leave / End of Services transfer events.
 * Company email only.
 */
export const sendLeaveEosTransferOwnerHodEmail = async ({
    asset,
    actionType,
    owner,
    requesterName = 'User',
    phase = 'requested',
    approver = null,
    approved = null,
    reason = '',
    attachments = [],
}) => {
    try {
        const hod = owner?.primaryReportee;
        if (!hod || typeof hod !== 'object' || !hod._id) return;

        const hodId = hod._id.toString();
        if (approver?._id && approver._id.toString() === hodId) return;
        if (owner?._id && owner._id.toString() === hodId) return;

        const { to } = resolveEmployeeEmailTargets(hod);
        if (!to) {
            console.warn('[LeaveEosOwnerHodEmail] Owner HOD has no company email, skipping.');
            return;
        }

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;
        if (!emailUser || !emailPass) return;

        let smtpHost = process.env.SMTP_HOST || 'smtp.office365.com';
        if (emailUser.includes('@gmail.com')) smtpHost = 'smtp.gmail.com';

        const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: parseInt(process.env.SMTP_PORT, 10) || 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        });

        const frontendUrl = resolveFrontendBaseUrl();
        const link = `${frontendUrl}/HRM/Asset/details/${asset._id || asset.id}`;
        const att = normalizePdfAttachments(attachments);
        const displayAction = hodDisplayAction(actionType, asset);
        const ownerName = owner
            ? `${owner.firstName || ''} ${owner.lastName || ''}`.trim() || owner.employeeId || 'Asset owner'
            : 'Asset owner';
        const hodName = `${hod.firstName || ''} ${hod.lastName || ''}`.trim() || hod.employeeId || 'Manager';
        const approverName = approver
            ? `${approver.firstName || ''} ${approver.lastName || ''}`.trim() || approver.employeeId || 'Approver'
            : null;

        let subject;
        let bodyHtml;
        if (phase === 'requested') {
            subject = `FYI: ${displayAction} transfer requested — ${asset.assetId} (${ownerName})`;
            bodyHtml = `
                <p><strong>${requesterName}</strong> submitted a <strong>${displayAction}</strong> transfer to store for an asset held by your reportee <strong>${ownerName}</strong>.</p>
                <p>The request is pending approval. Asset: <strong>${asset.assetId} — ${asset.name}</strong>.</p>
                ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}`;
        } else {
            subject = `${approved ? 'Approved' : 'Rejected'}: ${displayAction} transfer — ${asset.assetId} (${ownerName})`;
            bodyHtml = `
                <p><strong>${approverName || 'Approver'}</strong> has <strong>${approved ? 'approved' : 'rejected'}</strong> the <strong>${displayAction}</strong> transfer for <strong>${ownerName}</strong>'s asset.</p>
                <p>Result: <strong>${outcomeText(actionType, asset, approved)}</strong>.</p>
                <p>Asset: <strong>${asset.assetId} — ${asset.name}</strong>.</p>
                ${reason ? `<p><strong>Comment:</strong> ${reason}</p>` : ''}`;
        }

        const htmlContent = `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #f8f9fa; padding: 20px; border-bottom: 1px solid #eaeaea;">
                    <h2 style="color: #2563eb; margin: 0;">Leave / End of Service — HOD Notification</h2>
                    <p style="margin: 5px 0 0; color: #666;">Reportee: <strong>${ownerName}</strong></p>
                </div>
                <div style="padding: 20px;">
                    <p>Dear ${hodName},</p>
                    ${bodyHtml}
                    <div style="text-align: center; margin-top: 24px;">
                        <a href="${link}" style="background-color: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">View Asset</a>
                    </div>
                </div>
            </div>`;

        await transporter.sendMail({
            fromName: requesterName || 'VeRP Asset Management',
            to,
            subject,
            html: htmlContent,
            ...(att.length ? { attachments: att } : {}),
        });

        console.log(`[LeaveEosOwnerHodEmail] Sent to ${to} (${phase})`);
    } catch (error) {
        console.error('[LeaveEosOwnerHodEmail] Error:', error?.message || error);
    }
};
