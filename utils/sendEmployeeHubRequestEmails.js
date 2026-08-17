import nodemailer from 'nodemailer';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';
import { HUB_KIND_LABEL } from './employeeHubRequestTypes.js';

function createTransport() {
    const emailUser =
        process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
    const emailPass =
        process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;
    if (!emailUser || !emailPass) return null;
    const smtpHost =
        emailUser.includes('@gmail.com') || process.env.GMAIL_USER
            ? 'smtp.gmail.com'
            : 'smtp.office365.com';
    return {
        transporter: nodemailer.createTransport({
            host: smtpHost,
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        }),
        from: emailUser,
    };
}

function personName(person) {
    return `${person?.firstName || ''} ${person?.lastName || ''}`.trim() || 'Employee';
}

function hubLabel(kind, assetType = '') {
    const base = HUB_KIND_LABEL[kind] || 'Request';
    const area = String(assetType || '').trim();
    return area ? `${base} · ${area}` : base;
}

function dashboardUrl(requestId, requesterId) {
    const base = emailFrontendUrl();
    const qs = new URLSearchParams({ hubRequestId: String(requestId || '') });
    if (requesterId) qs.set('viewEmployee', String(requesterId));
    return `${base}/dashboard?${qs.toString()}`;
}

function wrapHtml({ accent, title, body, buttonUrl, buttonLabel }) {
    return `
        <div style="font-family:Segoe UI,Tahoma,sans-serif;color:#1e293b;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
            <div style="background:${accent};color:#fff;padding:20px;text-align:center;">
                <h1 style="margin:0;font-size:20px;">${title}</h1>
            </div>
            <div style="padding:24px;">
                ${body}
                <p style="text-align:center;margin:28px 0 8px;">
                    <a href="${buttonUrl}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;">${buttonLabel}</a>
                </p>
            </div>
        </div>
    `;
}

export async function sendEmployeeHubRequestEmails({
    manager,
    employee,
    kind,
    assetType = '',
    description = '',
    attachmentName = '',
    requestId,
}) {
    try {
        const mail = createTransport();
        if (!mail) return;
        const label = hubLabel(kind, assetType);
        const empName = personName(employee);
        const mgrName = personName(manager);
        const url = dashboardUrl(requestId, employee?._id);
        const desc = String(description || '').trim();
        const attach = String(attachmentName || '').trim();

        const { email: managerTo } = resolveEmployeeEmail(manager || {});
        const { email: employeeTo } = resolveEmployeeEmail(employee || {});

        const sharedBody = `
            <p><strong>${empName}</strong> submitted a <strong>${label}</strong> request to <strong>${mgrName}</strong>.</p>
            ${desc ? `<p style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;white-space:pre-wrap;">${desc}</p>` : ''}
            ${attach ? `<p>Attachment: ${attach}</p>` : ''}
        `;

        if (managerTo) {
            await mail.transporter.sendMail({
                from: `"VeRP System" <${mail.from}>`,
                to: managerTo,
                subject: `${label} request from ${empName}`,
                html: wrapHtml({
                    accent: '#2563eb',
                    title: `${label} request`,
                    body: `${sharedBody}<p>Open the dashboard to accept or reject this request.</p>`,
                    buttonUrl: url,
                    buttonLabel: 'Review request',
                }),
            });
        }

        if (employeeTo) {
            await mail.transporter.sendMail({
                from: `"VeRP System" <${mail.from}>`,
                to: employeeTo,
                subject: `Your ${label} request was sent to ${mgrName}`,
                html: wrapHtml({
                    accent: '#2563eb',
                    title: `${label} request sent`,
                    body: `${sharedBody}<p>You will get another email when ${mgrName} accepts or rejects it.</p>`,
                    buttonUrl: url,
                    buttonLabel: 'Open dashboard',
                }),
            });
        }
    } catch (error) {
        console.warn('[EmployeeHubRequestEmail] initiate failed:', error?.message || error);
    }
}

export async function sendEmployeeHubDecisionEmails({
    manager,
    employee,
    kind,
    assetType = '',
    decision,
    description = '',
    decisionNote = '',
    requestId,
}) {
    try {
        const mail = createTransport();
        if (!mail) return;
        const label = hubLabel(kind, assetType);
        const empName = personName(employee);
        const mgrName = personName(manager);
        const approved = String(decision || '') === 'Approved';
        const url = dashboardUrl(requestId, employee?._id);
        const note = String(decisionNote || '').trim();
        const desc = String(description || '').trim();
        const accent = approved ? '#059669' : '#e11d48';
        const verb = approved ? 'approved' : 'rejected';

        const { email: managerTo } = resolveEmployeeEmail(manager || {});
        const { email: employeeTo } = resolveEmployeeEmail(employee || {});

        const body = `
            <p><strong>${mgrName}</strong> ${verb} the <strong>${label}</strong> request from <strong>${empName}</strong>.</p>
            ${desc ? `<p style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;white-space:pre-wrap;">${desc}</p>` : ''}
            ${note ? `<p>Note: ${note}</p>` : ''}
        `;

        const html = wrapHtml({
            accent,
            title: `${label} request ${verb}`,
            body,
            buttonUrl: url,
            buttonLabel: 'Open dashboard',
        });
        const subject = `${label} request ${verb}: ${empName}`;

        for (const to of [managerTo, employeeTo].filter(Boolean)) {
            await mail.transporter.sendMail({
                from: `"VeRP System" <${mail.from}>`,
                to,
                subject,
                html,
            });
        }
    } catch (error) {
        console.warn('[EmployeeHubRequestEmail] decision failed:', error?.message || error);
    }
}
