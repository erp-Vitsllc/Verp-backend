import nodemailer from 'nodemailer';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';
import { resolveEmployeeEmailTargets } from './resolveEmployeeEmail.js';
import { normalizePdfAttachments } from './normalizeEmailAttachments.js';

/**
 * Notifies the L&D requester (asset owner or asset controller) when the other party
 * approves or rejects a Loss and Damage request.
 */
export const sendAssetLossDamageDecisionEmail = async ({
    asset,
    recipient,
    approver,
    approved,
    reason = '',
    attachments = [],
    accessoryLabel = '',
    displayAction = 'Loss and Damage',
}) => {
    try {
        const { to } = resolveEmployeeEmailTargets(recipient);
        if (!to) {
            console.warn('[AssetLossDamageDecisionEmail] Recipient has no company email, skipping.');
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
        const tabParam = accessoryLabel ? '&tab=accessories' : '';
        const authAction = displayAction === 'Transfer' ? 'transfer' : 'damage';
        const link = `${frontendUrl}/HRM/Asset/details/${asset._id || asset.id}?authAction=${authAction}${tabParam}`;
        const att = normalizePdfAttachments(attachments);

        const approverName = approver
            ? `${approver.firstName || ''} ${approver.lastName || ''}`.trim() || approver.employeeId || 'Approver'
            : 'Approver';
        const recipientName = recipient
            ? `${recipient.firstName || ''} ${recipient.lastName || ''}`.trim() || recipient.employeeId || 'User'
            : 'User';

        const subjectAsset = accessoryLabel
            ? `${asset.assetId} — ${accessoryLabel}`
            : `${asset.assetId} — ${asset.name}`;

        const statusLine = approved
            ? displayAction === 'Transfer'
                ? 'approved — accessory transfer completed'
                : accessoryLabel
                    ? 'approved — fine workflow will continue'
                    : 'approved — fine workflow will continue for this asset'
            : 'rejected — no change was made';

        const accent = approved ? '#10b981' : '#dc2626';
        const subject = approved
            ? `Approved: ${displayAction} (${subjectAsset})`
            : `Rejected: ${displayAction} (${subjectAsset})`;

        const htmlContent = `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #f8f9fa; padding: 20px; border-bottom: 1px solid #eaeaea;">
                    <h2 style="color: ${accent}; margin: 0;">${displayAction} ${approved ? 'Approved' : 'Rejected'}</h2>
                    <p style="margin: 5px 0 0; color: #666;">Asset: <strong>${asset.assetId} — ${asset.name}</strong></p>
                    ${accessoryLabel ? `<p style="margin: 5px 0 0; color: #666;">Accessory: <strong>${accessoryLabel}</strong></p>` : ''}
                </div>
                <div style="padding: 20px;">
                    <p>Dear ${recipientName},</p>
                    <p><strong>${approverName}</strong> has <strong>${approved ? 'approved' : 'rejected'}</strong> your <strong>${displayAction}</strong> request.</p>
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

        console.log(`[AssetLossDamageDecisionEmail] Sent to ${to} (${approved ? 'approved' : 'rejected'})`);
    } catch (error) {
        console.error('[AssetLossDamageDecisionEmail] Error:', error?.message || error);
    }
};
