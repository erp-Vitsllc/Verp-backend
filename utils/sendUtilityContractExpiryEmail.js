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
 * HR utility contract expiry reminders.
 * kind: t10 | t5 | due
 */
export async function sendUtilityContractExpiryEmail({
    recipient,
    entry,
    kind = 'due',
    contractEndLabel = '',
}) {
    try {
        const transporter = createTransport();
        const to = await resolveRecipient(recipient);
        const { email: recipientEmail } = resolveEmployeeEmail(to || {});
        if (!transporter || !to || !recipientEmail) {
            console.warn('[UtilityContractExpiryEmail] Missing SMTP or recipient email.');
            return;
        }

        const frontendUrl = emailFrontendUrl();
        const entryId = String(entry._id || entry.id || '');
        const path = `/HRM/Asset/UtilityBills/details/${encodeURIComponent(entryId)}`;
        const buttonUrl = `${frontendUrl}${path}`;
        const values = entry.values || {};

        const titles = {
            t10: 'Utility Contract — Expires in 10 days',
            t5: 'Utility Contract — Expires in 5 days',
            due: 'Utility Contract — Expired today',
        };
        const bodies = {
            t10: 'A utility account contract ends in 10 days. Please review renewal or replacement.',
            t5: 'A utility account contract ends in 5 days. Please review renewal or replacement.',
            due: 'A utility account contract expires today. Please renew, replace, or deactivate the account.',
        };
        const colors = { t10: '#0d9488', t5: '#d97706', due: '#dc2626' };

        const html = `
            <div style="font-family: Segoe UI, Tahoma, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                <div style="background:${colors[kind] || colors.due}; color:#fff; padding:24px; text-align:center;">
                    <h1 style="margin:0; font-size:22px;">${titles[kind] || titles.due}</h1>
                </div>
                <div style="padding:28px;">
                    <p>Hello <strong>${to.firstName || ''} ${to.lastName || ''}</strong>,</p>
                    <p style="margin:12px 0 20px;">${bodies[kind] || bodies.due}</p>
                    <div style="background:#f8fafc; border:1px solid #f1f5f9; border-radius:10px; padding:18px;">
                        <p style="margin:0 0 8px;"><strong>Type:</strong> ${entry.type || '—'}</p>
                        <p style="margin:0 0 8px;"><strong>Provider:</strong> ${values.provider || '—'}</p>
                        <p style="margin:0 0 8px;"><strong>Account:</strong> ${values.accountNumber || '—'}</p>
                        <p style="margin:0 0 8px;"><strong>Location:</strong> ${values.location || '—'}</p>
                        <p style="margin:0;"><strong>Contract end:</strong> ${contractEndLabel || '—'}</p>
                    </div>
                    <div style="text-align:center; margin-top:28px;">
                        <a href="${buttonUrl}" style="background:${colors[kind] || colors.due}; color:#fff; text-decoration:none; padding:12px 28px; border-radius:8px; font-weight:600; display:inline-block;">
                            Open Utility Account
                        </a>
                    </div>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"VeRP Notifications" <${process.env.EMAIL_USER}>`,
            to: recipientEmail,
            subject: titles[kind] || titles.due,
            html,
        });
    } catch (err) {
        console.error('[UtilityContractExpiryEmail]', err?.message || err);
    }
}
