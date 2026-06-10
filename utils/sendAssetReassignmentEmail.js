import nodemailer from "nodemailer";
import { resolveFrontendBaseUrl, emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import { resolveEmployeeEmailWithReporteeLoaded } from "./resolveEmployeeEmail.js";
import { normalizePdfAttachments } from "./normalizeEmailAttachments.js";

/**
 * Sends email notification to the previous assignee when an asset is reassigned (at assign time).
 * The updated handover PDF (with new assignee + acceptance) is sent after the new assignee accepts —
 * see notifyPreviousAssigneeReassignmentAcceptedWithHandover.
 */
export const sendAssetReassignmentEmail = async ({
    asset,
    previousAssignee,
    newAssignee,
    previousAssigneeType,
    newAssigneeType,
    attachments = []
}) => {
    try {
        let recipientEmail = null;
        let recipientName = '';

        if (previousAssigneeType === 'Company') {
            recipientEmail = previousAssignee?.email || previousAssignee?.companyEmail;
            recipientName = previousAssignee?.name || 'Company';
        } else {
            const resolved = await resolveEmployeeEmailWithReporteeLoaded(previousAssignee);
            recipientEmail = resolved.email;
            recipientName = `${previousAssignee?.firstName || ''} ${previousAssignee?.lastName || ''}`.trim() || 'Employee';
        }

        if (!recipientEmail) {
            console.warn(`[Email Warning] No email found for previous assignee ${previousAssignee?._id || previousAssignee?.employeeId || 'Unknown'}`);
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

        const att = normalizePdfAttachments(attachments);

        let newAssigneeName = '';
        if (newAssigneeType === 'Company') {
            newAssigneeName = newAssignee?.name || 'Company';
        } else {
            newAssigneeName = `${newAssignee?.firstName || ''} ${newAssignee?.lastName || ''}`.trim() || 'Employee';
        }

        const subject = `Asset Reassigned: ${asset.assetId} - ${asset.name}`;

        const frontendUrl = emailFrontendUrl();
        const assetId = asset._id?.toString() || asset.id?.toString();
        const buttonUrl = `${frontendUrl}/HRM/Asset/details/${assetId}`;

        const html = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
                <div style="background-color: #f59e0b; color: white; padding: 30px; text-align: center;">
                    <h1 style="margin: 0; font-size: 24px;">Asset Reassigned</h1>
                </div>
                <div style="padding: 40px;">
                    <p style="font-size: 16px;">Hello ${recipientName},</p>
                    
                    <p>Your asset has been reassigned to <strong>${newAssigneeName}</strong>.</p>
                    
                    <div style="background-color: #fef3c7; padding: 25px; border-radius: 8px; margin: 25px 0; border: 1px solid #fcd34d;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 13px; text-transform: uppercase; font-weight: bold;">Asset ID</td>
                                <td style="padding: 8px 0; font-weight: bold;">${asset.assetId}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 13px; text-transform: uppercase; font-weight: bold;">Asset Name</td>
                                <td style="padding: 8px 0; font-weight: bold;">${asset.name}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 13px; text-transform: uppercase; font-weight: bold;">Reassigned To</td>
                                <td style="padding: 8px 0; font-weight: bold;">${newAssigneeName}</td>
                            </tr>
                        </table>
                    </div>

                    ${att.length ? `<p style="font-size: 13px; color: #64748b; margin-bottom: 12px;">A PDF attachment lists the asset record at reassignment time.</p>` : ''}
                    <p style="font-size: 14px; color: #64748b; margin-bottom: 30px;">
                        When the new assignee accepts, you will receive a separate email with the updated Asset Handover form (PDF) for your records.
                    </p>

                    <div style="text-align: center; margin-top: 30px; margin-bottom: 20px;">
                        <!--[if mso]>
                        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${buttonUrl}" style="height:50px;v-text-anchor:middle;width:250px;" arcsize="16%" stroke="f" fillcolor="#f59e0b">
                          <w:anchorlock/>
                          <center>
                        <![endif]-->
                        <a href="${buttonUrl}" 
                           style="background-color: #f59e0b; color: #ffffff; padding: 16px 36px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; font-size: 15px; box-shadow: 0 4px 15px rgba(245, 158, 11, 0.3);">
                           View Asset Details
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
            fromName: "Asset Management",
            to: recipientEmail,
            subject,
            html,
            ...(att.length ? { attachments: att } : {})
        });

        console.log(`[Email Success] Asset reassignment notification sent to ${recipientEmail}`);
        return true;
    } catch (error) {
        console.error("[Email Error] Failed to send asset reassignment email:", error);
        return false;
    }
};
