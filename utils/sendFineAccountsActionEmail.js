import nodemailer from 'nodemailer';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';

function createTransporter() {
    const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
    const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;
    if (!emailUser || !emailPass) {
        console.error('[FineAccountsEmail] SMTP credentials missing.');
        return null;
    }
    let smtpHost = process.env.SMTP_HOST || 'smtp.office365.com';
    if (emailUser.includes('@gmail.com') || process.env.GMAIL_USER) {
        smtpHost = 'smtp.gmail.com';
    }
    return nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(process.env.SMTP_PORT, 10) || 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });
}

function fineLink(fine) {
    return `${resolveFrontendBaseUrl()}/HRM/Fine/${fine._id}`;
}

function fineAmountLabel(fine) {
    return `AED ${Number(fine.totalFineAmount || fine.fineAmount || 0).toLocaleString()}`;
}

/**
 * Accounts payment-request email, or Management notice after Accounts settles.
 * @param {'accounts_payment_request'|'accounts_entered_zoho'|'accounts_paid_by_employee'} kind
 */
export async function sendFineAccountsActionEmail({ kind, fine, to, greetingName = '' }) {
    const recipients = (Array.isArray(to) ? to : [to]).map((e) => String(e || '').trim()).filter(Boolean);
    if (!recipients.length || !fine) {
        console.warn(`[FineAccountsEmail] Skip ${kind}: missing recipients or fine.`);
        return;
    }

    const transporter = createTransporter();
    if (!transporter) return;

    const link = fineLink(fine);
    const name = greetingName || 'Team';
    const fineId = fine.fineId || '';
    let subject = '';
    let title = '';
    let body = '';
    let button = 'Open Fine';

    if (kind === 'accounts_payment_request') {
        subject = `Action Required: Fine payment pending — ${fineId}`;
        title = 'Fine payment pending';
        body = `Fine <strong>${fineId}</strong> is approved. Please choose <strong>Enter in Zoho</strong> or <strong>Paid by employee</strong>.`;
        button = 'Open Fine — Payment';
    } else if (kind === 'accounts_entered_zoho') {
        subject = `Accounts entered Fine ${fineId} in Zoho`;
        title = 'Accounts entered Zoho';
        body = `Accounts posted Fine <strong>${fineId}</strong> to Zoho as a vendor bill. Employee payment is not marked Paid.`;
    } else if (kind === 'accounts_paid_by_employee') {
        subject = `Accounts marked Fine ${fineId} paid by employee`;
        title = 'Paid by employee';
        body = `Accounts marked Fine <strong>${fineId}</strong> as paid by the employee. There is no Zoho entry.`;
    } else {
        return;
    }

    const html = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden;">
            <div style="background-color: #f8f9fa; padding: 20px; border-bottom: 1px solid #eaeaea;">
                <h2 style="color: #0d6efd; margin: 0;">${title}</h2>
                <p style="margin: 5px 0 0; color: #666;">Fine: <strong>${fineId}</strong></p>
            </div>
            <div style="padding: 20px;">
                <p>Dear ${name},</p>
                <p>${body}</p>
                <div style="background-color: #e3f2fd; padding: 15px; border-radius: 6px; margin: 20px 0;">
                    <p><strong>Fine ID:</strong> ${fineId}</p>
                    <p><strong>Type:</strong> ${fine.fineType || fine.category || 'Fine'}</p>
                    <p><strong>Amount:</strong> ${fineAmountLabel(fine)}</p>
                </div>
                <div style="text-align: center; margin-top: 24px;">
                    <a href="${link}" style="background-color: #0d6efd; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">${button}</a>
                </div>
            </div>
            <div style="background-color: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #999; border-top: 1px solid #eaeaea;">
                This is an automated system notification from VeRP.
            </div>
        </div>
    `;

    try {
        await transporter.sendMail({
            fromName: 'VeRP Fine System',
            to: recipients.join(','),
            subject,
            html,
        });
        console.log(`[FineAccountsEmail] Sent ${kind} to ${recipients.join(', ')}`);
    } catch (error) {
        console.error(`[FineAccountsEmail] Failed ${kind}:`, error);
    }
}
