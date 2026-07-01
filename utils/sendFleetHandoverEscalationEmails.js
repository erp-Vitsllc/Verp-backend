import nodemailer from 'nodemailer';
import { buildHandoverAssignDetailsUrl, formatEmployeeDisplayName } from './vehicleHandoverApprovalFlow.js';
import { pickEffectiveEmail } from './resolveEmployeeEmail.js';

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
            <p><strong>Day ${daysElapsed}</strong> since the request was raised. Please approve or reject within <strong>${daysLeft} day(s)</strong> (if no response by day 10 the system will auto-accept and forward to HR).</p>
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
    const detailUrl = buildHandoverAssignDetailsUrl(asset._id, historyId);
    const subject = `Reminder (day ${daysElapsed}): vehicle handover pending — ${asset.assetId || asset.name || 'Vehicle'}`;

    const recipients = new Map();
    const push = (emp) => {
        const email = pickEffectiveEmail(emp);
        if (!email) return;
        const key = email.toLowerCase();
        if (recipients.has(key)) return;
        recipients.set(key, formatEmployeeDisplayName(emp) || 'there');
    };

    push(actionRecipient);
    push(adminOfficer);
    if (assigneeDoc?.companyEmail?.trim()) {
        push(assigneeDoc);
    }

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
    reportsCopied,
    autoAcceptDay = 10,
}) {
    const detailUrl = buildHandoverAssignDetailsUrl(asset._id, historyId);
    const assigneeName = formatEmployeeDisplayName(assigneeDoc) || 'the assigned employee';
    const subject = `Auto-accepted: vehicle handover — ${asset.assetId || asset.name || 'Vehicle'}`;

    const html = `
        <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:640px;margin:0 auto;">
            <h2 style="color:#1d4ed8;">Vehicle handover auto-accepted</h2>
            <p>No approval or rejection was received within <strong>${autoAcceptDay} days</strong> for <strong>${vehicleLabel(asset)}</strong>.</p>
            <p>The system has automatically accepted the handover for <strong>${assigneeName}</strong> and forwarded it to <strong>HR approval</strong>.</p>
            ${
                reportsCopied
                    ? '<p>Vehicle Assessment Report and Body Condition Report were copied from the previous assignment (photos and data unchanged; only the assignee name was updated).</p>'
                    : '<p>Complete the Vehicle Assessment and Body Condition reports in VeRP if they are still missing.</p>'
            }
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
