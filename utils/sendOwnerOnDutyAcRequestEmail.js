import nodemailer from 'nodemailer';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';
import { resolveEmployeeEmailTargets } from './resolveEmployeeEmail.js';

/** Owner requested on-duty — notify Asset Controller for approval. */
export const sendOwnerOnDutyAcRequestEmail = async ({
    assetController,
    owner,
    parkingAssets = [],
    reviewUrl,
}) => {
    try {
        const { to, cc } = resolveEmployeeEmailTargets(assetController);
        if (!to) {
            console.warn('[OwnerOnDutyAcRequestEmail] Asset Controller has no email, skipping.');
            return;
        }

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;
        if (!emailUser || !emailPass) return;

        let smtpHost = process.env.SMTP_HOST || 'smtp.office365.com';
        if (emailUser.includes('@gmail.com')) smtpHost = 'smtp.gmail.com';

        const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: parseInt(process.env.SMTP_PORT, 10) || 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        });

        const ownerName = `${owner?.firstName || ''} ${owner?.lastName || ''}`.trim() || owner?.employeeId || 'Asset owner';
        const assetRows = parkingAssets
            .map(
                (a) =>
                    `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;">${a.assetId || '—'}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;">${a.name || '—'}</td></tr>`,
            )
            .join('');

        const htmlContent = `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 640px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #eff6ff; padding: 20px; border-bottom: 1px solid #dbeafe;">
                    <h2 style="color: #1d4ed8; margin: 0;">On Duty approval required</h2>
                    <p style="margin: 8px 0 0; color: #555;"><strong>${ownerName}</strong> requested to return parked asset(s) to On Duty.</p>
                </div>
                <div style="padding: 20px;">
                    <p>Dear Asset Controller,</p>
                    <p>Please approve or reject this on-duty request. Assets remain on leave until you approve.</p>
                    <table style="width:100%; border-collapse: collapse; margin: 16px 0; font-size: 14px;">
                        <thead><tr style="background:#f8fafc;"><th style="text-align:left;padding:8px;">Asset ID</th><th style="text-align:left;padding:8px;">Name</th></tr></thead>
                        <tbody>${assetRows}</tbody>
                    </table>
                    <div style="text-align: center; margin-top: 24px;">
                        <a href="${reviewUrl}" style="background-color: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Review request</a>
                    </div>
                </div>
            </div>`;

        await transporter.sendMail({
            from: emailUser,
            to,
            cc: cc || undefined,
            subject: `On Duty request from ${ownerName} — ${parkingAssets.length} asset(s)`,
            html: htmlContent,
        });
    } catch (error) {
        console.error('[OwnerOnDutyAcRequestEmail] Failed:', error?.message || error);
    }
};
