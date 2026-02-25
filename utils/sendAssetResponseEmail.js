import nodemailer from "nodemailer";

export const sendAssetResponseEmail = async ({ asset, actor, recipient, action, comment }) => {
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

        const actorName = `${actor.firstName || ""} ${actor.lastName || ""}`.trim();
        const assetName = asset.name;

        const isSelfRecipient = recipient._id?.toString() === asset.assignedTo?._id?.toString();
        const subjectRecipientPart = isSelfRecipient ? "Assigned to You" : `for ${asset.assignedTo?.firstName || "Employee"}`;

        switch (action) {
            case 'Accept':
                subject = `Asset Accepted: ${assetName} (${subjectRecipientPart})`;
                actionDescription = `has <strong>ACCEPTED</strong> the assignment of asset <strong>${assetName}</strong> ${isSelfRecipient ? 'assigned to you' : (asset.assignedTo ? `for <strong>${asset.assignedTo.firstName}</strong>` : '')}.`;
                color = "#10b981"; // emerald
                break;
            case 'Reject':
                subject = `Asset Rejected: ${assetName} (${subjectRecipientPart})`;
                actionDescription = `has <strong>REJECTED</strong> the assignment of asset <strong>${assetName}</strong> ${isSelfRecipient ? 'assigned to you' : (asset.assignedTo ? `for <strong>${asset.assignedTo.firstName}</strong>` : '')}.`;
                color = "#ef4444"; // red
                break;
            case 'AcceptWithComments':
                subject = `Asset Response: ${assetName} (${subjectRecipientPart})`;
                actionDescription = `has sent a <strong>response/comment</strong> regarding the assignment of <strong>${assetName}</strong> ${isSelfRecipient ? 'assigned to you' : (asset.assignedTo ? `for <strong>${asset.assignedTo.firstName}</strong>` : '')}.`;
                color = "#3b82f6"; // blue
                break;
        }

        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/'/g, "");
        const assetId = asset._id?.toString() || asset.id?.toString();
        const buttonUrl = `${frontendUrl}/HRM/Asset/details/${assetId}`;

        const html = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
                <div style="background-color: ${color}; color: white; padding: 30px; text-align: center;">
                    <h1 style="margin: 0; font-size: 24px;">Asset Assignment Update</h1>
                </div>
                <div style="padding: 40px;">
                    <p style="font-size: 16px;">Hello ${recipient.firstName || "User"},</p>
                    
                    <p><strong>${actorName}</strong> ${actionDescription}</p>
                    
                    ${comment ? `
                    <div style="background-color: #f1f5f9; padding: 20px; border-left: 4px solid ${color}; margin: 25px 0; border-radius: 4px;">
                        <p style="margin: 0; font-style: italic; color: #334155;">"${comment}"</p>
                    </div>
                    ` : ''}

                    <div style="background-color: #f8fafc; padding: 25px; border-radius: 8px; margin: 25px 0; border: 1px solid #e2e8f0;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 13px; text-transform: uppercase; font-weight: bold;">Asset ID</td>
                                <td style="padding: 8px 0; font-weight: bold;">${asset.assetId}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 13px; text-transform: uppercase; font-weight: bold;">Asset Name</td>
                                <td style="padding: 8px 0; font-weight: bold;">${assetName}</td>
                            </tr>
                             <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 13px; text-transform: uppercase; font-weight: bold;">Status</td>
                                <td style="padding: 8px 0; font-weight: bold; color: ${color}">${action === 'AcceptWithComments' ? 'Negotiation In Progress' : action}</td>
                            </tr>
                        </table>
                    </div>

                    <div style="text-align: center; margin-top: 30px; margin-bottom: 20px;">
                        <a href="${buttonUrl}" 
                           style="background-color: ${color}; color: #ffffff; padding: 16px 36px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; font-size: 15px; box-shadow: 0 4px 15px rgba(0,0,0, 0.1);">
                           View Asset Details
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

        console.log(`[Email Success] Asset response notification sent to ${recipientEmail}`);
        return true;
    } catch (error) {
        console.error("[Email Error] Failed to send asset response email:", error);
        return false;
    }
};
