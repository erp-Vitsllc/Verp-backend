import nodemailer from 'nodemailer';
import AssetItem from '../models/AssetItem.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { resolveEmployeeEmailTargets } from './resolveEmployeeEmail.js';
import { buildAcceptedAssetHandoverAttachments } from './buildAssignmentHandoverEmailAttachments.js';
import { normalizePdfAttachments } from './normalizeEmailAttachments.js';

/**
 * Emails the Asset Controller (flowchart HOD) with the updated asset handover PDF
 * after a new assignee accepts a reassignment.
 */
export async function notifyAssetControllerReassignmentAcceptedWithHandover(req, { assetMongoId }) {
    try {
        const ac = await getDepartmentHOD('assetcontroller');
        if (!ac) {
            console.warn('[AC Reassignment Handover] No Asset Controller HOD configured');
            return;
        }
        const { email: acEmail } = resolveEmployeeEmail(ac);
        if (!acEmail) {
            console.warn('[AC Reassignment Handover] No email for Asset Controller');
            return;
        }

        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();
        if (!emailUser || !emailPass) {
            console.error('[AC Reassignment Handover] Email credentials are not configured');
            return;
        }

        const asset = await AssetItem.findById(assetMongoId).select('assetId name').lean();
        const displayId = asset?.assetId || String(assetMongoId);
        const displayName = asset?.name || 'Asset';

        let attachments = [];
        try {
            attachments = normalizePdfAttachments(
                await buildAcceptedAssetHandoverAttachments(
                    req,
                    assetMongoId,
                    'reassignment-accepted-handover',
                ),
            );
        } catch (pdfErr) {
            console.error('[AC Reassignment Handover] PDF generation failed:', pdfErr?.message || pdfErr);
        }

        const transporter = nodemailer.createTransport({
            host: 'smtp.office365.com',
            port: 587,
            secure: false,
            auth: {
                user: emailUser,
                pass: emailPass
            }
        });

        const acFirst = ac.firstName || 'Asset Controller';

        const html = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
                <div style="background-color: #0f766e; color: white; padding: 24px; text-align: center;">
                    <h1 style="margin: 0; font-size: 20px;">Reassignment accepted</h1>
                </div>
                <div style="padding: 28px;">
                    <p style="font-size: 15px;">Hello ${acFirst},</p>
                    <p>The new assignee has <strong>accepted</strong> the reassignment for asset <strong>${displayName}</strong> (ID: <strong>${displayId}</strong>).</p>
                    ${
                        attachments.length
                            ? '<p>The updated asset handover summary (PDF) is attached to this email.</p>'
                            : '<p><strong>Note:</strong> The handover PDF could not be generated automatically. Please open the asset in VeRP and download the handover document from there.</p>'
                    }
                </div>
                <div style="background-color: #f8fafc; padding: 16px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0;">Automated notification — VeRP Asset Management</p>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"Asset Management" <${emailUser}>`,
            to: acEmail,
            subject: `Reassignment accepted: ${displayName} (${displayId})`,
            html,
            ...(attachments.length ? { attachments } : {}),
        });

        console.log(
            `[AC Reassignment Handover] Notification sent to ${acEmail} (${attachments.length ? 'with PDF' : 'no PDF'})`,
        );
    } catch (err) {
        console.error('[AC Reassignment Handover] Failed to notify Asset Controller:', err);
    }
}
