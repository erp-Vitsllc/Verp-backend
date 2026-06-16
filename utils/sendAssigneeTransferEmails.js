import nodemailer from 'nodemailer';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';
import { resolveEmployeeEmail, resolveEmployeeEmailTargets } from './resolveEmployeeEmail.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendAssetAssignmentEmail } from './sendAssetAssignmentEmail.js';
import { buildAssignmentHandoverEmailAttachments, hodDisplayFromEmployee } from './buildAssignmentHandoverEmailAttachments.js';
import { normalizePdfAttachments } from './normalizeEmailAttachments.js';

function buildTransporter() {
    const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
    const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;
    if (!emailUser || !emailPass) return null;
    let smtpHost = process.env.SMTP_HOST || 'smtp.office365.com';
    if (emailUser.includes('@gmail.com')) smtpHost = 'smtp.gmail.com';
    return nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(process.env.SMTP_PORT, 10) || 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });
}

function pushUnique(list, emp, role) {
    if (!emp?._id) return;
    const id = String(emp._id);
    if (list.some((r) => String(r.emp._id) === id)) return;
    list.push({ emp, role });
}

async function loadEmployeeWithReportee(id) {
    if (!id) return null;
    const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
    return EmployeeBasic.findById(id)
        .select('firstName lastName employeeId companyEmail workEmail department signature primaryReportee enablePortalAccess')
        .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail')
        .lean();
}

/**
 * Notify new assignee, asset controller, initiator, old assignee, and HODs (primary reportees) of both parties.
 */
export async function sendAssigneeTransferRequestEmails({
    req,
    asset,
    oldAssignee,
    newAssignee,
    initiator,
    attachments = [],
}) {
    if (!asset || !newAssignee) return { sent: 0 };

    const att = normalizePdfAttachments(attachments);
    const recipients = [];

    pushUnique(recipients, newAssignee, 'target');

    const ac = await getDepartmentHOD('assetcontroller');
    pushUnique(recipients, ac, 'asset_controller');

    if (initiator) pushUnique(recipients, initiator, 'sender');
    if (oldAssignee) pushUnique(recipients, oldAssignee, 'previous_assignee');

    for (const emp of [oldAssignee, newAssignee]) {
        const hod = emp?.primaryReportee;
        if (hod && typeof hod === 'object' && hod._id) {
            pushUnique(recipients, hod, 'hod');
        }
    }

    let sent = 0;
    for (const { emp, role } of recipients) {
        try {
            const isTarget = role === 'target';
            const ok = await sendAssetAssignmentEmail({
                asset,
                employee: newAssignee,
                recipient: emp,
                attachments: att,
                notificationContext: 'transfer',
                transferRecipientRole: role === 'hod_' ? 'hod' : role,
                pendingAssignment: isTarget,
            });
            if (ok) sent += 1;
        } catch (e) {
            console.error(`[sendAssigneeTransferRequestEmails] ${role}:`, e?.message || e);
        }
    }

    return { sent };
}

/**
 * After new assignee accepts or rejects — notify initiator, old assignee, AC, and both HODs.
 */
export async function sendAssigneeTransferResultEmails({
    asset,
    oldAssignee,
    newAssignee,
    initiator,
    approver,
    approved,
    comment = '',
    attachments = [],
}) {
    const transporter = buildTransporter();
    if (!transporter) return;

    const frontendUrl = resolveFrontendBaseUrl();
    const link = `${frontendUrl}/HRM/Asset/details/${asset._id || asset.id}`;
    const att = normalizePdfAttachments(attachments);

    const recipients = [];
    if (oldAssignee) pushUnique(recipients, oldAssignee, 'previous_assignee');
    const ac = await getDepartmentHOD('assetcontroller');
    pushUnique(recipients, ac, 'asset_controller');
    if (initiator) pushUnique(recipients, initiator, 'sender');
    for (const emp of [oldAssignee, newAssignee]) {
        const hod = emp?.primaryReportee;
        if (hod && typeof hod === 'object' && hod._id) {
            pushUnique(recipients, hod, 'hod');
        }
    }

    const approverName = approver
        ? `${approver.firstName || ''} ${approver.lastName || ''}`.trim() || approver.employeeId
        : 'Approver';
    const outcome = approved
        ? `approved — asset is now assigned to ${newAssignee?.firstName || ''} ${newAssignee?.lastName || ''}`.trim()
        : 'rejected — asset remains with the previous assignee';

    for (const { emp } of recipients) {
        const { to } = resolveEmployeeEmailTargets(emp);
        if (!to) continue;
        const name = `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || emp.employeeId || 'User';
        const subject = approved
            ? `Assignee transfer approved: ${asset.assetId}`
            : `Assignee transfer rejected: ${asset.assetId}`;

        const html = `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;">
                <div style="background:${approved ? '#10b981' : '#dc2626'};color:#fff;padding:16px 20px;">
                    <h2 style="margin:0;font-size:18px;">Assignee Transfer ${approved ? 'Approved' : 'Rejected'}</h2>
                </div>
                <div style="padding:20px;color:#334155;">
                    <p>Dear ${name},</p>
                    <p><strong>${approverName}</strong> has <strong>${approved ? 'approved' : 'rejected'}</strong> the assignee transfer for <strong>${asset.assetId} — ${asset.name}</strong>.</p>
                    <p>Result: ${outcome}.</p>
                    ${comment ? `<p><strong>Comment:</strong> ${comment}</p>` : ''}
                    <p style="margin-top:20px;"><a href="${link}" style="background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">View Asset</a></p>
                </div>
            </div>`;

        try {
            await transporter.sendMail({
                fromName: approverName,
                to,
                subject,
                html,
                ...(att.length ? { attachments: att } : {}),
            });
        } catch (e) {
            console.error('[sendAssigneeTransferResultEmails]', e?.message || e);
        }
    }
}

export async function buildAssigneeTransferHandoverAttachments(req, assetId, { assigner, oldAssignee, newAssignee }) {
    try {
        return await buildAssignmentHandoverEmailAttachments(req, [String(assetId)], {
            assigneeName: `${newAssignee?.firstName || ''} ${newAssignee?.lastName || ''}`.trim() || '—',
            employeeCode: newAssignee?.employeeId || '—',
            department: (newAssignee?.department && String(newAssignee.department).trim()) || '—',
            hodName: hodDisplayFromEmployee(newAssignee),
            assigner,
            assignerName: assigner ? `${assigner.firstName || ''} ${assigner.lastName || ''}`.trim() : '—',
            filenameBase: 'assignee-transfer-handover',
        });
    } catch (e) {
        console.error('[buildAssigneeTransferHandoverAttachments]', e?.message || e);
        return [];
    }
}

export { loadEmployeeWithReportee };
