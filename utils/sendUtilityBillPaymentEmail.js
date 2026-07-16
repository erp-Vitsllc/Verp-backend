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
 * Utility bill workflow emails (Accounts / HR / Pay / requester updates).
 * kind: pending_accounts | pending_hr | pending_pay | approved | rejected | paid | partially_paid
 */
export async function sendUtilityBillPaymentEmail({
    recipient,
    bill,
    kind = 'pending_accounts',
    batchMeta = null,
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
        const path =
            batchMeta?.reviewPath ||
            (bill.batchId
                ? `/HRM/Asset/UtilityBills?batchId=${encodeURIComponent(String(bill.batchId))}&review=1`
                : `/HRM/Asset/UtilityBills/details/${encodeURIComponent(bill.entryId)}?billId=${encodeURIComponent(String(bill._id))}`);
        const buttonUrl = `${frontendUrl}${path}`;
        const amountTxt = `AED ${Number(bill.amount || 0).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        })}`;
        const countTxt = batchMeta?.billCount ? `${batchMeta.billCount} account(s)` : '1 account';
        const remainingTxt =
            batchMeta?.remaining != null ? ` (${batchMeta.remaining} still pending pay)` : '';

        const titles = {
            pending_accounts: 'Utility Bill — Accounts Approval Required',
            pending_hr: 'Utility Bill — HR Approval Required',
            pending_pay: 'Utility Bill — Ready to Pay',
            approved: 'Utility Bill Approved',
            rejected: 'Utility Bill Rejected',
            paid: 'Utility Bill Paid',
            partially_paid: 'Utility Bill — Partially Paid',
            pending: 'Utility Bill — Approval Required',
        };
        const colors = {
            pending_accounts: '#0d9488',
            pending_hr: '#2563eb',
            pending_pay: '#d97706',
            approved: '#16a34a',
            rejected: '#dc2626',
            paid: '#16a34a',
            partially_paid: '#d97706',
            pending: '#0d9488',
        };
        const bodies = {
            pending_accounts: 'New utility bills were submitted and need Accounts review/approval.',
            pending_hr: 'Accounts approved these utility bills. HR review/approval is required.',
            pending_pay: 'HR approved these utility bills. Please open the batch and Pay the selected amounts.',
            approved: 'Your utility bill batch was approved and is awaiting Accounts payment.',
            rejected: 'Your utility bill batch was rejected.',
            paid: 'Your utility bill batch has been marked Paid by Accounts.',
            partially_paid: `Accounts paid some bills in this batch${remainingTxt}. Remaining bills are still awaiting payment.`,
            pending: 'A utility bill requires your approval.',
        };

        const html = `
            <div style="font-family: Segoe UI, Tahoma, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                <div style="background:${colors[kind] || colors.pending}; color:#fff; padding:24px; text-align:center;">
                    <h1 style="margin:0; font-size:22px;">${titles[kind] || titles.pending}</h1>
                </div>
                <div style="padding:28px;">
                    <p>Hello <strong>${to.firstName || ''} ${to.lastName || ''}</strong>,</p>
                    <p style="margin:12px 0 20px;">${bodies[kind] || bodies.pending}</p>
                    <div style="background:#f8fafc; border:1px solid #f1f5f9; border-radius:10px; padding:18px;">
                        <p style="margin:0 0 8px;"><strong>Type:</strong> ${bill.utilityType || '—'}</p>
                        <p style="margin:0 0 8px;"><strong>Month:</strong> ${bill.billMonth || '—'}</p>
                        <p style="margin:0 0 8px;"><strong>Accounts:</strong> ${countTxt}</p>
                        <p style="margin:0;"><strong>Total amount:</strong> ${amountTxt}</p>
                    </div>
                    <div style="text-align:center; margin-top:28px;">
                        <a href="${buttonUrl}" style="background:${colors[kind] || colors.pending}; color:#fff; padding:12px 28px; text-decoration:none; border-radius:8px; font-weight:700; display:inline-block;">
                            Open Utility Bills
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
