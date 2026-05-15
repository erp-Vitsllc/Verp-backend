import nodemailer from 'nodemailer';

import { pickEffectiveEmail as pickEmployeeEmail } from "./pickEffectiveEmail.js";

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
 * @param {{ submitterEmployee: object|null, acName: string, vehicleLabel: string, detailUrl: string, holdItems: { sectionId: string, label: string, note?: string }[], comment: string }} params
 */
export const sendVehicleProfileActivationHoldEmail = async (params) => {
    const {
        submitterEmployee,
        acName = 'Administrator',
        vehicleLabel,
        detailUrl,
        holdItems = [],
        comment = '',
    } = params;
    if (!submitterEmployee) return;
    const toEmail = pickEmployeeEmail(submitterEmployee);
    if (!toEmail) {
        console.warn('[vehicleProfileActivation hold email] No submitter email');
        return;
    }
    const transporter = createTransport();
    if (!transporter) return;
    const emailUser = process.env.EMAIL_USER?.trim();
    const greeting =
        `${submitterEmployee.firstName || ''} ${submitterEmployee.lastName || ''}`.trim() || 'there';
    const items =
        holdItems.length > 0
            ? holdItems.map((it) => ({
                  label: String(it.label || it.sectionId || '').trim() || it.sectionId,
                  note: String(it.note || '').trim(),
              }))
            : [{ label: 'Listed areas', note: '' }];
    const listHtml = `<ul style="margin:12px 0;padding-left:20px;">${items
        .map((it) => {
            const lab = escapeHtmlBasic(it.label);
            const nt = escapeHtmlBasic(it.note).replace(/\n/g, '<br/>');
            return `<li style="margin:8px 0;"><strong>${lab}</strong>${nt ? `<div style="margin-top:6px;color:#334155;font-size:14px;"><em>Note:</em> ${nt}</div>` : ''}</li>`;
        })
        .join('')}</ul>`;
    const commentBlock =
        comment && String(comment).trim()
            ? `<div style="background:#fef3c7;padding:14px;border-radius:8px;margin:18px 0;border-left:4px solid #d97706;"><strong>Message from ${escapeHtmlBasic(acName)}:</strong><br/>${String(comment).trim().replace(/\n/g, '<br/>')}</div>`
            : '';

    await transporter.sendMail({
        from: `"VeRP Portal" <${emailUser}>`,
        to: toEmail,
        subject: `${vehicleLabel}: vehicle profile — items to update (on hold)`,
        html: `
            <div style="font-family:Segoe UI,Arial,sans-serif;color:#1e293b;line-height:1.6;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                <div style="background:#b45309;color:#fff;padding:22px;">
                    <h1 style="margin:0;font-size:20px;">Vehicle profile — on hold</h1>
                </div>
                <div style="padding:28px;">
                    <p>Hello <strong>${escapeHtmlBasic(greeting)}</strong>,</p>
                    <p>${escapeHtmlBasic(acName)} reviewed your vehicle profile submission and placed it <strong>on hold</strong>. Please update the areas below and submit for review again from the vehicle page.</p>
                    <p><strong>Sections to address:</strong></p>
                    ${listHtml}
                    ${commentBlock}
                    <p style="text-align:center;margin-top:28px;">
                        <a href="${detailUrl}" style="background:#1d4ed8;color:#fff;padding:12px 22px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;">Open vehicle in VeRP</a>
                    </p>
                </div>
            </div>
        `,
    });
};

/**
 * @param {'approved'|'rejected'} status
 */
export const sendVehicleProfileActivationOutcomeEmail = async ({
    submitterEmployee,
    acName = 'Administrator',
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
    const title = isOk ? 'Vehicle profile approved' : 'Vehicle profile request rejected';
    const body = isOk
        ? `<p>${escapeHtmlBasic(acName)} has <strong>approved</strong> your vehicle profile activation request for <strong>${escapeHtmlBasic(vehicleLabel)}</strong>.</p>`
        : `<p>${escapeHtmlBasic(acName)} has <strong>rejected</strong> your vehicle profile activation request for <strong>${escapeHtmlBasic(vehicleLabel)}</strong>.</p>${
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
