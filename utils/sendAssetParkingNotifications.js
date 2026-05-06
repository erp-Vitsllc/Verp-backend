import nodemailer from 'nodemailer';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';

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

const buildRecipients = (assignedEmployee, assetController) => {
    const recipients = [];
    const assigned = resolveEmployeeEmail(assignedEmployee || {}).email;
    const controller = resolveEmployeeEmail(assetController || {}).email;
    if (assigned) recipients.push(assigned);
    if (controller && !recipients.includes(controller)) recipients.push(controller);
    return recipients;
};

const buildRecipientsWithHod = (assignedEmployee, hodEmployee, assetController) => {
    const recipients = [];
    const assigned = resolveEmployeeEmail(assignedEmployee || {}).email;
    const hod = resolveEmployeeEmail(hodEmployee || {}).email;
    const controller = resolveEmployeeEmail(assetController || {}).email;
    if (assigned) recipients.push(assigned);
    if (hod && !recipients.includes(hod)) recipients.push(hod);
    if (controller && !recipients.includes(controller)) recipients.push(controller);
    return recipients;
};

export const sendParkingReminderEmail = async ({ asset, assignedEmployee, assetController, daysLeft }) => {
    try {
        const transporter = getTransporter();
        if (!transporter) return;
        const to = buildRecipients(assignedEmployee, assetController);
        if (!to.length) return;

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        await transporter.sendMail({
            fromName: "Asset Management",
            to: to.join(','),
            subject: `Reminder: Parking ends in ${daysLeft} day(s) for ${asset.assetId}`,
            html: `<p>Asset <strong>${asset.assetId} - ${asset.name}</strong> is in parking (On Leave) and will expire in <strong>${daysLeft} day(s)</strong>.</p>
                   <p>Please take action before expiry. Asset Controller can extend by a maximum of 10 days.</p>`
        });
    } catch (e) {
        console.error('[sendParkingReminderEmail] Non-fatal error:', e?.message || e);
    }
};

export const sendParkingExpiredEmail = async ({ asset, assignedEmployee, assetController }) => {
    try {
        const transporter = getTransporter();
        if (!transporter) return;
        const to = buildRecipients(assignedEmployee, assetController);
        if (!to.length) return;

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        await transporter.sendMail({
            fromName: "Asset Management",
            to: to.join(','),
            subject: `Asset Auto-Unassigned: ${asset.assetId}`,
            html: `<p>Parking duration has completed for <strong>${asset.assetId} - ${asset.name}</strong>.</p>
                   <p>The asset has been automatically moved to <strong>Unassigned</strong>.</p>`
        });
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
        const transporter = getTransporter();
        if (!transporter) return;
        const to = buildRecipientsWithHod(assignedEmployee, hodEmployee, assetController);
        if (!to.length) return;

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        await transporter.sendMail({
            fromName: "Asset Management",
            to: to.join(','),
            subject: `Parking Extension: ${asset.assetId} (+${extensionDays} days)`,
            html: `<p>Asset <strong>${asset.assetId} - ${asset.name}</strong> parking duration was extended.</p>
                   <p><strong>Current expiry date:</strong> ${previousExpiryDate ? new Date(previousExpiryDate).toLocaleDateString() : 'N/A'}</p>
                   <p><strong>Extension:</strong> ${extensionDays} day(s)</p>
                   <p><strong>Reason:</strong> ${reason || 'N/A'}</p>`
        });
    } catch (e) {
        console.error('[sendParkingExtensionEmail] Non-fatal error:', e?.message || e);
    }
};
