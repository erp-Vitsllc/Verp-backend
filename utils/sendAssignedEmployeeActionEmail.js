import nodemailer from 'nodemailer';
import {
    resolveEmployeeEmailWithReporteeLoaded,
    getFallbackEmailNote,
    employeeDisplayName,
} from './resolveEmployeeEmail.js';
import { normalizePdfAttachments } from './normalizeEmailAttachments.js';

export const sendAssignedEmployeeActionEmail = async ({
    asset,
    employee,
    action,
    performedBy,
    details = '',
    attachments = [],
    customIntro = ''
}) => {
    try {
        if (!asset || !employee || !action) return;

        const att = normalizePdfAttachments(attachments);

        const { email, isFallbackToReportee, employee: resolvedEmployee } =
            await resolveEmployeeEmailWithReporteeLoaded(employee);
        if (!email) return;

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

        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const link = `${frontendUrl}/HRM/Asset/details/${asset._id}`;

        const subjectEmployee = resolvedEmployee || employee;
        const helloName = isFallbackToReportee
            ? employeeDisplayName(subjectEmployee.primaryReportee)
            : employeeDisplayName(subjectEmployee);
        const fallbackNote =
            isFallbackToReportee && subjectEmployee.primaryReportee
                ? getFallbackEmailNote(
                      employeeDisplayName(subjectEmployee),
                      employeeDisplayName(subjectEmployee.primaryReportee)
                  )
                : '';

        await transporter.sendMail({
            fromName: performedBy || "Asset Management",
            to: email,
            subject: `Asset Update: ${action} (${asset.assetId || ''})`,
            ...(att.length ? { attachments: att } : {}),
            html: `
                <div style="font-family:Arial,sans-serif;color:#334155;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
                    <div style="background:#0ea5e9;color:#fff;padding:16px 20px">
                        <h3 style="margin:0">Asset Action Notification</h3>
                    </div>
                    <div style="padding:20px">
                        ${fallbackNote}
                        <p>Hello ${helloName},</p>
                        <p>${customIntro || 'Asset Controller completed this action on your asset:'}</p>
                        <p><b>${action}</b></p>
                        <p><b>Asset:</b> ${asset.assetId || '-'} - ${asset.name || '-'}</p>
                        ${details ? `<p><b>Details:</b> ${details}</p>` : ''}
                        <p><b>Performed by:</b> ${performedBy || 'Asset Controller'}</p>
                        ${att.length ? '<p style="font-size:12px;color:#64748b;">The attached PDF is the <strong>Asset Handover Form</strong> (same layout as bulk assignment), listing each asset with values and accessories.</p>' : ''}
                        <p style="margin-top:18px"><a href="${link}" style="background:#0ea5e9;color:white;padding:10px 14px;border-radius:8px;text-decoration:none">View Asset</a></p>
                    </div>
                </div>
            `
        });
    } catch (error) {
        console.error('[sendAssignedEmployeeActionEmail] Non-fatal email error:', error?.message || error);
    }
};
