import nodemailer from "nodemailer";
import { resolveFrontendBaseUrl, emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import { normalizePdfAttachments } from "./normalizeEmailAttachments.js";
import {
    resolveEmployeeEmailWithReporteeLoaded,
    employeeDisplayName,
} from "./resolveEmployeeEmail.js";

export const sendAssetAssignmentEmail = async ({
    asset,
    assets = [],
    employee,
    recipient,
    isBulk = false,
    assetCount = 1,
    attachments = [],
    bulkAssignmentGroupId = null,
    /** When true, email includes Accept / Reject action links (assignee must confirm in portal). */
    pendingAssignment = false,
    /** 'assignment' | 'transfer' — same handover PDF; transfer wording for reassign flows */
    notificationContext = 'assignment',
    /** transfer only: 'target' | 'target_reportee' | 'asset_controller' | 'sender' */
    transferRecipientRole = null,
    /** Optional deep link (e.g. vehicle handover assign page) */
    detailsPath = null,
    stageLabel = null,
}) => {
    try {
        const { email: recipientEmail, isFallbackToReportee, employee: resolvedRecipient } =
            await resolveEmployeeEmailWithReporteeLoaded(recipient);

        if (!recipientEmail) {
            console.warn(
                `[Email Warning] No company/work email for assignee ${recipient?.employeeId || recipient?._id} and no primary reportee business email`,
            );
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
        if (isBulk && att.length === 0) {
            console.warn('[Email Warning] Bulk assignment PDF attachment unavailable. Sending notification email without attachment.');
        }

        const employeeName = employee?.isCompany ? employee.firstName : `${employee?.firstName || ""} ${employee?.lastName || ""}`.trim();
        const assetName = isBulk ? `${assetCount} Assets` : asset.name;
        const assetIdDisplay = isBulk ? "Multiple Assets" : asset.assetId;

        const recipientRecord = resolvedRecipient || recipient;
        const isSelfAssignment =
            !employee?.isCompany && recipientRecord?._id?.toString() === employee?._id?.toString();
        const isPrimaryReporteeRecipient =
            isFallbackToReportee ||
            (!employee?.isCompany &&
                !!recipientRecord?._id &&
                !!employee?._id &&
                recipientRecord._id?.toString() !== employee._id?.toString());

        const isTransfer = notificationContext === 'transfer';
        const transferRoleNote = isTransfer
            ? transferRecipientRole === 'asset_controller'
                ? '<p style="font-size: 13px; color: #64748b;">You are receiving this as the <strong>Asset Controller</strong> for this transfer.</p>'
                : transferRecipientRole === 'sender'
                  ? '<p style="font-size: 13px; color: #64748b;">You are receiving this as the person who initiated this asset transfer.</p>'
                  : transferRecipientRole === 'target_reportee'
                    ? '<p style="font-size: 13px; color: #64748b;">You are receiving this as the <strong>primary reportee</strong> for the assignee below.</p>'
                    : ''
            : '';
        const subject = isTransfer
            ? (isSelfAssignment
                ? (isBulk
                    ? `Asset transfer: ${assetCount} items assigned to you`
                    : `Asset transferred to you: ${asset.name} (${asset.assetId})`)
                : (isBulk
                    ? `Asset transfer: ${assetCount} items for ${employeeName}`
                    : `Asset transferred to ${employeeName}: ${asset.name} (${asset.assetId})`))
            : employee?.isCompany
              ? (isBulk ? `Asset Allocation for ${employeeName}: ${assetCount} Items` : `Asset Allocated to ${employeeName}: ${asset.name} (${asset.assetId})`)
              : (isSelfAssignment
                ? (isBulk ? `New Batch Asset Assignment: ${assetCount} Items Assigned to You` : `New Asset Assigned to You: ${asset.name} (${asset.assetId})`)
                : (isBulk ? `New Batch Asset Assignment for ${employeeName}: ${assetCount} Items` : `Asset Assignment Notification for ${employeeName}: ${asset.name} (${asset.assetId})`));

        const frontendUrl = emailFrontendUrl();
        const assetId = asset._id?.toString() || asset.id?.toString();
        const buttonUrl =
            detailsPath && String(detailsPath).trim()
                ? String(detailsPath).trim()
                : isBulk && bulkAssignmentGroupId
                  ? `${frontendUrl}/HRM/Asset?bulkAssignmentGroup=${encodeURIComponent(String(bulkAssignmentGroupId))}`
                  : isBulk
                    ? `${frontendUrl}/HRM/Asset`
                    : `${frontendUrl}/HRM/Asset/details/${assetId}`;

        const acceptUrl = !isBulk && assetId ? `${buttonUrl}?assignmentRespond=Accept` : buttonUrl;
        const rejectUrl = !isBulk && assetId ? `${buttonUrl}?assignmentRespond=Reject` : buttonUrl;

        const respondButtonsHtml =
            pendingAssignment && !isBulk
                ? `
                    <div style="text-align: center; margin-top: 24px; margin-bottom: 12px;">
                        <p style="font-size: 14px; color: #64748b; margin-bottom: 16px;">Please accept or reject this assignment:</p>
                        <a href="${acceptUrl}"
                           style="background-color: #10b981; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; font-size: 14px; margin: 0 8px 8px 0;">
                           Accept
                        </a>
                        <a href="${rejectUrl}"
                           style="background-color: #ef4444; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; font-size: 14px; margin: 0 8px 8px 0;">
                           Reject
                        </a>
                    </div>
                    <p style="font-size: 12px; color: #94a3b8; text-align: center;">You will be asked to confirm after signing in to the portal.</p>
                `
                : '';

        const recipientName = employeeDisplayName(recipientRecord);
        const fallbackNote = isPrimaryReporteeRecipient
            ? `
                <div style="background-color: #fffbeb; border: 1px solid #f59e0b; color: #92400e; padding: 12px; border-radius: 8px; margin-bottom: 18px; font-size: 13px;">
                    <strong>Primary Reportee Notice:</strong> This asset is assigned under your reportee
                    <strong> ${employeeName}</strong>${employee?.employeeId ? ` (${employee.employeeId})` : ''}.
                    You are receiving this because the assignee has no company email on file; please respond on their behalf.
                </div>
            `
            : "";

        const html = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
                <div style="background-color: #2563eb; color: white; padding: 30px; text-align: center;">
                    <h1 style="margin: 0; font-size: 24px;">Asset ${isTransfer ? 'Transfer' : employee?.isCompany ? 'Allocation' : 'Assignment'}</h1>
                </div>
                <div style="padding: 40px;">
                    ${fallbackNote}
                    ${transferRoleNote}
                    <p style="font-size: 16px;">Hello ${recipientName},</p>
                    
                    <p>
                        ${isTransfer
                            ? `An ${isBulk ? 'asset batch has' : 'asset has'} been <strong>transferred</strong> to <strong>${isSelfAssignment ? 'you' : employeeName}</strong>.`
                            : `A new ${isBulk ? 'batch of assets has' : 'asset has'} been ${employee?.isCompany ? 'allocated' : 'assigned'} to <strong>${isSelfAssignment ? 'you' : employeeName}</strong>.`}
                        ${isPrimaryReporteeRecipient ? ' Please review and respond on behalf of your reportee.' : ''}
                        ${stageLabel ? `<br/><strong>Stage:</strong> ${stageLabel}` : ''}
                    </p>
                    
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

                    ${att.length ? `<p style="font-size: 13px; color: #64748b; margin-bottom: 12px;">The attached handover form includes the requester&rsquo;s name and signature. After acceptance, a completed copy with the assignee&rsquo;s name and signature is emailed and shown on the asset page.</p>` : ''}

                    <p style="font-size: 14px; color: #64748b; margin-bottom: 30px;">
                        ${isBulk && bulkAssignmentGroupId ? 'Use the button below to open the batch review: tick the assets you accept. Unticked assets are declined (returned to Unassigned, or to the prior assignee when applicable).' : pendingAssignment ? 'Review the assignment below and use Accept or Reject, or open the asset page for full details.' : 'Please log in to the portal to view the details and confirm receipt.'}
                    </p>

                    ${respondButtonsHtml}

                    <div style="text-align: center; margin-top: 30px; margin-bottom: 20px;">
                        <a href="${buttonUrl}" 
                           style="background-color: #2563eb; color: #ffffff; padding: 16px 36px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; font-size: 15px; box-shadow: 0 4px 15px rgba(37, 99, 235, 0.3);">
                           ${pendingAssignment && !isBulk ? 'View Asset Details' : 'View Assignment Details'}
                        </a>
                    </div>
                </div>
                <div style="background-color: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0;">This is an automated notification from the VeRP Asset Management System.</p>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"Asset Management" <${emailUser}>`,
            to: recipientEmail,
            subject,
            html,
            ...(att.length ? { attachments: att } : {}),
        });

        console.log(`[Email Success] Asset assignment notification sent to ${recipientEmail}`);
        return true;
    } catch (error) {
        console.error("[Email Error] Failed to send asset assignment email:", error);
        return false;
    }
};
