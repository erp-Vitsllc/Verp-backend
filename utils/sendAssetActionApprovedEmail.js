import nodemailer from 'nodemailer';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';
import { normalizePdfAttachments } from './normalizeEmailAttachments.js';

/**
 * Sends an email to the Employee and their Reporting Authority after an Asset Action (Leave/End of Life) is approved.
 * 
 * @param {Object} asset - The asset object
 * @param {string} actionType - 'Leave' or 'End of Life'
 * @param {Object} employee - The employee who had the asset
 * @param {Object} reportee - The primary reportee of the employee
 * @param {Object} approver - The Asset Controller who approved it
 */
function approvedOutcomeDescription(actionType, asset) {
    if (actionType === 'Leave') return 'placed On Leave';
    if (actionType === 'End of Life') {
        const o = asset?.pendingActionDetails?.originalActionType;
        if (o === 'End of Services') return 'returned to store (End of Services)';
        return 'marked as End of Life (Unassigned)';
    }
    return 'processed';
}

export const sendAssetActionApprovedEmail = async (asset, actionType, employee, reportee, approver, attachments = []) => {
    try {
        if (!employee) return;

        const att = normalizePdfAttachments(attachments);

        const employeeEmail = employee.companyEmail || employee.email;
        const reporteeEmail = reportee?.companyEmail || reportee?.email;

        let toEmails = [];
        if (employeeEmail) toEmails.push(employeeEmail);
        if (reporteeEmail) toEmails.push(reporteeEmail);

        if (toEmails.length === 0) {
            console.warn('[AssetEmail] No emails found for employee or reportee, skipping approval notification.');
            return;
        }

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;

        if (!emailUser || !emailPass) {
            console.error('[AssetEmail] Email credentials missing.');
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
        const link = `${frontendUrl}/HRM/Asset/details/${asset._id || asset.id}`;

        const actionText = approvedOutcomeDescription(actionType, asset);

        const htmlContent = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; color: #334155; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
                <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; color: white;">
                    <h2 style="margin: 0; font-size: 24px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em;">Asset Action Approved</h2>
                    <p style="margin: 10px 0 0; opacity: 0.9;">${actionType} process completed.</p>
                </div>
                
                <div style="padding: 32px; background-color: #ffffff;">
                    <p style="font-size: 16px; margin-top: 0;">Dear <strong>${employee.firstName} ${employee.lastName}</strong>,</p>
                    <p>The Asset Controller has approved the <strong>${actionType}</strong> request for your asset.</p>
                    <p>The asset has been successfully ${actionText}.</p>
                    
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
                                <td style="padding: 4px 0; color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase;">Action Type</td>
                                <td style="padding: 4px 0; color: #10b981; font-weight: 800; text-align: right;">${actionType}</td>
                            </tr>
                            <tr>
                                <td style="padding: 4px 0; color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase;">Approved By</td>
                                <td style="padding: 4px 0; color: #1e293b; font-weight: 700; text-align: right;">${approver ? `${approver.firstName} ${approver.lastName}` : 'Asset Controller'}</td>
                            </tr>
                        </table>
                    </div>

                    ${att.length ? `<p style="font-size:13px;color:#64748b;margin:0 0 16px;">The attached <strong>Asset Handover Form</strong> shows the handover party&rsquo;s signature and your name and signature under <strong>Received and Acknowledge</strong>.</p>` : ''}

                    <div style="text-align: center; margin-top: 40px;">
                        <a href="${link}" style="display: inline-block; background-color: #10b981; color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 12px; font-weight: 800; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; box-shadow: 0 10px 15px -3px rgba(16, 185, 129, 0.3);">View Asset Details</a>
                    </div>
                </div>
                
                <div style="background-color: #f1f5f9; padding: 20px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0;">This is an automated system notification from VeRP Asset Management. Sent to employee and reporting authority.</p>
                </div>
            </div>
        `;

        await transporter.sendMail({
            fromName: approver ? `${approver.firstName} ${approver.lastName}` : "Asset Controller",
            to: toEmails.join(','),
            subject: `Approved: Asset ${actionType} (${asset.assetId})`,
            html: htmlContent,
            ...(att.length ? { attachments: att } : {})
        });

        console.log(`[AssetEmail] Approved notification sent to ${toEmails.join(', ')} for ${actionType} on ${asset.assetId}`);

    } catch (error) {
        console.error('[AssetEmail] Error sending approved notification email:', error);
    }
};

/**
 * Sends a single email to the Employee and their Reporting Authority listing all assets
 * when a bulk Asset Action (Leave/End of Life) is approved.
 *
 * @param {Object[]} assets - Array of asset objects
 * @param {string} actionType - 'Leave' or 'End of Life'
 * @param {Object} employee - The employee who had the assets
 * @param {Object} reportee - The primary reportee of the employee
 * @param {Object} approver - The Asset Controller who approved it
 */
export const sendAssetBulkActionApprovedEmail = async (assets, actionType, employee, reportee, approver, attachments = []) => {
    try {
        if (!employee || !assets?.length) return;

        const att = normalizePdfAttachments(attachments);

        const { email: employeeEmail } = resolveEmployeeEmail({ ...employee, primaryReportee: employee.primaryReportee || reportee });
        const reporteeEmail = reportee ? resolveEmployeeEmail(reportee).email : null;

        let toEmails = [];
        if (employeeEmail) toEmails.push(employeeEmail);
        if (reporteeEmail && !toEmails.includes(reporteeEmail)) toEmails.push(reporteeEmail);

        if (toEmails.length === 0) {
            console.warn('[AssetEmail] No emails found for employee or reportee, skipping bulk approval notification.');
            return;
        }

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;

        if (!emailUser || !emailPass) {
            console.error('[AssetEmail] Email credentials missing.');
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
        const actionText = approvedOutcomeDescription(actionType, assets[0]);

        const assetRows = assets.map((a) => {
            const link = `${frontendUrl}/HRM/Asset/details/${a._id || a.id}`;
            return `
                <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 12px 8px; color: #1e293b; font-weight: 600;">${a.assetId || '-'}</td>
                    <td style="padding: 12px 8px; color: #1e293b;">${a.name || '-'}</td>
                    <td style="padding: 12px 8px;"><a href="${link}" style="color: #10b981; font-weight: 600; text-decoration: none;">View</a></td>
                </tr>`;
        }).join('');

        const htmlContent = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; color: #334155; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
                <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; color: white;">
                    <h2 style="margin: 0; font-size: 24px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em;">Bulk Asset Action Approved</h2>
                    <p style="margin: 10px 0 0; opacity: 0.9;">${actionType} process completed for ${assets.length} asset(s).</p>
                </div>
                
                <div style="padding: 32px; background-color: #ffffff;">
                    <p style="font-size: 16px; margin-top: 0;">Dear <strong>${employee.firstName} ${employee.lastName}</strong>,</p>
                    <p>The Asset Controller has approved the <strong>${actionType}</strong> request for your assets.</p>
                    <p>All ${assets.length} asset(s) have been successfully ${actionText}.</p>
                    
                    <div style="background-color: #f8fafc; padding: 24px; border-radius: 12px; margin: 24px 0; border: 1px solid #e2e8f0;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <thead>
                                <tr style="border-bottom: 2px solid #e2e8f0;">
                                    <th style="padding: 12px 8px; text-align: left; color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase;">Asset ID</th>
                                    <th style="padding: 12px 8px; text-align: left; color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase;">Asset Name</th>
                                    <th style="padding: 12px 8px; text-align: left; color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase;">Link</th>
                                </tr>
                            </thead>
                            <tbody>${assetRows}</tbody>
                        </table>
                        <p style="margin: 16px 0 0; color: #64748b; font-size: 12px;">Approved by: <strong>${approver ? `${approver.firstName} ${approver.lastName}` : 'Asset Controller'}</strong></p>
                    </div>

                    ${att.length ? `<p style="font-size:13px;color:#64748b;margin:16px 0 0;">The attached <strong>Asset Handover Form</strong> lists all assets included in this bulk approval, with assigner and assignee signatures.</p>` : ''}

                    <div style="text-align: center; margin-top: 40px;">
                        <a href="${frontendUrl}/HRM/Asset" style="display: inline-block; background-color: #10b981; color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 12px; font-weight: 800; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; box-shadow: 0 10px 15px -3px rgba(16, 185, 129, 0.3);">View Assets</a>
                    </div>
                </div>
                
                <div style="background-color: #f1f5f9; padding: 20px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0;">This is an automated system notification from VeRP Asset Management. Sent to employee and reporting authority.</p>
                </div>
            </div>
        `;

        const assetIds = assets.map((a) => a.assetId).join(', ');
        await transporter.sendMail({
            fromName: approver ? `${approver.firstName} ${approver.lastName}` : "Asset Controller",
            to: toEmails.join(','),
            subject: `Approved: Bulk ${actionType} (${assets.length} assets) - ${assetIds}`,
            html: htmlContent,
            ...(att.length ? { attachments: att } : {})
        });

        console.log(`[AssetEmail] Bulk approved notification sent to ${toEmails.join(', ')} for ${actionType} on ${assets.length} asset(s)`);

    } catch (error) {
        console.error('[AssetEmail] Error sending bulk approved notification email:', error);
    }
};
