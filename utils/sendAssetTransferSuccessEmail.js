import nodemailer from 'nodemailer';
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

        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const link = `${frontendUrl}/HRM/Asset/details/${asset._id}`;

        const actionText = actionType === 'Leave' ? 'placed On Leave' : 'marked as End of Life (Unassigned)';
        const assignedUserName = assignedUser ? `${assignedUser.firstName} ${assignedUser.lastName}` : 'Unassigned';

        const htmlContent = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; color: #334155; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
                <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; color: white;">
                    <h2 style="margin: 0; font-size: 24px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em;">Transfer Successful</h2>
                    <p style="margin: 10px 0 0; opacity: 0.9;">${actionType} approved and processed.</p>
                </div>
                
                <div style="padding: 32px; background-color: #ffffff;">
                    <p style="font-size: 16px; margin-top: 0;">Dear <strong>${assetController.firstName} ${assetController.lastName}</strong>,</p>
                    <p>You have successfully approved the <strong>${actionType}</strong> request for the asset.</p>
                    <p>The asset has been ${actionText}.</p>
                    
                    <div style="background-color: #f8fafc; padding: 24px; border-radius: 12px; margin: 24px 0; border: 1px solid #e2e8f0;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 4px 0; color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase;">Asset ID</td>
                                <td style="padding: 4px 0; color: #1e293b; font-weight: 700; text-align: right;">${asset.assetId}</td>
                            </tr>
                            <tr>
                                <td style="padding: 4px 0; color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase;">Asset Name</td>
                                <td style="padding: 4px 0; color: #1e293b; font-weight: 700; text-align: right;">${asset.name}</td>
                            </tr>
                            <tr>
                                <td style="padding: 4px 0; color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase;">Action Type</td>
                                <td style="padding: 4px 0; color: #10b981; font-weight: 800; text-align: right;">${actionType}</td>
                            </tr>
                            <tr>
                                <td style="padding: 4px 0; color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase;">Assigned To</td>
                                <td style="padding: 4px 0; color: #1e293b; font-weight: 700; text-align: right;">${assignedUserName}</td>
                            </tr>
                        </table>
                    </div>

                    ${att.length ? `<p style="font-size:13px;color:#64748b;margin:0 0 16px;">A PDF attachment lists the asset(s) processed in this approval.</p>` : ''}

                    <div style="text-align: center; margin-top: 40px;">
                        <a href="${link}" style="display: inline-block; background-color: #10b981; color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 12px; font-weight: 800; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; box-shadow: 0 10px 15px -3px rgba(16, 185, 129, 0.3);">View Asset Details</a>
                    </div>
                </div>
                
                <div style="background-color: #f1f5f9; padding: 20px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0;">This is an automated system notification from VeRP Asset Management.</p>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"VeRP Asset Management" <${emailUser}>`,
            to: controllerEmail,
            subject: `Transfer Successful: Asset ${actionType} (${asset.assetId})`,
            html: htmlContent,
            ...(att.length ? { attachments: att } : {})
        });

        console.log(`[TransferSuccessEmail] Success notification sent to Asset Controller ${controllerEmail} for ${actionType} on ${asset.assetId}`);

    } catch (error) {
        console.error('[TransferSuccessEmail] Error sending success email:', error);
    }
};
