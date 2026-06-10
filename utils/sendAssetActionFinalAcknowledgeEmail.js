import nodemailer from 'nodemailer';
import { resolveFrontendBaseUrl, emailFrontendUrl } from './resolveFrontendBaseUrl.js';

/**
 * Sends an email to the Reportee (Assigned User) after a Manager has approved an EOL or Loss & Damage request.
 * The reportee must acknowledge/accept to finalize the "Out of Service" status.
 * 
 * @param {Object} asset - The asset object
 * @param {string} actionType - 'End of Life' or 'Loss and Damage'
 * @param {Object} employee - The Reportee (Assigned User)
 * @param {Object} manager - The Manager who approved
 */
export const sendAssetActionFinalAcknowledgeEmail = async (asset, actionType, employee, manager) => {
    try {
        const employeeEmail = employee.companyEmail || employee.email;
        if (!employeeEmail) {
            console.warn('[AssetEmail] Employee has no email, skipping.');
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

        const frontendUrl = resolveFrontendBaseUrl();
        // Note: reporteeAction triggers the final step in the frontend
        const link = `${frontendUrl}/HRM/Asset/details/${asset._id}?reporteeAction=${actionType === 'End of Life' ? 'eol' : 'damage'}`;

        const htmlContent = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; color: #334155; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
                <div style="background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); padding: 30px; color: white;">
                    <h2 style="margin: 0; font-size: 24px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em;">Action Required: Asset ${actionType}</h2>
                    <p style="margin: 10px 0 0; opacity: 0.9;">Acknowledgement Required to Finalize</p>
                </div>
                
                <div style="padding: 32px; background-color: #ffffff;">
                    <p style="font-size: 16px; margin-top: 0;">Dear <strong>${employee.firstName}</strong>,</p>
                    <p>The management has approved the <strong>${actionType}</strong> request for the asset assigned to you.</p>
                    
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
                                <td style="padding: 4px 0; color: #ef4444; font-weight: 800; text-align: right;">${actionType}</td>
                            </tr>
                            <tr>
                                <td style="padding: 4px 0; color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase;">Approved By</td>
                                <td style="padding: 4px 0; color: #1e293b; font-weight: 700; text-align: right;">${manager.firstName} ${manager.lastName}</td>
                            </tr>
                        </table>
                    </div>

                    <p style="font-size: 14px; line-height: 1.6; color: #475569;">To finalize this process and update the asset status to <strong>Out of Service</strong>, please click the button below to acknowledge and accept this action.</p>

                    <div style="text-align: center; margin-top: 40px;">
                        <a href="${link}" style="display: inline-block; background-color: #2563eb; color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 12px; font-weight: 800; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; box-shadow: 0 10px 15px -3px rgba(37, 99, 235, 0.3);">Acknowledge & Finalize</a>
                    </div>
                </div>
                
                <div style="background-color: #f1f5f9; padding: 20px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0;">This is an automated system notification from VeRP Asset Management.</p>
                </div>
            </div>
        `;

        await transporter.sendMail({
            fromName: `${manager.firstName} ${manager.lastName}`,
            to: employeeEmail,
            subject: `Action Required: Finalize ${actionType} for Asset ${asset.assetId}`,
            html: htmlContent
        });

        console.log(`[AssetEmail] Final acknowledgement email sent to ${employeeEmail} for ${actionType} on ${asset.assetId}`);

    } catch (error) {
        console.error('[AssetEmail] Error sending final acknowledgement email:', error);
    }
};
