import nodemailer from 'nodemailer';
import { pickEffectiveEmail } from './pickEffectiveEmail.js';

const escapeHtml = (s) =>
    String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

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

const wrapHtml = (title, bodyHtml) => `
<div style="font-family:Segoe UI,Arial,sans-serif;color:#1e293b;line-height:1.6;max-width:640px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
  <div style="background:#0f766e;color:#fff;padding:20px;text-align:center;">
    <h2 style="margin:0;font-size:18px;">${escapeHtml(title)}</h2>
  </div>
  <div style="padding:24px;">${bodyHtml}</div>
</div>`;

export const sendVehicleDispositionEmail = async ({ to, subject, html }) => {
    const transporter = createTransport();
    const emailUser = process.env.EMAIL_USER?.trim();
    if (!transporter || !to || !emailUser) return;
    await transporter.sendMail({
        from: `"VeRP Portal" <${emailUser}>`,
        to,
        subject,
        html,
    });
};

export const sendVehicleDispositionHrRequestEmail = async ({ hrEmployee, vehicleLabel, detailUrl, targetLabel, requesterName }) => {
    const to = pickEffectiveEmail(hrEmployee);
    if (!to) return;
    const name = `${hrEmployee?.firstName || ''} ${hrEmployee?.lastName || ''}`.trim() || 'HR';
    const html = wrapHtml(
        'Vehicle disposition — HR review',
        `<p>Hello <strong>${escapeHtml(name)}</strong>,</p>
         <p><strong>${escapeHtml(requesterName || 'A colleague')}</strong> requested to change <strong>${escapeHtml(vehicleLabel)}</strong> to <strong>${escapeHtml(targetLabel)}</strong>.</p>
         <p style="text-align:center;margin:24px 0;">
           <a href="${escapeHtml(detailUrl)}" style="background:#2563eb;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:bold;">Review in VeRP</a>
         </p>`,
    );
    await sendVehicleDispositionEmail({
        to,
        subject: `Vehicle disposition review (HR): ${vehicleLabel} → ${targetLabel}`,
        html,
    });
};

export const sendVehicleDispositionOutcomeEmail = async ({ recipient, vehicleLabel, detailUrl, status, comment }) => {
    const to = pickEffectiveEmail(recipient);
    if (!to) return;
    const name = `${recipient?.firstName || ''} ${recipient?.lastName || ''}`.trim() || 'there';
    const html = wrapHtml(
        `Vehicle disposition — ${status}`,
        `<p>Hello <strong>${escapeHtml(name)}</strong>,</p>
         <p>Your request for <strong>${escapeHtml(vehicleLabel)}</strong> was <strong>${escapeHtml(status)}</strong>.</p>
         ${comment ? `<p><strong>Note:</strong> ${escapeHtml(comment).replace(/\n/g, '<br/>')}</p>` : ''}
         <p style="text-align:center;margin:24px 0;">
           <a href="${escapeHtml(detailUrl)}" style="background:#2563eb;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:bold;">Open vehicle</a>
         </p>`,
    );
    await sendVehicleDispositionEmail({
        to,
        subject: `Vehicle disposition ${status}: ${vehicleLabel}`,
        html,
    });
};

export const sendVehicleDispositionFinanceTaskEmail = async ({ recipient, vehicleLabel, detailUrl, targetLabel, roleLabel }) => {
    const to = pickEffectiveEmail(recipient);
    if (!to) return;
    const name = `${recipient?.firstName || ''} ${recipient?.lastName || ''}`.trim() || roleLabel;
    const html = wrapHtml(
        `Vehicle disposition — ${roleLabel}`,
        `<p>Hello <strong>${escapeHtml(name)}</strong>,</p>
         <p>HR approved a request to mark <strong>${escapeHtml(vehicleLabel)}</strong> as <strong>${escapeHtml(targetLabel)}</strong>. Please complete your review in VeRP.</p>
         <p style="text-align:center;margin:24px 0;">
           <a href="${escapeHtml(detailUrl)}" style="background:#2563eb;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:bold;">Open vehicle</a>
         </p>`,
    );
    await sendVehicleDispositionEmail({
        to,
        subject: `Vehicle disposition (${roleLabel}): ${vehicleLabel}`,
        html,
    });
};

export const sendVehicleDispositionCompanyEmail = async ({ companyEmail, companyName, vehicleLabel, targetLabel, detailUrl, summaryLines }) => {
    const to = String(companyEmail || '').trim();
    if (!to) return;
    const rows = (summaryLines || [])
        .map((line) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;">${escapeHtml(line.label)}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;">${escapeHtml(line.value)}</td></tr>`)
        .join('');
    const html = wrapHtml(
        'Vehicle disposition finalized',
        `<p>Hello,</p>
         <p>The vehicle <strong>${escapeHtml(vehicleLabel)}</strong>${companyName ? ` (${escapeHtml(companyName)})` : ''} has been marked as <strong>${escapeHtml(targetLabel)}</strong> after HR, Accounts, and Management approval.</p>
         <table style="width:100%;border-collapse:collapse;margin:16px 0;">${rows}</table>
         <p style="text-align:center;margin:24px 0;">
           <a href="${escapeHtml(detailUrl)}" style="background:#2563eb;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:bold;">View in VeRP</a>
         </p>`,
    );
    await sendVehicleDispositionEmail({
        to,
        subject: `Vehicle ${targetLabel}: ${vehicleLabel}`,
        html,
    });
};
