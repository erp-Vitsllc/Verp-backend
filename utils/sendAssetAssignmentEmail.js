import nodemailer from "nodemailer";

export const sendAssetAssignmentEmail = async ({ asset, employee, recipient, isBulk = false, assetCount = 1 }) => {
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

        const employeeName = `${employee.firstName || ""} ${employee.lastName || ""}`.trim();
        const assetName = isBulk ? `${assetCount} Assets` : asset.name;
        const assetIdDisplay = isBulk ? "Multiple Assets" : asset.assetId;

        const subject = isBulk
            ? `New Batch Asset Assignment: ${assetCount} Items`
            : `Asset Assignment Notification: ${asset.name} (${asset.assetId})`;

        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/'/g, "");
        const assetId = asset._id?.toString() || asset.id?.toString();
        const buttonUrl = isBulk
            ? `${frontendUrl}/HRM/Asset`
            : `${frontendUrl}/HRM/Asset/details/${assetId}`;

        console.log(`[Email Debug] Generating button URL: ${buttonUrl}`);

        const html = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
                <div style="background-color: #2563eb; color: white; padding: 30px; text-align: center;">
                    <h1 style="margin: 0; font-size: 24px;">Asset Assignment</h1>
                </div>
                <div style="padding: 40px;">
                    <p style="font-size: 16px;">Hello,</p>
                    
                    <p>A new ${isBulk ? 'batch of assets has' : 'asset has'} been assigned to <strong>${employeeName}</strong>.</p>
                    
                    <div style="background-color: #f8fafc; padding: 25px; border-radius: 8px; margin: 25px 0; border: 1px solid #e2e8f0;">
                        <table style="width: 100%; border-collapse: collapse;">
                            ${!isBulk ? `
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 13px; text-transform: uppercase; font-weight: bold;">Asset ID</td>
                                <td style="padding: 8px 0; font-weight: bold;">${assetIdDisplay}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 13px; text-transform: uppercase; font-weight: bold;">Asset Name</td>
                                <td style="padding: 8px 0; font-weight: bold;">${assetName}</td>
                            </tr>
                            ` : `
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 13px; text-transform: uppercase; font-weight: bold;">Batch Size</td>
                                <td style="padding: 8px 0; font-weight: bold;">${assetCount} Items</td>
                            </tr>
                            `}
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 13px; text-transform: uppercase; font-weight: bold;">Category</td>
                                <td style="padding: 8px 0; font-weight: bold;">${asset.categoryId?.name || asset.category || 'Asset'}</td>
                            </tr>
                        </table>
                    </div>

                    <p style="font-size: 14px; color: #64748b; margin-bottom: 30px;">
                        Please log in to the portal to view the details and confirm receipt.
                    </p>

                    <div style="text-align: center; margin-top: 30px; margin-bottom: 20px;">
                        <!--[if mso]>
                        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${buttonUrl}" style="height:50px;v-text-anchor:middle;width:250px;" arcsize="16%" stroke="f" fillcolor="#2563eb">
                          <w:anchorlock/>
                          <center>
                        <![endif]-->
                        <a href="${buttonUrl}" 
                           style="background-color: #2563eb; color: #ffffff; padding: 16px 36px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; font-size: 15px; box-shadow: 0 4px 15px rgba(37, 99, 235, 0.3);">
                           View Assignment Details
                        </a>
                        <!--[if mso]>
                          </center>
                        </v:roundrect>
                        <![endif]-->
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

        console.log(`[Email Success] Asset assignment notification sent to ${recipientEmail}`);
        return true;
    } catch (error) {
        console.error("[Email Error] Failed to send asset assignment email:", error);
        return false;
    }
};
