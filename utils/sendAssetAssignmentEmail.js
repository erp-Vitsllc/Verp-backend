import nodemailer from "nodemailer";
import { resolveEmployeeEmail, getFallbackEmailNote } from "./resolveEmployeeEmail.js";

export const sendAssetAssignmentEmail = async ({ asset, assets = [], employee, recipient, isBulk = false, assetCount = 1 }) => {
    try {
        // Use resolveEmployeeEmail: when recipient (employee) has no email, fallback to primaryReportee
        const recipientForResolve = recipient?.primaryReportee ? recipient : { ...recipient, primaryReportee: employee?.primaryReportee };
        const { email: recipientEmail, isFallbackToReportee, employeeName: fallbackEmployeeName, reporteeName } = resolveEmployeeEmail(recipientForResolve);
        if (!recipientEmail) {
            console.warn(`[Email Warning] No email found for recipient ${recipient?.employeeId || recipient?._id}`);
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

        const employeeName = employee?.isCompany ? employee.firstName : `${employee?.firstName || ""} ${employee?.lastName || ""}`.trim();
        const assetName = isBulk ? `${assetCount} Assets` : asset.name;
        const assetIdDisplay = isBulk ? "Multiple Assets" : asset.assetId;

        const isSelfAssignment = !employee?.isCompany && recipient._id?.toString() === employee?._id?.toString();

        const subject = employee?.isCompany
            ? (isBulk ? `Asset Allocation for ${employeeName}: ${assetCount} Items` : `Asset Allocated to ${employeeName}: ${asset.name} (${asset.assetId})`)
            : (isSelfAssignment
                ? (isBulk ? `New Batch Asset Assignment: ${assetCount} Items Assigned to You` : `New Asset Assigned to You: ${asset.name} (${asset.assetId})`)
                : (isBulk ? `New Batch Asset Assignment for ${employeeName}: ${assetCount} Items` : `Asset Assignment Notification for ${employeeName}: ${asset.name} (${asset.assetId})`));

        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/'/g, "");
        const assetId = asset._id?.toString() || asset.id?.toString();
        const buttonUrl = isBulk
            ? `${frontendUrl}/HRM/Asset`
            : `${frontendUrl}/HRM/Asset/details/${assetId}`;

        console.log(`[Email Debug] Generating button URL: ${buttonUrl}`);

        const recipientName = isFallbackToReportee ? reporteeName : (recipient.firstName || "User");
        const fallbackNote = isFallbackToReportee ? getFallbackEmailNote(fallbackEmployeeName, reporteeName) : '';

        const html = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
                <div style="background-color: #2563eb; color: white; padding: 30px; text-align: center;">
                    <h1 style="margin: 0; font-size: 24px;">Asset ${employee?.isCompany ? 'Allocation' : 'Assignment'}</h1>
                </div>
                <div style="padding: 40px;">
                    ${fallbackNote}
                    <p style="font-size: 16px;">Hello ${recipientName},</p>
                    
                    <p>A new ${isBulk ? 'batch of assets has' : 'asset has'} been ${employee?.isCompany ? 'allocated' : 'assigned'} to <strong>${isSelfAssignment ? 'you' : employeeName}</strong>.</p>
                    
                    <div style="background-color: #f8fafc; padding: 25px; border-radius: 8px; margin: 25px 0; border: 1px solid #e2e8f0;">
                        <table style="width: 100%; border-collapse: collapse;">
                            ${assets && assets.length > 0 ? `
                            <thead>
                                <tr>
                                    <th style="padding: 10px 5px; text-align: left; color: #64748b; font-size: 11px; text-transform: uppercase;">Asset ID</th>
                                    <th style="padding: 10px 5px; text-align: left; color: #64748b; font-size: 11px; text-transform: uppercase;">Name</th>
                                    <th style="padding: 10px 5px; text-align: left; color: #64748b; font-size: 11px; text-transform: uppercase;">Category</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${assets.map(a => `
                                <tr>
                                    <td style="padding: 8px 5px; border-top: 1px solid #e2e8f0; font-size: 13px;">${a.assetId || 'N/A'}</td>
                                    <td style="padding: 8px 5px; border-top: 1px solid #e2e8f0; font-size: 13px;">${a.name}</td>
                                    <td style="padding: 8px 5px; border-top: 1px solid #e2e8f0; font-size: 13px; color: #64748b;">${a.categoryId?.name || a.category || 'Asset'}</td>
                                </tr>
                                `).join('')}
                            </tbody>
                            ` : (!isBulk ? `
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 13px; text-transform: uppercase; font-weight: bold;">Asset ID</td>
                                <td style="padding: 8px 0; font-weight: bold;">${assetIdDisplay}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 13px; text-transform: uppercase; font-weight: bold;">Asset Name</td>
                                <td style="padding: 8px 0; font-weight: bold;">${assetName}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 13px; text-transform: uppercase; font-weight: bold;">Category</td>
                                <td style="padding: 8px 0; font-weight: bold;">${asset.categoryId?.name || asset.category || 'Asset'}</td>
                            </tr>
                            ` : `
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 13px; text-transform: uppercase; font-weight: bold;">Batch Size</td>
                                <td style="padding: 8px 0; font-weight: bold;">${assetCount} Items</td>
                            </tr>
                            `)}
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
