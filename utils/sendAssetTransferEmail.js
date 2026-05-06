import nodemailer from 'nodemailer';

/**
 * Sends email notification for asset transfer request
 * 
 * @param {Object} asset - The asset object
 * @param {Object} fromEmployee - The current asset holder
 * @param {Object} toEmployee - The target employee receiving the asset
 * @param {Object} approver - The person who needs to approve (Asset Controller or Reporting Authority)
 * @param {Object} requester - The person requesting the transfer
 * @param {boolean} toEmployeeIsUser - Whether the target employee has a user account
 */
export const sendAssetTransferEmail = async (asset, fromEmployee, toEmployee, approver, requester, toEmployeeIsUser = true) => {
    try {
        const approverEmail = approver.companyEmail || approver.email;
        if (!approverEmail) {
            console.warn('[AssetTransferEmail] Approver has no email, skipping.');
            return;
        }

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;

        if (!emailUser || !emailPass) {
            console.error('[AssetTransferEmail] Email credentials missing.');
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
        const link = `${frontendUrl}/HRM/Asset/details/${asset._id}?authAction=transfer`;

        const htmlContent = `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #f8f9fa; padding: 20px; border-bottom: 1px solid #eaeaea;">
                    <h2 style="color: #2563eb; margin: 0;">Asset Transfer Approval Required</h2>
                    <p style="margin: 5px 0 0; color: #666;">Asset: <strong>${asset.assetId} - ${asset.name}</strong></p>
                </div>
                
                <div style="padding: 20px;">
                    <p>Dear ${approver.firstName},</p>
                    <p><strong>${requester.firstName} ${requester.lastName}</strong> has requested to transfer the following asset:</p>
                    
                    <div style="background-color: #f0f8ff; padding: 15px; border-radius: 6px; margin: 20px 0; border: 1px solid #b3d9ff;">
                        <p><strong>Asset ID:</strong> ${asset.assetId}</p>
                        <p><strong>Asset Name:</strong> ${asset.name}</p>
                        <p><strong>From:</strong> ${fromEmployee ? `${fromEmployee.firstName} ${fromEmployee.lastName}` : 'Unassigned'}</p>
                        <p><strong>To:</strong> ${toEmployee.firstName} ${toEmployee.lastName}</p>
                        <p><strong>Transfer Type:</strong> Individual</p>
                    </div>

                    ${!toEmployeeIsUser ? `
                    <div style="background-color: #fff3cd; padding: 15px; border-radius: 6px; margin: 20px 0; border: 1px solid #ffeaa7;">
                        <p><strong>Note:</strong> The target employee (${toEmployee.firstName} ${toEmployee.lastName}) does not have a user account. Their reporting authority can approve this transfer on their behalf.</p>
                    </div>
                    ` : ''}

                    <p>Please review this transfer request and take appropriate action.</p>

                    <div style="text-align: center; margin-top: 30px;">
                        <a href="${link}" style="background-color: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Review & Approve</a>
                    </div>
                </div>
                
                <div style="background-color: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #999; border-top: 1px solid #eaeaea;">
                    This is an automated system notification from VeRP.
                </div>
            </div>
        `;

        await transporter.sendMail({
            fromName: `${requester.firstName} ${requester.lastName}`,
            to: approverEmail,
            subject: `Asset Transfer Approval: ${asset.assetId} to ${toEmployee.firstName} ${toEmployee.lastName}`,
            html: htmlContent
        });

        console.log(`[AssetTransferEmail] Transfer notification sent to ${approverEmail} for ${asset.assetId}`);

    } catch (error) {
        console.error('[AssetTransferEmail] Error sending email:', error);
    }
};
