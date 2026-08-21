import nodemailer from 'nodemailer';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';

function createTransport() {
    const emailUser = process.env.EMAIL_USER;
    const emailPass = process.env.EMAIL_PASS;
    if (!emailUser || !emailPass) return null;
    return nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });
}

async function resolveRecipient(person) {
    if (!person) return null;
    if (person._id) {
        const fresh = await EmployeeBasic.findById(person._id)
            .select(
                'firstName lastName companyEmail workEmail personalEmail email employeeId profileStatus status',
            )
            .lean();
        if (fresh) return fresh;
    }
    return person;
}

/**
 * Accounts payment-day email — only when the *next month* payable date == today.
 * Example: June bill → email on July payment day.
 */
export async function sendUtilityBillPaymentDayEmail({
    recipient,
    record,
    dueDateLabel = '',
    yearMonth = '',
    message = '',
}) {
    try {
        const transporter = createTransport();
        const to = await resolveRecipient(recipient);
        const { email: recipientEmail } = resolveEmployeeEmail(to || {});
        if (!transporter || !to || !recipientEmail) {
            console.warn('[UtilityBillPaymentDayEmail] Missing SMTP or recipient email.');
            return;
        }

        const frontendUrl = emailFrontendUrl();
        const ym = String(yearMonth || '').trim();
        const qs = new URLSearchParams({ addBill: '1' });
        if (/^\d{4}-\d{2}$/.test(ym)) qs.set('billMonth', ym);
        const path = `/HRM/Asset/UtilityBills/details/${encodeURIComponent(String(record.entryId))}?${qs.toString()}`;
        const buttonUrl = `${frontendUrl}${path}`;
        const utilityType = String(record.utilityType || 'utility').trim() || 'utility';
        const accountNo = String(record.accountNo || '').trim() || 'account';
        const monthLine = String(message || '').trim()
            || `${ym || 'This'} bill payment day on ${utilityType} on the ${accountNo}, please pay the bill`;
        const title = monthLine;
        const accent = '#1A2B48';

        const html = `
            <div style="font-family: Segoe UI, Tahoma, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                <div style="background:${accent}; color:#fff; padding:24px; text-align:center;">
                    <h1 style="margin:0; font-size:20px;">${title}</h1>
                </div>
                <div style="padding:28px;">
                    <p>Hello <strong>${to.firstName || ''} ${to.lastName || ''}</strong>,</p>
                    <p style="margin:12px 0 20px;">
                        ${monthLine}.
                    </p>
                    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:18px;">
                        <p style="margin:0 0 8px;"><strong>Type:</strong> ${record.utilityType || '—'}</p>
                        <p style="margin:0 0 8px;"><strong>Provider:</strong> ${record.provider || '—'}</p>
                        <p style="margin:0 0 8px;"><strong>Account:</strong> ${record.accountNo || '—'}</p>
                        <p style="margin:0 0 8px;"><strong>Payment day:</strong> Day ${record.paymentDay} of the month after the bill</p>
                        ${/^\d{4}-\d{2}$/.test(ym) ? `<p style="margin:0 0 8px;"><strong>Bill month:</strong> ${ym}</p>` : ''}
                        <p style="margin:0;"><strong>Payable date:</strong> ${dueDateLabel || '—'}</p>
                    </div>
                    <div style="text-align:center; margin-top:28px;">
                        <a href="${buttonUrl}" style="background:${accent}; color:#fff; text-decoration:none; padding:12px 28px; border-radius:8px; font-weight:600; display:inline-block;">
                            Add / Pay Bill
                        </a>
                    </div>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"VeRP Notifications" <${process.env.EMAIL_USER}>`,
            to: recipientEmail,
            subject: title,
            html,
        });
    } catch (err) {
        console.error('[UtilityBillPaymentDayEmail]', err?.message || err);
    }
}
