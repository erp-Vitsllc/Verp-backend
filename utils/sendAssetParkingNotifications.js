import nodemailer from 'nodemailer';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';

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

const sendOperationalExpiryMail = async ({ to, subject, html }) => {
    const transporter = getTransporter();
    if (!transporter || !to) return false;
    await transporter.sendMail({
        fromName: 'Asset Management',
        to,
        subject,
        html,
    });
    return true;
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

export const sendParkingReminderEmail = async ({ asset, assignedEmployee, assetController, daysLeft }) => {
    try {
        const recipients = [assignedEmployee, assetController].filter(Boolean);
        for (const emp of recipients) {
            const { email } = resolveEmployeeEmail(emp);
            if (!email) continue;
            await sendOperationalExpiryMail({
                to: email,
                subject: `Reminder: On Leave ends in ${daysLeft} day(s) for ${asset.assetId}`,
                html: `<p>Asset <strong>${asset.assetId} - ${asset.name}</strong> is On Leave and will expire in <strong>${daysLeft} day(s)</strong>.</p>
                       <p>Please take action before expiry.</p>
                       <p><a href="${assetDetailUrl(asset)}">Open asset in VeRP</a></p>`,
            });
        }
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
