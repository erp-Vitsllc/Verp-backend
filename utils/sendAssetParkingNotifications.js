import nodemailer from 'nodemailer';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import { isEmployeeActiveForNotifications } from './applyEmployeeLeftUserStatus.js';

const getTransporter = () => {
    const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
    const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;
    if (!emailUser || !emailPass) return null;

    let smtpHost = process.env.SMTP_HOST || 'smtp.office365.com';
    if (emailUser.includes('@gmail.com')) smtpHost = 'smtp.gmail.com';

    return nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass }
    });
};

const assetDetailUrl = (asset) => `${emailFrontendUrl()}/HRM/Asset/details/${asset._id}?focusCard=operationalExpiry`;

const sendOperationalExpiryMail = async ({ to, cc, subject, html }) => {
    const transporter = getTransporter();
    if (!transporter || !to) return false;
    const mail = {
        fromName: 'Asset Management',
        to,
        subject,
        html,
    };
    if (cc) mail.cc = cc;
    await transporter.sendMail(mail);
    return true;
};

const escapeHtml = (value) =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

/** Employee company mailbox, otherwise the employee's HOD. Never the same address as To. */
const resolveLeaveReminderCc = (assignedEmployee, hodEmployee, toEmail) => {
    const companyEmail = String(assignedEmployee?.companyEmail || '').trim();
    let cc = null;
    if (companyEmail && isEmployeeActiveForNotifications(assignedEmployee)) {
        cc = companyEmail;
    } else if (hodEmployee) {
        cc = resolveEmployeeEmail(hodEmployee).email;
    }
    if (!cc) return null;
    if (toEmail && cc.toLowerCase() === String(toEmail).toLowerCase()) return null;
    return cc;
};

const buildLeaveExpiryHtml = ({ asset, recipient, expiresToday }) => {
    const endLabel = asset.onLeaveEndDate
        ? new Date(asset.onLeaveEndDate).toLocaleDateString('en-GB')
        : '—';
    const link = assetDetailUrl(asset);
    const headline = expiresToday
        ? 'Your assigned asset <strong>On Leave</strong> duration ends <strong>today</strong>.'
        : 'Your assigned asset <strong>On Leave</strong> duration has <strong>expired</strong>.';
    const actionLine = expiresToday
        ? 'Please <strong>extend the duration</strong> or <strong>mark the asset On Duty</strong>.'
        : 'Please <strong>extend the duration</strong> or <strong>mark the asset On Duty</strong> as soon as possible.';

    return `
        <p>Hello <strong>${recipient?.firstName || 'there'}</strong>,</p>
        <p>${headline}</p>
        <p><strong>Asset:</strong> ${asset.assetId} — ${asset.name}</p>
        <p><strong>End date:</strong> ${endLabel}</p>
        <p>${actionLine}</p>
        <p><a href="${link}">Open asset in VeRP</a></p>
    `;
};

/**
 * One email for every on-leave asset of one employee that is 5 days from expiry.
 * To: Asset Controller. Cc: employee company email, or that employee's HOD when company email is missing.
 */
export const sendParkingReminderEmail = async ({
    assets,
    assignedEmployee,
    assetController,
    hodEmployee,
    daysLeft,
}) => {
    try {
        const list = (Array.isArray(assets) ? assets : [assets]).filter(Boolean);
        if (!list.length || !assetController) return;

        const { email: toEmail } = resolveEmployeeEmail(assetController);
        if (!toEmail) return;

        const cc = resolveLeaveReminderCc(assignedEmployee, hodEmployee, toEmail);
        const ownerName = `${assignedEmployee?.firstName || ''} ${assignedEmployee?.lastName || ''}`.trim();
        const rows = list
            .map((asset) => {
                const endLabel = asset.onLeaveEndDate
                    ? new Date(asset.onLeaveEndDate).toLocaleDateString('en-GB')
                    : '—';
                return `<li><strong>${escapeHtml(asset.assetId)}</strong> — ${escapeHtml(asset.name)} — ends ${escapeHtml(endLabel)}. <a href="${assetDetailUrl(asset)}">Open asset</a></li>`;
            })
            .join('');

        await sendOperationalExpiryMail({
            to: toEmail,
            cc,
            subject: ownerName
                ? `Reminder: On Leave ends in ${daysLeft} day(s) — ${ownerName}`
                : `Reminder: On Leave ends in ${daysLeft} day(s)`,
            html: `<p>Hello <strong>${escapeHtml(assetController.firstName || 'there')}</strong>,</p>
                   <p>The following asset(s)${ownerName ? ` assigned to <strong>${escapeHtml(ownerName)}</strong>` : ''} are On Leave and end in <strong>${daysLeft} day(s)</strong>.</p>
                   <ul>${rows}</ul>
                   <p>Please extend the duration or mark the asset On Duty before expiry. Maximum total leave duration is 40 days.</p>`,
        });
    } catch (e) {
        console.error('[sendParkingReminderEmail] Non-fatal error:', e?.message || e);
    }
};

