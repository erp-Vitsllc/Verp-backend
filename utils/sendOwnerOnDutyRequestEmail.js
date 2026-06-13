import nodemailer from 'nodemailer';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';
import { resolveEmployeeEmailTargets } from './resolveEmployeeEmail.js';

export const sendOwnerOnDutyRequestEmail = async ({
    owner,
    requesterName,
    parkingAssets = [],
    reviewUrl,
}) => {
    try {
        const { to, cc } = resolveEmployeeEmailTargets(owner);
        if (!to) {
            console.warn('[OwnerOnDutyEmail] Owner has no email, skipping.');
            return;
        }

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;
        if (!emailUser || !emailPass) {
            console.error('[OwnerOnDutyEmail] Email credentials missing.');
            return;
        }

        let smtpHost = process.env.SMTP_HOST || 'smtp.office365.com';
        if (emailUser.includes('@gmail.com')) smtpHost = 'smtp.gmail.com';

        const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: parseInt(process.env.SMTP_PORT, 10) || 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        });

        const assetRows = parkingAssets
            .map(
                (a) =>
                    `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;">${a.assetId || '—'}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;">${a.name || '—'}</td></tr>`,
            )
            .join('');

        const htmlContent = `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 640px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #ecfdf5; padding: 20px; border-bottom: 1px solid #d1fae5;">
                    <h2 style="color: #047857; margin: 0;">On Duty confirmation required</h2>
                    <p style="margin: 8px 0 0; color: #555;">${requesterName || 'Asset Controller'} requested your review of parked assets.</p>
                </div>
                <div style="padding: 20px;">
                    <p>Dear ${owner.firstName || 'Colleague'},</p>
                    <p>Please confirm which parked assets you are ready to take <strong>On Duty</strong>. Assets you do not select will remain on leave (parking).</p>
                    <table style="width:100%; border-collapse: collapse; margin: 16px 0; font-size: 14px;">
                        <thead><tr style="background:#f8fafc;"><th style="text-align:left;padding:8px;">Asset ID</th><th style="text-align:left;padding:8px;">Name</th></tr></thead>
                        <tbody>${assetRows}</tbody>
                    </table>
                    <div style="text-align: center; margin-top: 24px;">
                        <a href="${reviewUrl}" style="background-color: #059669; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Review &amp; confirm</a>
                    </div>
                </div>
            </div>`;

        await transporter.sendMail({
            from: emailUser,
            to,
            cc: cc || undefined,
            subject: `On Duty confirmation — ${parkingAssets.length} parked asset(s)`,
            html: htmlContent,
        });
    } catch (error) {
        console.error('[OwnerOnDutyEmail] Failed:', error?.message || error);
    }
};
