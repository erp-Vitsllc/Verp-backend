import nodemailer from 'nodemailer';
import { syncDashboardAction } from './syncDashboard.js';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';

export const SALARY_ENROLLMENT_REQUEST_TYPE = 'Salary Enrollment';

function displayName(row) {
    return `${row?.firstName || ''} ${row?.lastName || ''}`.trim() || row?.employeeId || 'Employee';
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
    const isUpdate = String(profile?.status || '') === 'created';
    const extra1 = isUpdate
        ? `${employeeName} (${employeeId}) salary profile update is waiting for HR approval.`
        : `${employeeName} (${employeeId}) salary profile is waiting for HR approval.`;
    const extra2 = isUpdate ? 'Salary profile update approval' : 'Salary profile approval';

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
        subject: `Salary profile approval — ${employeeName}`,
        html: `
            <p>Hello ${hrName},</p>
            <p><strong>${submittedByName || 'A user'}</strong> submitted a salary profile for
            <strong>${employeeName}</strong> (${employeeId}) and it needs your approval.</p>
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
