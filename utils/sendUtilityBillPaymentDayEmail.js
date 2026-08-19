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
 * Accounts payment-day email — only when payable date == today.
 * Urgent: bill overdue / please clear this month's bill.
 */
export async function sendUtilityBillPaymentDayEmail({
    recipient,
    record,
    dueDateLabel = '',
    yearMonth = '',
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
        const title = 'Utility Bill Overdue — Please Clear';
        const accent = '#dc2626';

        let monthLine = "This month's bill is";
        if (/^\d{4}-\d{2}$/.test(ym)) {
            const [y, m] = ym.split('-');
            const probe = new Date(Number(y), Number(m) - 1, 1);
            const monthLabel = probe.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
            const nowYm = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
            monthLine =
                ym === nowYm
                    ? "This month's bill is"
                    : `The <strong>${monthLabel}</strong> bill is`;
        }

        const html = `
            <div style="font-family: Segoe UI, Tahoma, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                <div style="background:${accent}; color:#fff; padding:24px; text-align:center;">
                    <h1 style="margin:0; font-size:22px;">${title}</h1>
                </div>
                <div style="padding:28px;">
                    <p>Hello <strong>${to.firstName || ''} ${to.lastName || ''}</strong>,</p>
                    <p style="margin:12px 0 20px;">
                        Today is the utility <strong>payment day</strong>. ${monthLine}
                        <strong>overdue</strong> — please clear the bill as soon as possible
                        (pay or send to Zoho).
                    </p>
                    <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:10px; padding:18px;">
                        <p style="margin:0 0 8px;"><strong>Type:</strong> ${record.utilityType || '—'}</p>
                        <p style="margin:0 0 8px;"><strong>Provider:</strong> ${record.provider || '—'}</p>
                        <p style="margin:0 0 8px;"><strong>Account:</strong> ${record.accountNo || '—'}</p>
                        <p style="margin:0 0 8px;"><strong>Payment day:</strong> Day ${record.paymentDay} every month</p>
                        ${/^\d{4}-\d{2}$/.test(ym) ? `<p style="margin:0 0 8px;"><strong>Bill month:</strong> ${ym}</p>` : ''}
                        <p style="margin:0;"><strong>Payable date:</strong> ${dueDateLabel || '—'}</p>
                    </div>
                    <div style="text-align:center; margin-top:28px;">
                        <a href="${buttonUrl}" style="background:${accent}; color:#fff; text-decoration:none; padding:12px 28px; border-radius:8px; font-weight:600; display:inline-block;">
                            Clear Utility Bill
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
