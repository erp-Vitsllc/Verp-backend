import nodemailer from 'nodemailer';
import { resolveFrontendBaseUrl, emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import { resolveEmployeeEmailWithReporteeLoaded, getFallbackEmailNote, employeeDisplayName } from './resolveEmployeeEmail.js';

/**
 * Notify flowchart role when a vehicle service workflow step is waiting or completed.
 */
export async function sendVehicleServiceWorkflowEmail({
    recipient,
    asset,
    stageLabel,
    actionLabel,
    detailLine,
    linkPath,
    cc = [],
}) {
    try {
        const { email: to, isFallbackToReportee, employee } =
            await resolveEmployeeEmailWithReporteeLoaded(recipient);
        if (!to) {
            console.warn('[VehicleServiceWorkflow] No email for recipient', recipient?.employeeId);
            return;
        }
        const full = employee || recipient;
        const greetingName =
            isFallbackToReportee && full?.primaryReportee
                ? full.primaryReportee.firstName || 'there'
                : recipient.firstName || full?.firstName || '';
        const fallbackNote =
            isFallbackToReportee && full?.primaryReportee
                ? getFallbackEmailNote(
                      employeeDisplayName(full),
                      employeeDisplayName(full.primaryReportee),
                  )
                : '';
        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();
        if (!emailUser || !emailPass) return;

        const transporter = nodemailer.createTransport({
            host: 'smtp.office365.com',
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass }
        });

        const base = (resolveFrontendBaseUrl()).replace(/\/$/, '');
        const link = linkPath ? `${base}${linkPath.startsWith('/') ? linkPath : `/${linkPath}`}` : `${base}/HRM/Asset/Vehicle/details/${asset._id}`;

        const subject = `[VeRP] Vehicle service — ${actionLabel}: ${asset.assetId || asset.name}`;
        const html = `
            <div style="font-family:Segoe UI,sans-serif;color:#1e293b;line-height:1.6;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                <div style="background:#0d9488;color:#fff;padding:18px 24px;">
                    <h1 style="margin:0;font-size:18px;">${actionLabel}</h1>
                    <p style="margin:8px 0 0;font-size:13px;opacity:.95;">${stageLabel}</p>
                </div>
                <div style="padding:24px;">
                    ${fallbackNote}
                    <p>Hello <strong>${greetingName}</strong>,</p>
                    <p style="color:#475569;">${detailLine || 'Please review this vehicle service workflow in VeRP.'}</p>
                    <table style="width:100%;margin:16px 0;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
                        <tr><td style="padding:10px 14px;font-size:12px;color:#64748b;">Asset</td><td style="padding:10px 14px;font-weight:700;">${asset.assetId || ''} — ${asset.name || ''}</td></tr>
                        ${asset.plateNumber ? `<tr><td style="padding:10px 14px;font-size:12px;color:#64748b;">Plate</td><td style="padding:10px 14px;">${asset.plateNumber}</td></tr>` : ''}
                    </table>
                    <p style="text-align:center;margin:28px 0;">
                        <a href="${link}" style="background:#0d9488;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;">Open vehicle</a>
                    </p>
                </div>
            </div>`;

        const ccList = (Array.isArray(cc) ? cc : [])
            .map((addr) => String(addr || '').trim())
            .filter((addr) => addr && addr.toLowerCase() !== to.toLowerCase());

        await transporter.sendMail({
            from: `"VeRP Portal" <${emailUser}>`,
            to,
            ...(ccList.length ? { cc: ccList } : {}),
            subject,
            html
        });
    } catch (e) {
        console.error('[VehicleServiceWorkflow] Email error:', e.message);
    }
}
