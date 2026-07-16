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
 * kind: pending_hr | approved | rejected
 */
export async function sendUtilityEntryStatusEmail({
    recipient,
    request,
    kind = 'pending_hr',
} = {}) {
    try {
        const transporter = createTransport();
        const to = await resolveRecipient(recipient);
        const { email: recipientEmail } = resolveEmployeeEmail(to || {});
        if (!transporter || !to || !recipientEmail) {
            console.warn('[UtilityEntryStatusEmail] Missing SMTP or recipient email.');
            return;
        }

        const frontendUrl = emailFrontendUrl();
        const path = `/HRM/Asset/UtilityBills?statusChangeId=${encodeURIComponent(String(request._id))}&review=1`;
        const buttonUrl = `${frontendUrl}${path}`;
        const actionLabel =
            request.requestedStatus === 'Active' ? 'Activation' : 'Deactivation';

        const titles = {
            pending_hr: `Utility ${actionLabel} — HR Approval Required`,
            approved: `Utility ${actionLabel} Approved`,
            rejected: `Utility ${actionLabel} Rejected`,
        };
        const colors = {
            pending_hr: '#2563eb',
            approved: '#16a34a',
            rejected: '#dc2626',
        };
        const bodies = {
            pending_hr: `A utility ${actionLabel.toLowerCase()} request needs your approval.`,
            approved: `Your utility ${actionLabel.toLowerCase()} request was approved by HR.`,
            rejected: `Your utility ${actionLabel.toLowerCase()} request was rejected by HR.`,
        };

        const html = `
            <div style="font-family: Segoe UI, Tahoma, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                <div style="background:${colors[kind] || colors.pending_hr}; color:#fff; padding:24px; text-align:center;">
                    <h1 style="margin:0; font-size:22px;">${titles[kind] || titles.pending_hr}</h1>
                </div>
                <div style="padding:28px;">
                    <p>Hello <strong>${to.firstName || ''} ${to.lastName || ''}</strong>,</p>
                    <p style="margin:12px 0 20px;">${bodies[kind] || bodies.pending_hr}</p>
                    <div style="background:#f8fafc; border:1px solid #f1f5f9; border-radius:10px; padding:18px;">
                        <p style="margin:0 0 8px;"><strong>Type:</strong> ${request.utilityType || '—'}</p>
                        <p style="margin:0 0 8px;"><strong>Account:</strong> ${request.accountNo || '—'}</p>
                        <p style="margin:0 0 8px;"><strong>Provider:</strong> ${request.provider || '—'}</p>
                        <p style="margin:0 0 8px;"><strong>Change:</strong> ${request.currentStatus} → ${request.requestedStatus}</p>
                        <p style="margin:0 0 8px;"><strong>Reason:</strong> ${request.reason || '—'}</p>
                        <p style="margin:0;"><strong>Requested by:</strong> ${request.requestedByName || '—'}</p>
                    </div>
                    <div style="text-align:center; margin-top:28px;">
                        <a href="${buttonUrl}" style="display:inline-block; background:${colors[kind] || colors.pending_hr}; color:#fff; text-decoration:none; padding:12px 28px; border-radius:8px; font-weight:600;">
                            Open in VERP
                        </a>
                    </div>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: recipientEmail,
            subject: titles[kind] || titles.pending_hr,
            html,
        });
    } catch (err) {
        console.error('[UtilityEntryStatusEmail]', err?.message || err);
    }
}
