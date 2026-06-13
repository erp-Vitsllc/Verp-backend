import nodemailer from 'nodemailer';
import { resolveEmployeeEmailTargets } from './resolveEmployeeEmail.js';

export const sendOwnerOnDutyResponseEmail = async ({
    assetController,
    owner,
    accepted = [],
    declined = [],
    outcomeLabel,
}) => {
    try {
        const { to, cc } = resolveEmployeeEmailTargets(assetController);
        if (!to) {
            console.warn('[OwnerOnDutyResponseEmail] Asset Controller has no email, skipping.');
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

        const row = (a, extra = '') =>
            `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;">${a.assetId}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;">${a.name}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;">${extra}</td></tr>`;

        const acceptedRows = accepted.map((a) => row(a, 'On Duty')).join('') || '<tr><td colspan="3" style="padding:8px;">None</td></tr>';
        const declinedRows =
            declined.map((a) => row(a, a.reason || '—')).join('') || '<tr><td colspan="3" style="padding:8px;">None</td></tr>';

        const ownerName = `${owner?.firstName || ''} ${owner?.lastName || ''}`.trim() || owner?.employeeId || 'Owner';

        const htmlContent = `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 640px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px;">
                <div style="background:#eff6ff;padding:20px;border-bottom:1px solid #dbeafe;">
                    <h2 style="color:#1d4ed8;margin:0;">Owner on duty response — ${outcomeLabel}</h2>
                    <p style="margin:8px 0 0;color:#555;">${ownerName} completed the parked asset review.</p>
                </div>
                <div style="padding:20px;">
                    <h3 style="font-size:14px;color:#047857;">Accepted (On Duty)</h3>
                    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px;">
                        <thead><tr style="background:#f8fafc;"><th style="text-align:left;padding:8px;">ID</th><th style="text-align:left;padding:8px;">Name</th><th style="text-align:left;padding:8px;">Result</th></tr></thead>
                        <tbody>${acceptedRows}</tbody>
                    </table>
                    <h3 style="font-size:14px;color:#b45309;">Declined (remain on leave)</h3>
                    <table style="width:100%;border-collapse:collapse;font-size:13px;">
                        <thead><tr style="background:#f8fafc;"><th style="text-align:left;padding:8px;">ID</th><th style="text-align:left;padding:8px;">Name</th><th style="text-align:left;padding:8px;">Reason</th></tr></thead>
                        <tbody>${declinedRows}</tbody>
                    </table>
                </div>
            </div>`;

        await transporter.sendMail({
            from: emailUser,
            to,
            cc: cc || undefined,
            subject: `Owner on duty response (${outcomeLabel}) — ${ownerName}`,
            html: htmlContent,
        });
    } catch (error) {
        console.error('[OwnerOnDutyResponseEmail] Failed:', error?.message || error);
    }
};
