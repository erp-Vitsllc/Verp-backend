import nodemailer from 'nodemailer';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';

/**
 * Sends an email to the Reporting Authority requesting approval for Asset End of Life or Loss & Damage.
 * 
 * @param {Object} asset - The asset object
 * @param {string} actionType - 'End of Life' or 'Loss and Damage'
 * @param {Object} manager - The Manager (Reporting Authority) employee object
 * @param {Object} requester - The person requesting (Assigned User)
 * @param {string} reason - The reason provided
 */
export const sendAssetActionApprovalEmail = async (asset, actionType, manager, requester, reason) => {
    try {
        const { email: managerEmail } = resolveEmployeeEmail(manager);
        if (!managerEmail) {
            console.warn('[AssetEmail] Manager has no email, skipping.');
            return;
        }

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;

        if (!emailUser || !emailPass) {
            console.error('[AssetEmail] Email credentials missing.');
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
        const authAction =
            actionType === 'End of Life' ? 'eol' :
            actionType === 'Transfer' ? 'transfer' :
            actionType === 'Add Accessory' || actionType === 'Update Accessory' || actionType === 'Unattach Accessory' ? 'accessory' :
            'damage';
        const tabParam = (actionType === 'Unattach Accessory' || actionType === 'Add Accessory' || actionType === 'Update Accessory')
            ? '&tab=accessories'
            : '';
        const link = `${frontendUrl}/HRM/Asset/details/${asset._id}?authAction=${authAction}${tabParam}`;

        const htmlContent = `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #f8f9fa; padding: 20px; border-bottom: 1px solid #eaeaea;">
                    <h2 style="color: ${['Transfer', 'Add Accessory', 'Update Accessory', 'Unattach Accessory'].includes(actionType) ? '#2563eb' : '#dc3545'}; margin: 0;">Asset Action Notification</h2>
                    <p style="margin: 5px 0 0; color: #666;">Asset: <strong>${asset.assetId} - ${asset.name}</strong></p>
                </div>
                
                <div style="padding: 20px;">
                    <p>Dear ${manager.firstName},</p>
                    <p><strong>${requester.name}</strong> has performed an action on the Following asset: <strong>${actionType}</strong>.</p>
                    
                    <div style="background-color: #fff5f5; padding: 15px; border-radius: 6px; margin: 20px 0; border: 1px solid #fed7d7;">
                        <p><strong>Asset ID:</strong> ${asset.assetId}</p>
                        <p><strong>Asset Name:</strong> ${asset.name}</p>
                        <p><strong>Request Type:</strong> ${actionType}</p>
                        <p><strong>Reason:</strong> ${reason}</p>
                    </div>

                    <p>Action Item Details for review:</p>

                    <div style="text-align: center; margin-top: 30px;">
                        <a href="${link}" style="background-color: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Review & Details</a>
                    </div>
                </div>
                
                <div style="background-color: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #999; border-top: 1px solid #eaeaea;">
                    This is an automated system notification from VeRP.
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"VeRP Asset Management" <${emailUser}>`,
            to: managerEmail,
            subject: `Approval Required: ${actionType} Request for ${asset.assetId}`,
            html: htmlContent
        });

        console.log(`[AssetEmail] Approval email sent to ${managerEmail} for ${actionType} on ${asset.assetId}`);

    } catch (error) {
        console.error('[AssetEmail] Error sending email:', error);
    }
};
