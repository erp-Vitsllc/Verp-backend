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
            .select('firstName lastName companyEmail workEmail personalEmail email employeeId profileStatus status')
            .lean();
        if (fresh) return fresh;
    }
    return person;
}

/**
 * Email HR (pending) or requester (approved / rejected) for utility bill payment.
 */
export async function sendUtilityBillPaymentEmail({
    recipient,
    bill,
    kind = 'pending', // pending | approved | rejected
}) {
    try {
        const transporter = createTransport();
        const to = await resolveRecipient(recipient);
        const { email: recipientEmail } = resolveEmployeeEmail(to || {});
        if (!transporter || !to || !recipientEmail) {
            console.warn('[UtilityBillPaymentEmail] Missing SMTP or recipient email.');
            return;
        }

        const frontendUrl = emailFrontendUrl();
        const detailsPath = `/HRM/Asset/UtilityBills/details/${encodeURIComponent(bill.entryId)}?billId=${encodeURIComponent(String(bill._id))}`;
        const buttonUrl = `${frontendUrl}${detailsPath}`;
        const amountTxt = `AED ${Number(bill.amount || 0).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        })}`;

        const titles = {
            pending: 'Utility Bill Payment — HR Approval Required',
            approved: 'Utility Bill Payment Approved',
            rejected: 'Utility Bill Payment Rejected',
        };
        const colors = {
            pending: '#0d9488',
            approved: '#16a34a',
            rejected: '#dc2626',
        };

        const paymentByLabel =
            bill.paymentBy === 'employee_balance'
                ? 'Balance pay by employee'
                : bill.paymentBy === 'company'
                  ? 'Pay by company'
                  : '—';

        const html = `
            <div style="font-family: Segoe UI, Tahoma, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                <div style="background:${colors[kind] || colors.pending}; color:#fff; padding:24px; text-align:center;">
                    <h1 style="margin:0; font-size:22px;">${titles[kind] || titles.pending}</h1>
                </div>
                <div style="padding:28px;">
                    <p>Hello <strong>${to.firstName || ''} ${to.lastName || ''}</strong>,</p>
                    <p style="margin:12px 0 20px;">
                        ${
                            kind === 'pending'
                                ? 'A utility bill payment exceeding the monthly rental requires your approval.'
                                : kind === 'approved'
                                  ? 'Your utility bill payment request was approved.'
                                  : 'Your utility bill payment request was rejected and the bill was removed.'
                        }
                    </p>
                    <div style="background:#f8fafc; border:1px solid #f1f5f9; border-radius:10px; padding:18px;">
                        <p style="margin:0 0 8px;"><strong>Type:</strong> ${bill.utilityType || '—'}</p>
                        <p style="margin:0 0 8px;"><strong>Amount:</strong> ${amountTxt}</p>
                        <p style="margin:0 0 8px;"><strong>Monthly rental:</strong> AED ${Number(bill.monthlyRental || 0).toLocaleString()}</p>
                        <p style="margin:0;"><strong>Payment by:</strong> ${paymentByLabel}</p>
                    </div>
                    <div style="text-align:center; margin-top:28px;">
                        <a href="${buttonUrl}" style="background:${colors[kind] || colors.pending}; color:#fff; padding:12px 28px; text-decoration:none; border-radius:8px; font-weight:700; display:inline-block;">
                            Open Utility Details
                        </a>
                    </div>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: recipientEmail,
            subject: `${titles[kind] || titles.pending}: ${bill.utilityType || 'Utility'} — ${amountTxt}`,
            html,
        });
    } catch (err) {
        console.error('[UtilityBillPaymentEmail] Failed:', err?.message || err);
    }
}
