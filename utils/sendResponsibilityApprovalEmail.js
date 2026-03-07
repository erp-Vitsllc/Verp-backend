import nodemailer from "nodemailer";

export const sendResponsibilityApprovalEmail = async ({ employee, companyName, category, requestId, unassignedAssets = [] }) => {
    try {
        const recipientEmail = employee.companyEmail || employee.email;
        if (!recipientEmail) {
            console.warn(`[Email Warning] No email found for employee ${employee.employeeId}`);
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

        const subject = `New Responsibility Assigned: ${category} for ${companyName}`;
        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/'/g, "");
        const buttonUrl = `${frontendUrl}/Dashboard?requestId=${requestId}`;

        // Format unassigned assets list
        const assetsListHtml = unassignedAssets.length > 0
            ? `<div style="margin-top: 20px; padding: 20px; background-color: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
                <p style="font-weight: bold; margin-top: 0;">Unassigned Assets you will be responsible for:</p>
                <ul style="padding-left: 20px; margin-bottom: 0;">
                    ${unassignedAssets.slice(0, 10).map(a => `<li>${a.assetId}: ${a.name}</li>`).join('')}
                    ${unassignedAssets.length > 10 ? `<li>...and ${unassignedAssets.length - 10} more</li>` : ''}
                </ul>
               </div>`
            : '';

        const html = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
                <div style="background-color: #5174FF; color: white; padding: 30px; text-align: center;">
                    <h1 style="margin: 0; font-size: 24px;">Responsibility Assignment</h1>
                </div>
                <div style="padding: 40px;">
                    <p style="font-size: 16px;">Hello ${employee.firstName},</p>
                    
                    <p>You have been assigned as the <strong>${category}</strong> for <strong>${companyName}</strong>.</p>
                    
                    ${assetsListHtml}

                    <p style="font-size: 14px; color: #64748b; margin: 30px 0;">
                        Please click the button below to approve or decline this responsibility. Once approved, these assets will show up in your Assets tab.
                    </p>

                    <div style="text-align: center; margin-top: 30px; margin-bottom: 20px;">
                        <a href="${buttonUrl}" 
                           style="background-color: #5174FF; color: #ffffff; padding: 16px 36px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; font-size: 15px; box-shadow: 0 4px 15px rgba(81, 116, 255, 0.3);">
                           Review & Approve Responsibility
                        </a>
                    </div>
                </div>
                <div style="background-color: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0;">This is an automated notification from the VeRP System.</p>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"VeRP System" <${emailUser}>`,
            to: recipientEmail,
            subject,
            html
        });

        console.log(`[Email Success] Responsibility approval email sent to ${recipientEmail}`);
        return true;
    } catch (error) {
        console.error("[Email Error] Failed to send responsibility approval email:", error);
        return false;
    }
};
