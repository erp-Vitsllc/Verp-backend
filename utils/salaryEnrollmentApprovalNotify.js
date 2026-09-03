import nodemailer from 'nodemailer';
import { syncDashboardAction } from './syncDashboard.js';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';
import { listActiveFlowchartManagementCompanyEmails } from './getManagementHOD.js';
import { SALARY_ENROLLMENT_RESET_RETENTION_DAYS } from '../constants/adminDeletionArchiveConstants.js';

export const SALARY_ENROLLMENT_REQUEST_TYPE = 'Salary Enrollment';

function displayName(row) {
    return `${row?.firstName || ''} ${row?.lastName || ''}`.trim() || row?.employeeId || 'Employee';
}

/** Flowchart role for salary enrolment approval (not the person's job title). */
export function salaryEnrollmentApproverLabel() {
    return 'HR';
}

export function salaryEnrollmentWaitingMessage({
    employeeName,
    employeeId,
    approverLabel = 'HR',
} = {}) {
    const label = String(approverLabel || 'HR').trim() || 'HR';
    const who = [employeeName, employeeId ? `(${employeeId})` : '']
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join(' ');
    return who
        ? `${who} enrolment waiting for ${label} approval.`
        : `Enrolment waiting for ${label} approval.`;
}

/** Rewrite stored extra1 so older inbox rows match the current enrolment copy. */
export function rewriteSalaryEnrollmentWaitingCopy(text, approverLabel = 'HR') {
    const label = String(approverLabel || 'HR').trim() || 'HR';
    const raw = String(text || '').trim();
    if (!raw) return '';
    if (/enrolment waiting for /i.test(raw)) {
        return raw
            .replace(/enrolment waiting for .+?(?: approval)?\.?$/i, `enrolment waiting for ${label} approval.`)
            .replace(/\s{2,}/g, ' ')
            .trim();
    }
    const updated = raw.replace(
        /\s*salary profile(?: update)? is waiting for HR approval\.?/i,
        ` enrolment waiting for ${label} approval.`,
    );
    return updated.replace(/\s{2,}/g, ' ').trim();
}

function mailTransport() {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) return null;
    return nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });
}

export function sendMailLater({ to, subject, html }) {
    const transporter = mailTransport();
    if (!transporter || !to) return;
    void transporter.sendMail({ to, subject, html }).catch((err) => {
        console.error('[salaryEnrollmentApproval] email failed:', err?.message || err);
    });
}

export async function notifySalaryEnrollmentSubmitted({
    req,
    profile,
    employee,
    hrEmployee,
    hrEmail,
    submittedByName,
}) {
    const employeeName = displayName(employee);
    const employeeId = employee?.employeeId || profile?.employeeId;
    const baseUrl = resolveFrontendBaseUrl(req);
    const href = `${baseUrl}/HRM/Salary/enroll/${encodeURIComponent(employeeId)}`;
    const approverLabel = salaryEnrollmentApproverLabel(hrEmployee);
    const extra1 = salaryEnrollmentWaitingMessage({ employeeName, employeeId, approverLabel });
    const extra2 = `Enrolment waiting for ${approverLabel}`;

    await syncDashboardAction({
        requestId: profile._id,
        requestType: SALARY_ENROLLMENT_REQUEST_TYPE,
        assignedTo: String(hrEmployee._id),
        status: 'Pending',
        subjectEmployee: employee,
        requestedByName: submittedByName || '',
        extra1,
        extra2,
        extra3: JSON.stringify({ href: `/HRM/Salary/enroll/${encodeURIComponent(employeeId)}`, employeeId }),
    });

    const hrName = displayName(hrEmployee) || 'HR';
    sendMailLater({
        to: hrEmail,
        subject: `Enrolment waiting for ${approverLabel} — ${employeeName}`,
        html: `
            <p>Hello ${hrName},</p>
            <p><strong>${submittedByName || 'A user'}</strong> submitted enrolment for
            <strong>${employeeName}</strong> (${employeeId}). It is waiting for ${approverLabel} approval.</p>
            <p><a href="${href}">Open salary profile</a></p>
        `,
    });
}

