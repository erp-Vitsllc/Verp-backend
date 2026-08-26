import nodemailer from "nodemailer";
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import {
    resolveEmployeeEmailWithReporteeLoaded,
    employeeDisplayName,
} from "./resolveEmployeeEmail.js";
import {
    buildEmailDedupeKey,
    sendErpEmail,
} from "./emailDispatch.js";

export const sendAssetAssignmentEmail = async ({
    asset,
    assets = [],
    employee,
    recipient,
    isBulk = false,
    assetCount = 1,
    attachments = [],
    bulkAssignmentGroupId = null,
    /** When true, email prompts assignee to review and respond inside ERP (no direct action buttons). */
    pendingAssignment = false,
    /** 'assignment' | 'transfer' — transfer wording for reassign flows */
    notificationContext = 'assignment',
    /** transfer only: 'target' | 'target_reportee' | 'asset_controller' | 'sender' */
    transferRecipientRole = null,
    /** Optional deep link (e.g. vehicle handover assign page) */
    detailsPath = null,
    stageLabel = null,
    /** Optional extra dedupe segment (e.g. handover history id) */
    dedupeEvent = '',
}) => {
    try {
        const { email: recipientEmail, isFallbackToReportee, employee: resolvedRecipient } =
            await resolveEmployeeEmailWithReporteeLoaded(recipient);

        if (!recipientEmail) {
            console.warn(
                `[Email Warning] No company/work email for assignee ${recipient?.employeeId || recipient?._id} and no primary reportee business email`,
            );
            return false;
        }

        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();

        if (!emailUser || !emailPass) {
            console.error("[Email Error] Email credentials are not configured.");
            return false;
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
        const recordId = asset._id?.toString() || asset.id?.toString() || '';

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

                    <p style="font-size: 13px; color: #64748b; margin-bottom: 12px;">
                        The handover form (if applicable) is available on the asset page in ERP — it is not attached to this email.
                    </p>

                    <p style="font-size: 14px; color: #64748b; margin-bottom: 30px;">
                        ${isBulk && bulkAssignmentGroupId
                            ? 'Open the batch in ERP to review each asset.'
                            : pendingAssignment
                              ? 'Open the asset page in ERP to review the assignment and complete your response after signing in.'
                              : 'Open the asset page in ERP to view details and download any handover documents when needed.'}
                    </p>

                    <div style="text-align: center; margin-top: 30px; margin-bottom: 20px;">
                        <a href="${buttonUrl}" 
                           style="background-color: #2563eb; color: #ffffff; padding: 16px 36px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; font-size: 15px; box-shadow: 0 4px 15px rgba(37, 99, 235, 0.3);">
                           View in ERP
                        </a>
                    </div>
                </div>
                <div style="background-color: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0;">This is an automated notification from the VeRP Asset Management System.</p>
                </div>
            </div>
        `;

        const dedupeKey = buildEmailDedupeKey([
            'AssetAssignment',
            recordId,
            recipientEmail.toLowerCase(),
            notificationContext,
            pendingAssignment ? 'pending' : 'notice',
            isBulk ? bulkAssignmentGroupId || 'bulk' : 'single',
            dedupeEvent || stageLabel || transferRecipientRole || '',
        ]);

        const result = await sendErpEmail({
            transporter,
            from: `"Asset Management" <${emailUser}>`,
            to: recipientEmail,
            subject,
            html,
            dedupeKey,
            module: 'Asset',
            emailType: pendingAssignment ? 'assignment_pending' : 'assignment_notice',
            recordId,
            metadata: { subjectCategory: pendingAssignment ? 'action' : 'information' },
        });

        if (result.sent) {
            console.log(`[Email Success] Asset assignment notification sent to ${recipientEmail}`);
            return true;
        }
        if (result.reason === 'duplicate') {
            console.log(`[Email Skip] Duplicate asset assignment notification suppressed for ${recipientEmail}`);
        }
        return false;
    } catch (error) {
        console.error("[Email Error] Failed to send asset assignment email:", error);
        return false;
    }
};