/** Email AC and assigned owner separately (company email) when leave duration ends today. */
export const sendParkingDurationCompleteEmail = async ({
    asset,
    assignedEmployee,
    assetController,
    expiresToday = true,
}) => {
    try {
        const subject = expiresToday
            ? `On Leave duration ends today: ${asset.assetId}`
            : `On Leave duration expired: ${asset.assetId}`;

        for (const emp of [assignedEmployee, assetController].filter(Boolean)) {
            const { email } = resolveEmployeeEmail(emp);
            if (!email) continue;
            await sendOperationalExpiryMail({
                to: email,
                subject,
                html: buildLeaveExpiryHtml({ asset, recipient: emp, expiresToday }),
            });
        }
    } catch (e) {
        console.error('[sendParkingDurationCompleteEmail] Non-fatal error:', e?.message || e);
    }
};

export const sendLeaveAutoUnassignedEmail = async ({ asset, parties = [], packedRole = null }) => {
    try {
        const seen = new Set();
        const custodyLabel =
            packedRole === 'hod'
                ? 'HOD'
                : packedRole === 'controller'
                  ? 'Asset Controller'
                  : 'custodian';

        for (const emp of parties) {
            const { email } = resolveEmployeeEmail(emp);
            if (!email || seen.has(email)) continue;
            seen.add(email);
            await sendOperationalExpiryMail({
                to: email,
                subject: `On Leave expired — ${asset.assetId} moved to Unassigned`,
                html: `<p>Hello <strong>${emp?.firstName || 'there'}</strong>,</p>
                       <p>The On Leave period for <strong>${asset.assetId} — ${asset.name}</strong> has ended (maximum 40 days total).</p>
                       <p>The packed asset held by the ${custodyLabel} has been automatically marked <strong>Unassigned</strong> and returned to the Asset Controller pool.</p>
                       <p><a href="${assetDetailUrl(asset)}">Open asset in VeRP</a></p>`,
            });
        }
    } catch (e) {
        console.error('[sendLeaveAutoUnassignedEmail] Non-fatal error:', e?.message || e);
    }
};

/** @deprecated Use sendLeaveAutoUnassignedEmail */
export const sendParkingExpiredEmail = async ({ asset, assignedEmployee, assetController }) => {
    try {
        for (const emp of [assignedEmployee, assetController].filter(Boolean)) {
            const { email } = resolveEmployeeEmail(emp);
            if (!email) continue;
            await sendOperationalExpiryMail({
                to: email,
                subject: `Asset Auto-Unassigned: ${asset.assetId}`,
                html: `<p>Parking duration has completed for <strong>${asset.assetId} - ${asset.name}</strong>.</p>
                       <p>The asset has been automatically moved to <strong>Unassigned</strong>.</p>
                       <p><a href="${assetDetailUrl(asset)}">Open asset in VeRP</a></p>`,
            });
        }
    } catch (e) {
        console.error('[sendParkingExpiredEmail] Non-fatal error:', e?.message || e);
    }
};

export const sendParkingExtensionEmail = async ({
    asset,
    assignedEmployee,
    hodEmployee,
    assetController,
    previousExpiryDate,
    extensionDays,
    reason
}) => {
    try {
        const recipients = [assignedEmployee, hodEmployee, assetController].filter(Boolean);
        const seen = new Set();
        for (const emp of recipients) {
            const { email } = resolveEmployeeEmail(emp);
            if (!email || seen.has(email)) continue;
            seen.add(email);
            await sendOperationalExpiryMail({
                to: email,
                subject: `On Leave Extension: ${asset.assetId} (+${extensionDays} days)`,
                html: `<p>Asset <strong>${asset.assetId} - ${asset.name}</strong> On Leave duration was extended.</p>
                       <p><strong>Previous expiry date:</strong> ${previousExpiryDate ? new Date(previousExpiryDate).toLocaleDateString('en-GB') : 'N/A'}</p>
                       <p><strong>Extension:</strong> ${extensionDays} day(s)</p>
                       <p><strong>Reason:</strong> ${reason || 'N/A'}</p>
                       <p><a href="${assetDetailUrl(asset)}">Open asset in VeRP</a></p>`,
            });
        }
    } catch (e) {
        console.error('[sendParkingExtensionEmail] Non-fatal error:', e?.message || e);
    }
};
