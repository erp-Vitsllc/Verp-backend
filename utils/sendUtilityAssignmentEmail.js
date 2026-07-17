import nodemailer from 'nodemailer';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Company from '../models/Company.js';
import {
    resolveEmployeeEmailWithReporteeLoaded,
    employeeDisplayName,
    getFallbackEmailNote,
} from './resolveEmployeeEmail.js';

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

function entrySummaryLines(entry = {}) {
    const values = entry.values || {};
    return {
        type: entry.type || 'Utility',
        provider: values.provider || '—',
        accountNo: values.accountNumber || '—',
        location: values.location || '—',
        planDetails: values.planDetails || '—',
    };
}

/**
 * Notify the assignment target when a utility entry is assigned / reassigned.
 * Employee: company email → else primary reportee business email.
 * Company: company.email.
 */
export async function sendUtilityAssignmentEmail({
    entry,
    assignedToType = 'Employee',
    assignedToId = '',
    assignedToName = '',
    isReassign = false,
} = {}) {
    try {
        const transporter = createTransport();
        if (!transporter) {
            console.warn('[UtilityAssignmentEmail] SMTP credentials missing.');
            return;
        }

        const type = String(assignedToType || 'Employee').trim();
        const id = String(assignedToId || '').trim();
        if (!id) {
            console.warn('[UtilityAssignmentEmail] No assignedToId — skip email.');
            return;
        }

        let recipientEmail = null;
        let greetName = assignedToName || 'there';
        let fallbackNoteHtml = '';
        let subjectTarget = assignedToName || 'assignee';

        if (type === 'Company') {
            const company = await Company.findById(id).select('name companyId email').lean();
            recipientEmail = String(company?.email || '').trim() || null;
            greetName = company?.name || assignedToName || 'Company';
            subjectTarget = greetName;
            if (!recipientEmail) {
                console.warn(
                    `[UtilityAssignmentEmail] Company ${id} has no email — skip.`,
                );
                return;
            }
        } else {
            const employee = await EmployeeBasic.findById(id)
                .select(
                    'firstName lastName employeeId companyEmail workEmail primaryReportee status profileStatus',
                )
                .populate(
                    'primaryReportee',
                    'firstName lastName employeeId companyEmail workEmail status profileStatus',
                )
                .lean();

            if (!employee) {
                console.warn(`[UtilityAssignmentEmail] Employee ${id} not found — skip.`);
                return;
            }

            const { email, isFallbackToReportee, employee: resolved } =
                await resolveEmployeeEmailWithReporteeLoaded(employee);

            recipientEmail = email;
            if (!recipientEmail) {
                console.warn(
                    `[UtilityAssignmentEmail] No company/work email for ${employee.employeeId} and no primary reportee business email — skip.`,
                );
                return;
            }

            const empName = employeeDisplayName(employee);
            subjectTarget = empName;
            greetName = isFallbackToReportee
                ? employeeDisplayName(resolved?.primaryReportee || employee.primaryReportee)
                : empName;

            if (isFallbackToReportee) {
                fallbackNoteHtml = getFallbackEmailNote(
                    empName,
                    greetName,
                );
            }
        }

        const summary = entrySummaryLines(entry);
        const actionWord = isReassign ? 'Reassigned' : 'Assigned';
        const frontendUrl = emailFrontendUrl();
        const detailsPath = `/HRM/Asset/UtilityBills/details/${encodeURIComponent(String(entry.id || entry._id || ''))}`;
        const buttonUrl = `${frontendUrl}${detailsPath}`;

        const html = `
            <div style="font-family: Segoe UI, Tahoma, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                <div style="background:#0d9488; color:#fff; padding:24px; text-align:center;">
                    <h1 style="margin:0; font-size:22px;">Utility ${actionWord}</h1>
                </div>
                <div style="padding:28px;">
                    <p>Hello <strong>${greetName}</strong>,</p>
                    ${fallbackNoteHtml}
                    <p style="margin:12px 0 20px;">
                        A <strong>${summary.type}</strong> utility has been <strong>${actionWord.toLowerCase()}</strong>
                        to <strong>${subjectTarget}</strong>.
                    </p>
                    <div style="background:#f8fafc; border:1px solid #f1f5f9; border-radius:10px; padding:18px;">
                        <p style="margin:0 0 8px;"><strong>Type:</strong> ${summary.type}</p>
                        <p style="margin:0 0 8px;"><strong>Provider:</strong> ${summary.provider}</p>
                        <p style="margin:0 0 8px;"><strong>Account:</strong> ${summary.accountNo}</p>
                        <p style="margin:0 0 8px;"><strong>Location:</strong> ${summary.location}</p>
                        <p style="margin:0;"><strong>Plan:</strong> ${summary.planDetails}</p>
                    </div>
                    <div style="text-align:center; margin-top:28px;">
                        <a href="${buttonUrl}" style="display:inline-block; background:#0d9488; color:#fff; text-decoration:none; padding:12px 28px; border-radius:8px; font-weight:600;">
                            Open in VERP
                        </a>
                    </div>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: recipientEmail,
            subject: `${summary.type} ${actionWord}: ${subjectTarget}`,
            html,
        });

        console.log(
            `[UtilityAssignmentEmail] Sent ${actionWord.toLowerCase()} notice to ${recipientEmail}`,
        );
    } catch (err) {
        console.error('[UtilityAssignmentEmail]', err?.message || err);
    }
}
