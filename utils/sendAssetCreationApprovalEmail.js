import nodemailer from "nodemailer";

export const sendAssetCreationApprovalEmail = async ({ asset, recipient, creatorName, isBulk = false, assetCount = 1 }) => {
    try {
        const recipientEmail = recipient.companyEmail || recipient.workEmail || recipient.email;
        if (!recipientEmail) {
            console.warn(`[Email Warning] No email found for recipient ${recipient.employeeId || recipient._id}`);
            return;
        }

        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();

        if (!emailUser || !emailPass) {
            console.error("[Email Error] Email credentials are not configured.");
            return;
        }

        const transporter = nodemailer.createTransport({
            host: "smtp.office365.com",
            port: 587,
            secure: false,
            auth: {
                user: emailUser,
                pass: emailPass
            }
        });

        const assetName = isBulk ? `${assetCount} Assets` : asset.name;
        const subject = `New Asset Approval Required: ${assetName}`;

        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/'/g, "");
        const assetId = asset._id?.toString() || asset.id?.toString();

        // Redirection button to asset details page
        const buttonUrl = `${frontendUrl}/HRM/Asset/details/${assetId}`;

        const recipientName = recipient.firstName || "Asset Controller";

        const html = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
                <div style="background-color: #f59e0b; color: white; padding: 30px; text-align: center;">
                    <h1 style="margin: 0; font-size: 24px;">Asset Creation Approval</h1>
                </div>
                <div style="padding: 40px;">
                    <p style="font-size: 16px;">Hello ${recipientName},</p>
                    
                    <p>A new asset creation request has been submitted by <strong>${creatorName}</strong> and requires your approval.</p>
                    
                    <div style="background-color: #fffbeb; padding: 25px; border-radius: 8px; margin: 25px 0; border: 1px solid #fef3c7;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 8px 0; color: #92400e; font-size: 13px; text-transform: uppercase; font-weight: bold;">Asset Profile</td>
                                <td style="padding: 8px 0; font-weight: bold;">${assetName}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #92400e; font-size: 13px; text-transform: uppercase; font-weight: bold;">Action Type</td>
                                <td style="padding: 8px 0; font-weight: bold;">Manual Creation (Draft)</td>
                            </tr>
                            ${isBulk ? `
                            <tr>
                                <td style="padding: 8px 0; color: #92400e; font-size: 13px; text-transform: uppercase; font-weight: bold;">Batch Quantity</td>
                                <td style="padding: 8px 0; font-weight: bold;">${assetCount} Items</td>
                            </tr>
                            ` : ''}
                        </table>
                    </div>

                    <p style="font-size: 14px; color: #64748b; margin-bottom: 30px;">
                        Please review the asset details to either approve or reject the creation request.
                    </p>

                    <div style="text-align: center; margin-top: 30px; margin-bottom: 20px;">
                        <a href="${buttonUrl}" 
                           style="background-color: #f59e0b; color: #ffffff; padding: 16px 36px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; font-size: 15px; box-shadow: 0 4px 15px rgba(245, 158, 11, 0.3);">
                           View & Respond to Request
                        </a>
                    </div>
                </div>
                <div style="background-color: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0;">This is an automated notification from the VeRP Asset Management System.</p>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"VeRP Asset Management" <${emailUser}>`,
            to: recipientEmail,
            subject,
            html
        });

        console.log(`[Email Success] Asset creation approval email sent to ${recipientEmail}`);
        return true;
    } catch (error) {
        console.error("[Email Error] Failed to send asset creation approval email:", error);
        return false;
    }
};
