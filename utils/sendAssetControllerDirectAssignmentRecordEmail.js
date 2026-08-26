import nodemailer from 'nodemailer';
import { resolveEmployeeEmailWithReporteeLoaded } from './resolveEmployeeEmail.js';
import { employeeDisplayName } from './resolveEmployeeEmail.js';

/**
 * Sends the final handover-style PDF to the Asset Controller when an assignment is auto-completed
 * (assignee's HOD is the Asset Controller).
 */
export async function sendAssetControllerDirectAssignmentRecordEmail({
    assetControllerEmployee,
    assigneeEmployee,
    assignerEmployee,
    attachments = [],
    isBulk = false,
    assetCount = 1,
    assetSummaryLines = [],
}) {
    try {
        const { email: recipientEmail, employee: resolvedAc } =
            await resolveEmployeeEmailWithReporteeLoaded(assetControllerEmployee);

        if (!recipientEmail) {
            console.warn(
                '[AC direct assignment email] No business email for Asset Controller; skipping controller copy.',
            );
            return false;
        }

        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();
        if (!emailUser || !emailPass) {
            console.error('[AC direct assignment email] Email credentials are not configured.');
            return false;
        }

        const transporter = nodemailer.createTransport({
            host: 'smtp.office365.com',
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        });

        const acName = employeeDisplayName(resolvedAc || assetControllerEmployee);
        const assigneeName = employeeDisplayName(assigneeEmployee);
        const assignerName = employeeDisplayName(assignerEmployee);

        const listHtml =
            assetSummaryLines.length > 0
                ? `<ul style="margin:12px 0;padding-left:20px;font-size:14px;">${assetSummaryLines
                      .map((line) => `<li style="margin:4px 0;">${line}</li>`)
                      .join('')}</ul>`
                : `<p style="font-size:14px;color:#475569;">${assetCount} asset(s).</p>`;

        const subject = isBulk
            ? `Assignment record: ${assetCount} assets to ${assigneeName} (auto-completed)`
            : `Assignment record: asset to ${assigneeName} (auto-completed)`;

        const html = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 640px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
                <div style="background-color: #0f766e; color: white; padding: 26px; text-align: center;">
                    <h1 style="margin: 0; font-size: 20px;">Asset assignment — record copy</h1>
                </div>
                <div style="padding: 32px;">
                    <p style="font-size: 15px;">Hello ${acName},</p>
                    <p style="font-size: 15px;">
                        You assigned ${isBulk ? `<strong>${assetCount}</strong> assets` : 'an asset'}
                        to <strong>${assigneeName}</strong>. Their HOD (primary reportee) is you as Asset Controller,
                        so the assignment was <strong>completed immediately</strong> without a pending acceptance step.
                    </p>
                    <p style="font-size: 14px; color: #64748b;">Recorded by: <strong>${assignerName}</strong></p>
                    ${listHtml}
                    <p style="font-size: 13px; color: #64748b; margin-top: 20px;">
                        The handover form is saved on the asset record in ERP and can be downloaded from the asset page when needed.
                    </p>
                </div>
                <div style="background-color: #f8fafc; padding: 16px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0;">VeRP Asset Management — automated message</p>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"Asset Management" <${emailUser}>`,
            to: recipientEmail,
            subject,
            html,
        });

        console.log(`[AC direct assignment email] Sent to ${recipientEmail}`);
        return true;
    } catch (e) {
        console.error('[AC direct assignment email] Failed:', e?.message || e);
        return false;
    }
}
