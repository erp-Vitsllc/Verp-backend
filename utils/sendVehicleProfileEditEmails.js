import nodemailer from 'nodemailer';
import { pickEffectiveEmail as pickEmployeeEmail } from './pickEffectiveEmail.js';

const escapeHtmlBasic = (s) =>
    String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

const createTransport = () => {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) return null;
    return nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });
};

/**
 * @param {'approved'|'rejected'} status
 */
export const sendVehicleProfileEditOutcomeEmail = async ({
    submitterEmployee,
    reviewerName = 'HR',
    vehicleLabel,
    detailUrl,
    status,
    reason = '',
}) => {
    if (!submitterEmployee) return;
    const toEmail = pickEmployeeEmail(submitterEmployee);
    if (!toEmail) return;
    const transporter = createTransport();
    if (!transporter) return;
    const emailUser = process.env.EMAIL_USER?.trim();
    const greeting =
        `${submitterEmployee.firstName || ''} ${submitterEmployee.lastName || ''}`.trim() || 'there';
    const isOk = status === 'approved';
    const title = isOk ? 'Vehicle profile edit approved' : 'Vehicle profile edit rejected';
    const body = isOk
        ? `<p>${escapeHtmlBasic(reviewerName)} has <strong>approved</strong> your requested changes for <strong>${escapeHtmlBasic(vehicleLabel)}</strong>. The updates are now live.</p>`
        : `<p>${escapeHtmlBasic(reviewerName)} has <strong>rejected</strong> your requested profile changes for <strong>${escapeHtmlBasic(vehicleLabel)}</strong>.</p>${
              reason
                  ? `<div style="background:#fee2e2;padding:14px;border-radius:8px;margin:16px 0;"><strong>Reason:</strong><br/>${escapeHtmlBasic(reason).replace(/\n/g, '<br/>')}</div>`
                  : ''
          }`;

    await transporter.sendMail({
        from: `"VeRP Portal" <${emailUser}>`,
        to: toEmail,
        subject: `${vehicleLabel}: ${title}`,
        html: `
            <div style="font-family:Segoe UI,Arial,sans-serif;color:#1e293b;line-height:1.6;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                <div style="background:${isOk ? '#059669' : '#b91c1c'};color:#fff;padding:22px;">
                    <h1 style="margin:0;font-size:20px;">${title}</h1>
                </div>
                <div style="padding:28px;">
                    <p>Hello <strong>${escapeHtmlBasic(greeting)}</strong>,</p>
                    ${body}
                    <p style="text-align:center;margin-top:28px;">
                        <a href="${detailUrl}" style="background:#1d4ed8;color:#fff;padding:12px 22px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;">Open vehicle</a>
                    </p>
                </div>
            </div>
        `,
    });
};
