import nodemailer from 'nodemailer';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';
import { resolveEmployeeEmailTargets } from './resolveEmployeeEmail.js';

/** Notify owner when Asset Controller approves or rejects their on-duty request. */
export const sendOwnerOnDutyAcDecisionEmail = async ({
    owner,
    approver,
    approved,
    parkingAssets = [],
    comment = '',
}) => {
    try {
        const { to, cc } = resolveEmployeeEmailTargets(owner);
        if (!to) {
            console.warn('[OwnerOnDutyAcDecisionEmail] Owner has no email, skipping.');
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

        const ownerName = `${owner?.firstName || ''} ${owner?.lastName || ''}`.trim() || owner?.employeeId || 'Colleague';
        const approverName = approver
            ? `${approver.firstName || ''} ${approver.lastName || ''}`.trim() || approver.employeeId || 'Asset Controller'
            : 'Asset Controller';
        const accent = approved ? '#10b981' : '#dc2626';
        const frontendUrl = resolveFrontendBaseUrl();
        const firstAsset = parkingAssets[0];
        const link = firstAsset?._id
            ? `${frontendUrl}/HRM/Asset/details/${firstAsset._id}`
            : `${frontendUrl}/HRM/Asset`;

        const assetList = parkingAssets
            .map((a) => `<li><strong>${a.assetId}</strong> — ${a.name || ''}</li>`)
            .join('');

        const htmlContent = `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 640px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #f8f9fa; padding: 20px; border-bottom: 1px solid #eaeaea;">
                    <h2 style="color: ${accent}; margin: 0;">On Duty request ${approved ? 'approved' : 'rejected'}</h2>
                </div>
                <div style="padding: 20px;">
                    <p>Dear ${ownerName},</p>
                    <p><strong>${approverName}</strong> has <strong>${approved ? 'approved' : 'rejected'}</strong> your on-duty request.</p>
                    ${approved
                        ? '<p>The following asset(s) are now <strong>On Duty</strong>:</p>'
                        : '<p>The following asset(s) remain <strong>on leave</strong>:</p>'}
                    <ul>${assetList}</ul>
                    ${comment ? `<p><strong>Comment:</strong> ${comment}</p>` : ''}
                    <div style="text-align: center; margin-top: 24px;">
                        <a href="${link}" style="background-color: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">View asset</a>
                    </div>
                </div>
            </div>`;

        await transporter.sendMail({
            from: approverName,
            to,
            cc: cc || undefined,
            subject: approved
                ? `Approved: On Duty request (${parkingAssets.length} asset(s))`
                : `Rejected: On Duty request`,
            html: htmlContent,
        });
    } catch (error) {
        console.error('[OwnerOnDutyAcDecisionEmail] Failed:', error?.message || error);
    }
};
