import nodemailer from 'nodemailer';
import AssetItem from '../models/AssetItem.js';
import User from '../models/User.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';
import { generatePdf } from './generatePdf.js';

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

        const baseUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '').replace(/'/g, '');
        const printUrl = `${baseUrl}/print/asset-handover/${assetMongoId.toString()}`;
        const token = req.headers.authorization?.split(' ')[1] || '';
        const requestingUserId = req.user?.id;
        const userObj = await User.findById(requestingUserId);
        const userPayload = {
            id: requestingUserId,
            isAdmin: userObj?.isAdmin || userObj?.role === 'Admin' || userObj?.role === 'ROOT',
            role: userObj?.role,
            employeeId: userObj?.employeeId
        };

        const selector = '#asset-handover-container';
        let pdfBuffer = null;
        try {
            pdfBuffer = await generatePdf(printUrl, token, userPayload, {}, selector);
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
        const hasPdf = Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 0;
        const attachments = hasPdf
            ? [{ filename: `Handover-${displayId.replace(/[^\w.-]+/g, '_')}.pdf`, content: pdfBuffer }]
            : [];

        const html = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
                <div style="background-color: #0f766e; color: white; padding: 24px; text-align: center;">
                    <h1 style="margin: 0; font-size: 20px;">Reassignment accepted</h1>
                </div>
                <div style="padding: 28px;">
                    <p style="font-size: 15px;">Hello ${acFirst},</p>
                    <p>The new assignee has <strong>accepted</strong> the reassignment for asset <strong>${displayName}</strong> (ID: <strong>${displayId}</strong>).</p>
                    ${
                        hasPdf
                            ? '<p>The updated asset handover document is attached to this email.</p>'
                            : '<p><strong>Note:</strong> The handover PDF could not be generated automatically. Please open the asset in VeRP and download the handover document from there.</p>'
                    }
                </div>
                <div style="background-color: #f8fafc; padding: 16px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0;">Automated notification — VeRP Asset Management</p>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"VeRP Asset Management" <${emailUser}>`,
            to: acEmail,
            subject: `Reassignment accepted: ${displayName} (${displayId})`,
            html,
            attachments
        });

        console.log(`[AC Reassignment Handover] Notification sent to ${acEmail} (${hasPdf ? 'with PDF' : 'no PDF'})`);
    } catch (err) {
        console.error('[AC Reassignment Handover] Failed to notify Asset Controller:', err);
    }
}
