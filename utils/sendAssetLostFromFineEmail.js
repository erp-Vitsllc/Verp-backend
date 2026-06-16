import nodemailer from 'nodemailer';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';
import { resolveEmployeeEmailTargets } from './resolveEmployeeEmail.js';

/**
 * Notifies the asset owner when a Loss & Damage fine is fully approved and the asset is marked Lost.
 */
export const sendAssetLostFromFineEmail = async ({
    asset,
    fine,
    owner,
    attachments = [],
}) => {
    try {
        const { to } = resolveEmployeeEmailTargets(owner);
        if (!to) {
            console.warn('[AssetLostFromFineEmail] Owner has no company email, skipping.');
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

        const frontendUrl = resolveFrontendBaseUrl();
        const link = `${frontendUrl}/HRM/Asset/details/${asset._id || asset.id}`;
        const ownerName = owner
            ? `${owner.firstName || ''} ${owner.lastName || ''}`.trim() || owner.employeeId || 'User'
            : 'User';

        const accessoryLine = fine.accessoryName
            ? `<p><strong>Accessory:</strong> ${fine.accessoryName} (${fine.accessoryId || '—'})</p>`
            : '';

        const htmlContent = `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #dc2626; padding: 20px; color: #fff;">
                    <h2 style="margin: 0;">Asset Marked as Lost</h2>
                    <p style="margin: 5px 0 0; opacity: 0.9;">Fine ${fine.fineId} has been fully approved</p>
                </div>
                <div style="padding: 20px;">
                    <p>Dear ${ownerName},</p>
                    <p>Your asset has been marked <strong>Lost</strong> following approval of the Loss &amp; Damage fine below.</p>
                    <div style="background-color: #fef2f2; padding: 15px; border-radius: 6px; margin: 16px 0; border: 1px solid #fecaca;">
                        <p><strong>Asset:</strong> ${asset.assetId} — ${asset.name}</p>
                        ${accessoryLine}
                        <p><strong>Fine ID:</strong> ${fine.fineId}</p>
                        <p><strong>Fine Type:</strong> ${fine.fineType || 'Loss & Damage'}</p>
                        <p><strong>Amount:</strong> AED ${fine.fineAmount ?? 0}</p>
                        <p><strong>Description:</strong> ${fine.description || '—'}</p>
                    </div>
                    <div style="text-align: center; margin-top: 24px;">
                        <a href="${link}" style="background-color: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">View Asset</a>
                    </div>
                </div>
            </div>`;

        await transporter.sendMail({
            fromName: 'VeRP Asset Management',
            to,
            subject: `Asset Lost: ${asset.assetId} — Fine ${fine.fineId} approved`,
            html: htmlContent,
        });

        console.log(`[AssetLostFromFineEmail] Sent to ${to} for asset ${asset.assetId}`);
    } catch (error) {
        console.error('[AssetLostFromFineEmail] Error:', error?.message || error);
    }
};
