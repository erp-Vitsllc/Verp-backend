import nodemailer from 'nodemailer';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';
import { normalizePdfAttachments } from './normalizeEmailAttachments.js';
import {
    buildAssignmentHandoverEmailAttachments,
    buildFullySignedHandoverCtx,
    hodDisplayFromEmployee,
} from './buildAssignmentHandoverEmailAttachments.js';

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function buildSummaryTableHtml(items, accent) {
    if (!items?.length) {
        return '<p style="margin:0;font-size:13px;color:#64748b;">None</p>';
    }
    const rows = items
        .map(
            (row) => `
        <tr style="border-bottom:1px solid #e2e8f0;">
          <td style="padding:8px 10px;font-weight:600;">${escapeHtml(row.assetId || '—')}</td>
          <td style="padding:8px 10px;">${escapeHtml(row.name || '—')}</td>
          ${row.note ? `<td style="padding:8px 10px;font-size:12px;color:#64748b;">${escapeHtml(row.note)}</td>` : ''}
        </tr>`,
        )
        .join('');
    const hasNote = items.some((r) => r.note);
    return `
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin:8px 0 16px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="background:${accent};color:#0f172a;">
          <th style="text-align:left;padding:10px;font-weight:700;">Asset ID</th>
          <th style="text-align:left;padding:10px;font-weight:700;">Name</th>
          ${hasNote ? '<th style="text-align:left;padding:10px;font-weight:700;">Outcome</th>' : ''}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/**
 * After assignee accepts/declines a bulk assignment batch, notify assigner and asset controller
 * (not the assignee) with accepted/declined lists and a signed handover PDF for accepted assets.
 */
export async function notifyBulkAssignmentResponseEmails(req, {
    acceptedMongoIds = [],
    rejectedMongoIds = [],
    acceptedSummary = [],
    rejectedSummary = [],
    assigneeEmployee,
    assignerId,
    responderEmployeeId,
    responderName = 'Assignee',
    comments = '',
    isDelegate = false,
}) {
    try {
        const acceptedIds = [...new Set((acceptedMongoIds || []).map(String).filter(Boolean))];
        const rejectedIds = [...new Set((rejectedMongoIds || []).map(String).filter(Boolean))];
        if (!acceptedIds.length && !rejectedIds.length) return;

        const assigneeName = assigneeEmployee
            ? `${assigneeEmployee.firstName || ''} ${assigneeEmployee.lastName || ''}`.trim()
            : 'Assignee';

        let assigneeFull = assigneeEmployee;
        if (assigneeEmployee?._id && (!assigneeEmployee.department || !assigneeEmployee.signature)) {
            assigneeFull = await EmployeeBasic.findById(assigneeEmployee._id)
                .select('firstName lastName employeeId department signature primaryReportee companyEmail workEmail')
                .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail')
                .lean()
                .catch(() => assigneeEmployee);
        }

        const assigner = assignerId
            ? await EmployeeBasic.findById(assignerId)
                  .select('firstName lastName employeeId signature companyEmail workEmail department')
                  .lean()
                  .catch(() => null)
            : null;

        const signer = responderEmployeeId
            ? await EmployeeBasic.findById(responderEmployeeId)
                  .select('firstName lastName signature companyEmail workEmail')
                  .lean()
                  .catch(() => null)
            : null;

        const assetController = await getDepartmentHOD('assetcontroller').catch(() => null);

        const assigneeIdStr =
            assigneeFull?._id?.toString?.() || (assigneeEmployee?._id && String(assigneeEmployee._id)) || null;
        const responderIdStr = responderEmployeeId?.toString?.() || String(responderEmployeeId || '');

        const recipientEmployees = [assigner, assetController].filter(Boolean);
        const toEmails = [];
        for (const emp of recipientEmployees) {
            const empId = emp._id?.toString?.();
            if (assigneeIdStr && empId === assigneeIdStr) continue;
            if (responderIdStr && empId === responderIdStr) continue;
            const { email } = resolveEmployeeEmail(emp);
            if (!email || toEmails.includes(email)) continue;
            if (assigneeIdStr && assigneeFull) {
                const assigneeMail = resolveEmployeeEmail(assigneeFull).email;
                if (assigneeMail && email === assigneeMail) continue;
            }
            toEmails.push(email);
        }
        if (!toEmails.length) {
            console.warn('[notifyBulkAssignmentResponseEmails] No recipient emails');
            return;
        }

        const attachments = [];

        if (acceptedIds.length) {
            const handoverAtt = await buildAssignmentHandoverEmailAttachments(req, acceptedIds, {
                ...buildFullySignedHandoverCtx({
                    assigner,
                    assignee: assigneeFull,
                    assigneeName,
                    employeeCode: assigneeFull?.employeeId || '—',
                    department:
                        (assigneeFull?.department && String(assigneeFull.department).trim()) || '—',
                    hodName: hodDisplayFromEmployee(assigneeFull),
                }),
                assigner,
                assignee: assigneeFull,
                filenameBase: 'bulk-assignment-accepted-handover',
            });
            if (handoverAtt?.length) attachments.push(...handoverAtt);
        }

        const att = normalizePdfAttachments(attachments);
        const delegateNote = isDelegate
            ? `<p style="font-size:13px;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;padding:10px 12px;border-radius:8px;margin:0 0 16px;">
                Responded by <strong>${escapeHtml(responderName)}</strong> on behalf of the assignee.</p>`
            : '';

        const commentsBlock = comments
            ? `<p style="margin:16px 0 0;font-size:14px;"><strong>Comments:</strong> ${escapeHtml(comments)}</p>`
            : '';

        const introHtml = `
            ${delegateNote}
            <p style="margin:0 0 12px;font-size:15px;">
              <strong>${escapeHtml(responderName)}</strong> completed a bulk asset assignment review for
              <strong>${escapeHtml(assigneeName)}</strong>${assigneeFull?.employeeId ? ` (${escapeHtml(assigneeFull.employeeId)})` : ''}.
            </p>
            <p style="margin:0 0 8px;font-size:14px;color:#334155;">
              <strong>${acceptedIds.length}</strong> accepted · <strong>${rejectedIds.length}</strong> declined
            </p>

            <h3 style="margin:20px 0 6px;font-size:15px;color:#166534;border-bottom:2px solid #86efac;padding-bottom:4px;">Accepted</h3>
            ${buildSummaryTableHtml(acceptedSummary, '#dcfce7')}

            <h3 style="margin:20px 0 6px;font-size:15px;color:#991b1b;border-bottom:2px solid #fecaca;padding-bottom:4px;">Declined</h3>
            ${buildSummaryTableHtml(rejectedSummary, '#fee2e2')}
            ${commentsBlock}
            ${
                att.length
                    ? '<p style="font-size:12px;color:#64748b;margin:16px 0 0;">Attachment: signed <strong>Asset Handover Form</strong> for accepted asset(s).</p>'
                    : ''
            }`;

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;
        if (!emailUser || !emailPass) return;

        let smtpHost = process.env.SMTP_HOST || 'smtp.office365.com';
        if (emailUser.includes('@gmail.com')) smtpHost = 'smtp.gmail.com';

        const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: parseInt(process.env.SMTP_PORT, 10) || 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        });

        const subject = `Bulk assignment response: ${acceptedIds.length} accepted, ${rejectedIds.length} declined — ${assigneeName}`;

        await transporter.sendMail({
            from: `"VeRP Asset Management" <${emailUser}>`,
            to: toEmails.join(','),
            subject,
            html: `
                <div style="font-family:Segoe UI,Arial,sans-serif;color:#334155;max-width:640px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                    <div style="background:linear-gradient(135deg,#1d4ed8 0%,#2563eb 100%);padding:24px;color:#fff;">
                        <h2 style="margin:0;font-size:20px;font-weight:800;">Bulk assignment — response summary</h2>
                        <p style="margin:8px 0 0;opacity:.9;font-size:13px;">${escapeHtml(assigneeName)}</p>
                    </div>
                    <div style="padding:24px;background:#fff;">
                        ${introHtml}
                    </div>
                    <div style="padding:16px;background:#f8fafc;font-size:11px;color:#94a3b8;text-align:center;border-top:1px solid #e2e8f0;">VeRP Asset Management</div>
                </div>
            `,
            ...(att.length ? { attachments: att } : {}),
        });
    } catch (e) {
        console.error('[notifyBulkAssignmentResponseEmails]', e?.message || e);
    }
}
