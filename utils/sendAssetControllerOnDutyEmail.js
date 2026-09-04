import nodemailer from 'nodemailer';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';
import { employeeDisplayName, getFallbackEmailNote } from './resolveEmployeeEmail.js';
import { isEmployeeActiveForNotifications } from './applyEmployeeLeftUserStatus.js';

function companyEmailOf(emp) {
    const v = String(emp?.companyEmail || '').trim();
    return v || null;
}

/** One recipient only: employee.companyEmail, else primaryReportee.companyEmail. */
function resolveSingleCompanyEmail(emp) {
    if (!emp || !isEmployeeActiveForNotifications(emp)) {
        return { email: null, isFallbackToReportee: false };
    }
    const own = companyEmailOf(emp);
    if (own) return { email: own, isFallbackToReportee: false };
    const reporteeMail = companyEmailOf(emp.primaryReportee);
    if (reporteeMail) return { email: reporteeMail, isFallbackToReportee: true };
    return { email: null, isFallbackToReportee: false };
}

/**
 * Asset Controller set the asset On Duty directly (no owner confirmation).
 * Sends exactly one email: assignee company mailbox, or their primary reportee's company mailbox.
 */
export const sendAssetControllerOnDutyEmail = async ({
    owner,
    parkingAssets = [],
    approver,
}) => {
    try {
        const { email: to, isFallbackToReportee } = resolveSingleCompanyEmail(owner);
        if (!to) {
            console.warn('[AssetControllerOnDutyEmail] No company email for employee or primary reportee, skipping.');
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

        const ownerName = employeeDisplayName(owner);
        const reporteeName = employeeDisplayName(owner?.primaryReportee);
        const approverName = approver
            ? employeeDisplayName(approver)
            : 'Asset Controller';
        const frontendUrl = resolveFrontendBaseUrl();
        const firstAsset = parkingAssets[0];
        const link = firstAsset?._id
            ? `${frontendUrl}/HRM/Asset/details/${firstAsset._id}`
            : `${frontendUrl}/HRM/Asset`;
        const assetList = parkingAssets
            .map((a) => `<li><strong>${a.assetId}</strong> — ${a.name || ''}</li>`)
            .join('');
        const fallbackNote = isFallbackToReportee
            ? getFallbackEmailNote(ownerName, reporteeName)
            : '';

        const htmlContent = `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 640px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #f8f9fa; padding: 20px; border-bottom: 1px solid #eaeaea;">
                    <h2 style="color: #10b981; margin: 0;">Asset set On Duty</h2>
                </div>
                <div style="padding: 20px;">
                    ${fallbackNote}
                    <p>Dear ${isFallbackToReportee ? reporteeName : ownerName},</p>
                    <p><strong>${approverName}</strong> has set the following asset(s) to <strong>On Duty</strong>. They are returned from leave to ${ownerName}.</p>
                    <ul>${assetList}</ul>
                    <div style="text-align: center; margin-top: 24px;">
                        <a href="${link}" style="background-color: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">View asset</a>
                    </div>
                </div>
            </div>`;

        await transporter.sendMail({
            from: approverName,
            to,
            subject: `On Duty: ${parkingAssets.map((a) => a.assetId).filter(Boolean).join(', ') || 'asset'}`,
            html: htmlContent,
        });
    } catch (error) {
        console.error('[AssetControllerOnDutyEmail] Failed:', error?.message || error);
    }
};
