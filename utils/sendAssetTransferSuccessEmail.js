import nodemailer from 'nodemailer';
import { resolveFrontendBaseUrl, emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import { normalizePdfAttachments } from './normalizeEmailAttachments.js';

/**
 * Sends success email to Asset Controller after approving a transfer (Leave/End of Life)
 * 
 * @param {Object} asset - The asset object
 * @param {string} actionType - 'Leave' or 'End of Life'
 * @param {Object} assetController - The Asset Controller employee object
 * @param {Object} assignedUser - The assigned user (if exists)
 */
export const sendAssetTransferSuccessEmail = async (asset, actionType, assetController, assignedUser, attachments = []) => {
    try {
        const att = normalizePdfAttachments(attachments);

        const controllerEmail = assetController.companyEmail || assetController.email;
        if (!controllerEmail) {
            console.warn('[TransferSuccessEmail] Asset Controller has no email, skipping.');
            return;
        }

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;

        if (!emailUser || !emailPass) {
            console.error('[TransferSuccessEmail] Email credentials missing.');
            return;
        }

        let smtpHost = process.env.SMTP_HOST || "smtp.office365.com";
        if (emailUser.includes('@gmail.com')) smtpHost = "smtp.gmail.com";

        const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: parseInt(process.env.SMTP_PORT) || 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass }
        });

        const frontendUrl = resolveFrontendBaseUrl();
        const link = `${frontendUrl}/HRM/Asset/details/${asset._id}`;

        const actionText = actionType === 'Leave' ? 'placed On Leave' : 'marked as End of Life (Unassigned)';
        const assignedUserName = assignedUser ? `${assignedUser.firstName} ${assignedUser.lastName}` : 'Unassigned';
        const ctrlName = `${assetController.firstName || ''} ${assetController.lastName || ''}`.trim() || 'Asset Controller';

        const textContent = [
            `Transfer successful — ${actionType}`,
            '',
            `Dear ${ctrlName},`,
            '',
            `You approved the ${actionType} request. The asset has been ${actionText}.`,
            '',
            `Asset ID: ${asset.assetId}`,
            `Name: ${asset.name}`,
            `Action: ${actionType}`,
            `Assigned to: ${assignedUserName}`,
            '',
            att.length ? 'The attached Asset Handover Form lists the asset(s) processed in this approval.' : '',
            '',
            `Asset link: ${link}`,
            '',
            '— VeRP Asset Management'
        ]
            .filter(Boolean)
            .join('\n');

        const htmlContent = `
            <div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.45; color: #1e293b; max-width: 560px;">
                <p style="margin: 0 0 12px 0;"><strong>Transfer successful</strong> — ${actionType}</p>
                <p style="margin: 0 0 10px 0;">Dear ${ctrlName},</p>
                <p style="margin: 0 0 10px 0;">You approved the <strong>${actionType}</strong> request. The asset has been ${actionText}.</p>
                <table style="border-collapse: collapse; font-size: 13px; margin: 12px 0 14px 0;">
                    <tr><td style="padding: 2px 16px 2px 0; color: #64748b;">Asset ID</td><td style="padding: 2px 0;">${asset.assetId}</td></tr>
                    <tr><td style="padding: 2px 16px 2px 0; color: #64748b;">Name</td><td style="padding: 2px 0;">${asset.name}</td></tr>
                    <tr><td style="padding: 2px 16px 2px 0; color: #64748b;">Action</td><td style="padding: 2px 0;">${actionType}</td></tr>
                    <tr><td style="padding: 2px 16px 2px 0; color: #64748b;">Assigned to</td><td style="padding: 2px 0;">${assignedUserName}</td></tr>
                </table>
                ${att.length ? `<p style="margin: 0 0 10px 0; font-size: 13px; color: #64748b;">The attached <strong>Asset Handover Form</strong> lists the asset(s) processed in this approval.</p>` : ''}
                <p style="margin: 0 0 4px 0; font-size: 13px;"><a href="${link}" style="color: #0369a1;">View asset in VeRP</a></p>
                <p style="margin: 16px 0 0 0; font-size: 12px; color: #94a3b8;">Automated message — VeRP Asset Management</p>
            </div>
        `;

        await transporter.sendMail({
            fromName: ctrlName,
            to: controllerEmail,
            subject: `Transfer successful: ${actionType} (${asset.assetId})`,
            text: textContent,
            html: htmlContent,
            ...(att.length ? { attachments: att } : {})
        });

        console.log(`[TransferSuccessEmail] Success notification sent to Asset Controller ${controllerEmail} for ${actionType} on ${asset.assetId}`);

    } catch (error) {
        console.error('[TransferSuccessEmail] Error sending success email:', error);
    }
};
