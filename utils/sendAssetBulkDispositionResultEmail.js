import nodemailer from 'nodemailer';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';
import { normalizePdfAttachments } from './normalizeEmailAttachments.js';

/**
 * Notifies assignee (and primary reportee when available) after a bulk Asset Controller decision:
 * lists processed vs not processed in HTML and attaches the two-section PDF when provided.
 */
export async function sendAssetBulkDispositionResultEmail({
    employee,
    reportee,
    approverName = 'Asset Controller',
    subjectLine,
    introHtml,
    attachments = []
}) {
    try {
        if (!employee) return;

        const { email: employeeEmail } = resolveEmployeeEmail({ ...employee, primaryReportee: employee.primaryReportee || reportee });
        const reporteeEmail = reportee ? resolveEmployeeEmail(reportee).email : null;

        const toEmails = [];
        if (employeeEmail) toEmails.push(employeeEmail);
        if (reporteeEmail && !toEmails.includes(reporteeEmail)) toEmails.push(reporteeEmail);
        if (!toEmails.length) {
            console.warn('[sendAssetBulkDispositionResultEmail] No recipient emails');
            return;
        }

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;
        if (!emailUser || !emailPass) return;

        let smtpHost = process.env.SMTP_HOST || 'smtp.office365.com';
        if (emailUser.includes('@gmail.com')) smtpHost = 'smtp.gmail.com';

        const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: parseInt(process.env.SMTP_PORT) || 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass }
        });

        const att = normalizePdfAttachments(attachments);

        await transporter.sendMail({
            fromName: approverName,
            to: toEmails.join(','),
            subject: subjectLine || 'Bulk asset request — decision summary',
            html: `
                <div style="font-family:Segoe UI,Arial,sans-serif;color:#334155;max-width:640px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                    <div style="background:linear-gradient(135deg,#0f766e 0%,#0d9488 100%);padding:24px;color:#fff;">
                        <h2 style="margin:0;font-size:20px;font-weight:800;">Bulk asset request — result</h2>
                        <p style="margin:8px 0 0;opacity:.9;font-size:13px;">Decision by ${approverName}</p>
                    </div>
                    <div style="padding:24px;background:#fff;">
                        <p style="margin:0 0 14px;font-size:15px;">Hello <strong>${employee.firstName || ''} ${employee.lastName || ''}</strong>,</p>
                        ${introHtml || ''}
                        ${att.length ? '<p style="font-size:12px;color:#64748b;margin:16px 0 0">The attached <strong>Asset Handover Form</strong> lists the processed asset(s) with assigner and assignee signatures.</p>' : ''}
                    </div>
                    <div style="padding:16px;background:#f8fafc;font-size:11px;color:#94a3b8;text-align:center;border-top:1px solid #e2e8f0;">VeRP Asset Management</div>
                </div>
            `,
            ...(att.length ? { attachments: att } : {})
        });
    } catch (e) {
        console.error('[sendAssetBulkDispositionResultEmail]', e?.message || e);
    }
}
