import nodemailer from 'nodemailer';

/**
 * Sends email notification after On Duty duration completes
 * 
 * @param {Object} asset - The asset object
 * @param {Object} assignedUser - The assigned employee
 * @param {Object} assetController - The Asset Controller
 * @param {number} duration - Duration in days
 */
export const sendOnDutyDurationCompleteEmail = async (asset, assignedUser, assetController, duration) => {
    try {
        const userEmail = assignedUser.companyEmail || assignedUser.email;
        const controllerEmail = assetController.companyEmail || assetController.email;

        let toEmails = [];
        if (userEmail) toEmails.push(userEmail);
        if (controllerEmail && controllerEmail !== userEmail) toEmails.push(controllerEmail);

        if (toEmails.length === 0) {
            console.warn('[OnDutyDurationEmail] No emails found for user or controller, skipping.');
            return;
        }

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;

        if (!emailUser || !emailPass) {
            console.error('[OnDutyDurationEmail] Email credentials missing.');
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

        const htmlContent = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; color: #334155; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
                <div style="background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); padding: 30px; color: white;">
                    <h2 style="margin: 0; font-size: 24px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em;">On Duty Duration Complete</h2>
                    <p style="margin: 10px 0 0; opacity: 0.9;">Asset has completed its On Duty period.</p>
                </div>
                
                <div style="padding: 32px; background-color: #ffffff;">
                    <p style="font-size: 16px; margin-top: 0;">Dear <strong>${assignedUser.firstName} ${assignedUser.lastName}</strong>,</p>
                    <p>The asset that was set to "On Duty" has completed its duration period of <strong>${duration} day(s)</strong>.</p>
                    <p>The asset is now back in normal assigned status.</p>
                    
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
                                <td style="padding: 4px 0; color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase;">Duration</td>
                                <td style="padding: 4px 0; color: #3b82f6; font-weight: 800; text-align: right;">${duration} day(s)</td>
                            </tr>
                            <tr>
                                <td style="padding: 4px 0; color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase;">Status</td>
                                <td style="padding: 4px 0; color: #10b981; font-weight: 800; text-align: right;">Assigned</td>
                            </tr>
                        </table>
                    </div>

                    <div style="text-align: center; margin-top: 40px;">
                        <a href="${link}" style="display: inline-block; background-color: #3b82f6; color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 12px; font-weight: 800; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; box-shadow: 0 10px 15px -3px rgba(59, 130, 246, 0.3);">View Asset Details</a>
                    </div>
                </div>
                
                <div style="background-color: #f1f5f9; padding: 20px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0;">This is an automated system notification from VeRP Asset Management.</p>
                </div>
            </div>
        `;

        await transporter.sendMail({
            fromName: "Asset Management",
            to: toEmails.join(','),
            subject: `On Duty Duration Complete: Asset ${asset.assetId} (${duration} days)`,
            html: htmlContent
        });

        console.log(`[OnDutyDurationEmail] Duration completion notification sent to ${toEmails.join(', ')} for ${asset.assetId}`);

    } catch (error) {
        console.error('[OnDutyDurationEmail] Error sending duration completion email:', error);
    }
};