export function emailHrSalaryEnrollmentRevoked({
    req,
    employee,
    hrEmployee,
    hrEmail,
    revokedByName,
}) {
    const employeeName = displayName(employee);
    const employeeId = employee?.employeeId;
    const baseUrl = resolveFrontendBaseUrl(req);
    const href = `${baseUrl}/HRM/Salary/enroll/${encodeURIComponent(employeeId)}`;
    const hrName = displayName(hrEmployee) || 'HR';
    sendMailLater({
        to: hrEmail,
        subject: `Enrolment approval revoked — ${employeeName}`,
        html: `
            <p>Hello ${hrName},</p>
            <p>The enrolment approval sent for <strong>${employeeName}</strong> (${employeeId})
            was revoked by <strong>${revokedByName || 'a user'}</strong>.</p>
            <p>This request is no longer waiting for your approval. Enrolment status stays pending
            and the profile can be sent for approval again.</p>
            <p><a href="${href}">Open salary profile</a></p>
        `,
    });
}

export async function closeSalaryEnrollmentInbox({ profile, status, actionedBy, comment }) {
    if (!profile?._id) return;
    await syncDashboardAction({
        requestId: profile._id,
        requestType: SALARY_ENROLLMENT_REQUEST_TYPE,
        status: status || 'Dismissed',
        actionedBy: actionedBy || null,
        comment: comment || '',
        subjectEmployee: {
            employeeId: profile.employeeId,
            firstName: '',
            lastName: '',
        },
    });
}

export function emailEmployeeSalaryRejected({ employee, reason, submittedByName }) {
    const to = String(employee?.companyEmail || '').trim();
    const employeeName = displayName(employee);
    sendMailLater({
        to,
        subject: `Salary profile rejected — ${employeeName}`,
        html: `
            <p>Hello ${employeeName},</p>
            <p>Your salary profile was rejected${submittedByName ? ` by ${submittedByName}` : ''}.</p>
            <p><strong>Reason:</strong> ${String(reason || '').trim() || '—'}</p>
            <p>The enrollment status is unchanged. The submitter can update the profile and send it for approval again.</p>
        `,
    });
}

export function emailCreatorSalaryApproved({ creatorEmail, creatorName, employee }) {
    const employeeName = displayName(employee);
    sendMailLater({
        to: String(creatorEmail || '').trim(),
        subject: `Salary profile approved — ${employeeName}`,
        html: `
            <p>Hello ${creatorName || 'there'},</p>
            <p>The salary profile for <strong>${employeeName}</strong> (${employee?.employeeId || ''}) was approved.
            The employee is now enrolled.</p>
        `,
    });
}

export async function notifyManagementSalaryEnrollmentReset({
    req,
    employeeName,
    employeeId,
    period,
    archiveId,
    resetByName,
}) {
    let emails = [];
    try {
        emails = await listActiveFlowchartManagementCompanyEmails();
    } catch (err) {
        console.error('[notifyManagementSalaryEnrollmentReset] management emails:', err?.message || err);
        return;
    }
    const to = emails.filter(Boolean).join(', ');
    if (!to) return;

    const baseUrl = resolveFrontendBaseUrl(req);
    const restoreHref = archiveId
        ? `${baseUrl}/Settings/DeletedRecords?item=${encodeURIComponent(String(archiveId))}`
        : `${baseUrl}/Settings/DeletedRecords`;
    const periodLabel =
        period?.start && period?.end ? `${period.start} — ${period.end}` : '—';
    const who = String(resetByName || 'Flowchart HR').trim() || 'Flowchart HR';
    const name = String(employeeName || employeeId || 'Employee').trim();

    sendMailLater({
        to,
        subject: `Enrolment reset — ${name}`,
        html: `
            <p>Hello,</p>
            <p><strong>${who}</strong> reset salary enrolment for <strong>${name}</strong>
            (${employeeId || '—'}).</p>
            <p>Enrolment details for <strong>${periodLabel}</strong> were moved to Deleted Records.
            They can be restored for <strong>${SALARY_ENROLLMENT_RESET_RETENTION_DAYS} days</strong>.</p>
            <p><a href="${restoreHref}">Open in Deleted Records</a></p>
        `,
    });
}
