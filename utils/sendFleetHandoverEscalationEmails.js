import nodemailer from 'nodemailer';
import { buildHandoverAssignDetailsUrl, formatEmployeeDisplayName } from './vehicleHandoverApprovalFlow.js';
import { pickEffectiveEmail } from './resolveEmployeeEmail.js';
import { VEHICLE_HANDOVER_EMAILS_ENABLED } from './vehicleHandoverEmailGate.js';
import { buildEmailDedupeKey, sendErpEmail } from './emailDispatch.js';

async function sendHtmlEmail({ to, subject, html }) {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!to?.trim() || !emailUser || !emailPass) return;

    const transporter = nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });

    await transporter
        .sendMail({
            from: `"VeRP Portal" <${emailUser}>`,
            to,
            subject,
            html,
        })
        .catch(() => null);
}

function vehicleLabel(asset) {
    return `${asset?.name || 'Vehicle'} (${asset?.assetId || asset?._id || ''})`;
}

function buildReminderHtml({ recipientName, asset, daysElapsed, daysLeft, detailUrl }) {
    return `
        <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:640px;margin:0 auto;">
            <h2 style="color:#b45309;">Vehicle handover — action required</h2>
            <p>Hello <strong>${recipientName}</strong>,</p>
            <p>The vehicle handover for <strong>${vehicleLabel(asset)}</strong> is still waiting for approval.</p>
            <p><strong>Day ${daysElapsed}</strong> since the handover was raised. <strong>${daysLeft} day(s)</strong> left to add the body condition images.</p>
            <p>If those images are still missing on day 10, this handover stays on this step. The Admin Officer gets a vehicle bell, an email, and a system task. It will not update or go to the next step without images.</p>
            <p style="text-align:center;margin:28px 0;">
                <a href="${detailUrl}" style="background:#2563eb;color:#fff;padding:12px 26px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;">Open handover</a>
            </p>
        </div>
    `;
}

export async function sendFleetHandoverReminderEmail({
    asset,
    historyId,
    assigneeDoc,
    actionRecipient,
    adminOfficer,
    daysElapsed,
    daysLeft,
}) {
    if (!VEHICLE_HANDOVER_EMAILS_ENABLED) return;
    const detailUrl = buildHandoverAssignDetailsUrl(asset._id, historyId);
    const subject = `Reminder (day ${daysElapsed}): vehicle handover pending — ${asset.assetId || asset.name || 'Vehicle'}`;

    const adminEmail = pickEffectiveEmail(adminOfficer);
    if (!adminEmail?.trim()) return;

    const recipients = new Map([[adminEmail.toLowerCase(), formatEmployeeDisplayName(adminOfficer) || 'there']]);

    for (const [email, name] of recipients.entries()) {
        await sendHtmlEmail({
            to: email,
            subject,
            html: buildReminderHtml({
                recipientName: name,
                asset,
                daysElapsed,
                daysLeft,
                detailUrl,
            }),
        });
    }
}

export async function sendFleetHandoverAutoAcceptedEmail({
    asset,
    historyId,
    assigneeDoc,
    assigner,
    adminOfficer,
    autoAcceptDay = 10,
}) {
    if (!VEHICLE_HANDOVER_EMAILS_ENABLED) return;
    const detailUrl = buildHandoverAssignDetailsUrl(asset._id, historyId);
    const assigneeName = formatEmployeeDisplayName(assigneeDoc) || 'the assigned employee';
    const subject = `Auto-accepted: vehicle handover — ${asset.assetId || asset.name || 'Vehicle'}`;

    const html = `
        <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:640px;margin:0 auto;">
            <h2 style="color:#1d4ed8;">Vehicle handover auto-accepted</h2>
            <p>No approval or rejection was received within <strong>${autoAcceptDay} days</strong> for <strong>${vehicleLabel(asset)}</strong>.</p>
            <p>The system has automatically accepted the handover for <strong>${assigneeName}</strong> and forwarded it to <strong>HR approval</strong>.</p>
            <p>Body condition images already on this handover were kept. Missing images are not filled from old pictures.</p>
            <p style="text-align:center;margin:28px 0;">
                <a href="${detailUrl}" style="background:#2563eb;color:#fff;padding:12px 26px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;">View handover</a>
            </p>
        </div>
    `;

    const recipients = new Map();
    const push = (emp) => {
        const email = pickEffectiveEmail(emp);
        if (!email) return;
        recipients.set(email.toLowerCase(), formatEmployeeDisplayName(emp) || 'there');
    };

    push(assigneeDoc);
    push(assigner);
    push(adminOfficer);

    for (const [email] of recipients.entries()) {
        await sendHtmlEmail({ to: email, subject, html });
    }
}

export async function sendFleetHandoverImagesMissingEmail({
    asset,
    historyId,
    adminOfficer,
    assigneeDoc,
    message,
}) {
    const to = pickEffectiveEmail(adminOfficer);
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!to?.trim() || !emailUser || !emailPass) return { sent: false };

    const transporter = nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });
    const detailUrl = buildHandoverAssignDetailsUrl(asset._id, historyId);
    const adminName = formatEmployeeDisplayName(adminOfficer) || 'Admin Officer';
    const assigneeName = formatEmployeeDisplayName(assigneeDoc);
    const subject = `Vehicle handover images missing — ${asset.assetId || asset.name || 'Vehicle'}`;
    const html = `
        <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:640px;margin:0 auto;">
            <h2 style="color:#b45309;">Vehicle handover images were not added</h2>
            <p>Hello <strong>${adminName}</strong>,</p>
            <p>${message}</p>
            <p><strong>Vehicle:</strong> ${vehicleLabel(asset)}</p>
            ${assigneeName ? `<p><strong>Assigned to:</strong> ${assigneeName}</p>` : ''}
            <p>Add the body condition images on this handover. Do not update it or send it to the next step without images.</p>
            <p style="text-align:center;margin:28px 0;">
                <a href="${detailUrl}" style="background:#2563eb;color:#fff;padding:12px 26px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;">Open handover</a>
            </p>
        </div>
    `;

    return sendErpEmail({
        transporter,
        from: `"VeRP Portal" <${emailUser}>`,
        to,
        subject,
        html,
        dedupeKey: buildEmailDedupeKey([
            'VehicleHandoverImagesMissing',
            String(asset._id || ''),
            String(historyId || ''),
        ]),
        module: 'hrm.vehicle.handover_images_missing',
        emailType: 'VehicleHandoverImagesMissing',
        recordId: String(historyId || asset._id || ''),
        metadata: {
            eventKey: 'hrm.vehicle.handover_images_missing',
            subjectCategory: 'reminder',
        },
    });
}
