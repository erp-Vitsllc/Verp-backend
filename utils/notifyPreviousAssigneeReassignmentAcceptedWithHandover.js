import nodemailer from 'nodemailer';
import AssetHistory from '../models/AssetHistory.js';
import AssetItem from '../models/AssetItem.js';
import { generateAssetHandoverEmailPdf } from './generateAssetHandoverEmailPdf.js';
import { normalizePdfAttachments } from './normalizeEmailAttachments.js';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';

async function resolvePreviousAssigneeFromHistory(assetMongoId) {
    const rows = await AssetHistory.find({ assetId: assetMongoId, action: 'Assigned' })
        .sort({ date: -1 })
        .limit(2)
        .populate({
            path: 'assignedTo',
            select: 'firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee'
        })
        .populate('assignedCompany', 'name email companyId companyEmail')
        .lean();
    if (rows.length < 2) return null;
    const prev = rows[1];
    if (prev.assignedToType === 'Company' && prev.assignedCompany) {
        return { type: 'Company', recipient: prev.assignedCompany };
    }
    if (prev.assignedTo) {
        return { type: 'Employee', recipient: prev.assignedTo };
    }
    return null;
}

/**
 * After a reassignment is accepted: emails the *previous* assignee with the same handover PDF
 * as the Document tab (HandoverFormView), including new assignee + accepted-by on the form.
 */
export async function notifyPreviousAssigneeReassignmentAcceptedWithHandover(req, { assetMongoId }) {
    try {
        const resolved = await resolvePreviousAssigneeFromHistory(assetMongoId);
        if (!resolved) return;

        const current = await AssetItem.findById(assetMongoId)
            .populate('assignedTo', 'firstName lastName employeeId')
            .populate('acceptedBy', 'firstName lastName employeeId')
            .select('assetId name assignedTo acceptedBy')
            .lean();

        if (!current) return;

        const nowId = current.assignedTo?._id?.toString?.() || (current.assignedTo && String(current.assignedTo));
        const prevId =
            resolved.type === 'Employee' && resolved.recipient?._id
                ? resolved.recipient._id.toString()
                : null;
        if (prevId && nowId && prevId === nowId) return;

        let recipientEmail = null;
        let recipientName = '';
        if (resolved.type === 'Company') {
            const c = resolved.recipient;
            recipientEmail = (c?.email || c?.companyEmail || '').trim() || null;
            recipientName = c?.name || 'Company';
        } else {
            const r = resolveEmployeeEmail(resolved.recipient);
            recipientEmail = r.email;
            recipientName =
                `${resolved.recipient?.firstName || ''} ${resolved.recipient?.lastName || ''}`.trim() ||
                'Employee';
        }
        if (!recipientEmail) {
            console.warn('[Prev assignee handover] No email for previous assignee');
            return;
        }

        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();
        if (!emailUser || !emailPass) {
            console.error('[Prev assignee handover] Email credentials are not configured');
            return;
        }

        const newAssigneeName = current.assignedTo
            ? `${current.assignedTo.firstName || ''} ${current.assignedTo.lastName || ''}`.trim() || 'New assignee'
            : 'New assignee';
        const acceptedByName = current.acceptedBy
            ? `${current.acceptedBy.firstName || ''} ${current.acceptedBy.lastName || ''}`.trim() || 'Assignee'
            : newAssigneeName;

        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/'/g, '');

        let pdfBuffer = null;
        try {
            pdfBuffer = await generateAssetHandoverEmailPdf(assetMongoId);
        } catch (pdfErr) {
            console.error('[Prev assignee handover] PDF generation failed:', pdfErr?.message || pdfErr);
        }

        const safeStem = String(current.assetId || assetMongoId).replace(/[^\w.-]+/g, '_');
        const attachments = normalizePdfAttachments(
            pdfBuffer?.length
                ? [{ filename: `Asset-Handover-${safeStem}.pdf`, content: pdfBuffer }]
                : []
        );
        const hasPdf = attachments.length > 0;

        const buttonUrl = `${frontendUrl}/HRM/Asset/details/${assetMongoId.toString()}`;

        const html = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
                <div style="background-color: #f59e0b; color: white; padding: 28px; text-align: center;">
                    <h1 style="margin: 0; font-size: 22px;">Reassignment completed</h1>
                </div>
                <div style="padding: 36px;">
                    <p style="font-size: 16px;">Hello ${recipientName},</p>
                    <p><strong>${acceptedByName}</strong> has <strong>accepted</strong> assignment of asset <strong>${current.name}</strong> (ID: <strong>${current.assetId}</strong>).</p>
                    <p>The asset is now assigned to <strong>${newAssigneeName}</strong>.</p>
                    <div style="background-color: #fef3c7; padding: 22px; border-radius: 8px; margin: 22px 0; border: 1px solid #fcd34d;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 12px; text-transform: uppercase; font-weight: bold;">Accepted by</td>
                                <td style="padding: 8px 0; font-weight: bold;">${acceptedByName}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 12px; text-transform: uppercase; font-weight: bold;">Now assigned to</td>
                                <td style="padding: 8px 0; font-weight: bold;">${newAssigneeName}</td>
                            </tr>
                        </table>
                    </div>
                    <p style="font-size: 14px; color: #64748b;">
                        ${
                            hasPdf
                                ? 'The updated <strong>Asset Handover Form</strong> (same as the Document tab) is attached as a PDF.'
                                : 'The handover PDF could not be generated automatically. Please open the asset in VeRP and use the Document tab to view or download the handover form.'
                        }
                    </p>
                    <div style="text-align: center; margin-top: 28px;">
                        <a href="${buttonUrl}" style="background-color: #f59e0b; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; font-size: 14px;">View asset</a>
                    </div>
                </div>
                <div style="background-color: #f8fafc; padding: 18px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0;">VeRP Asset Management — automated notification</p>
                </div>
            </div>
        `;

        const transporter = nodemailer.createTransport({
            host: 'smtp.office365.com',
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass }
        });

        await transporter.sendMail({
            fromName: acceptedByName,
            to: recipientEmail,
            subject: `Handover updated: ${current.assetId} — accepted by ${acceptedByName}`,
            html,
            attachments
        });

        console.log(`[Prev assignee handover] Sent to ${recipientEmail} (${hasPdf ? 'with PDF' : 'no PDF'})`);
    } catch (err) {
        console.error('[Prev assignee handover] Failed:', err);
    }
}
