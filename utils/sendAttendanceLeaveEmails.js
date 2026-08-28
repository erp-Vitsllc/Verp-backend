import nodemailer from 'nodemailer';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';

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

/**
 * Notify primary reportee that an employee requested a leave status change.
 */
export async function sendAttendanceLeaveRequestEmail({
    manager,
    employee,
    date,
    dateLabel = '',
    requestedLabel,
    currentLabel,
    reason = '',
    kind = 'leave',
    attachmentName = '',
    reviewPath = '',
    buttonLabel = '',
    emailTitle = '',
}) {
    try {
        const mail = createTransport();
        const { email: to } = resolveEmployeeEmail(manager || {});
        if (!mail || !to) {
            console.warn('[AttendanceLeaveEmail] Missing SMTP or manager email for leave request.');
            return;
        }

        const kindKey = String(kind || '');
        const isYellow = kindKey === 'yellow';
        const isFutureLeave = kindKey === 'future_leave';
        const isFutureAnnual = kindKey === 'future_annual';
        const isFutureLate = kindKey === 'future_late';
        const isFutureEarly = kindKey === 'future_early';
        const empName = personName(employee);
        const mgrName = personName(manager);
        const base = emailFrontendUrl();
        const path =
            String(reviewPath || '').trim() ||
            `/dashboard?focusAttendance=1&attendanceEmployeeId=${encodeURIComponent(
                String(employee._id || ''),
            )}&attendanceDate=${encodeURIComponent(String(date || ''))}`;
        const buttonUrl = path.startsWith('http')
            ? path
            : `${base}${path.startsWith('/') ? path : `/${path}`}`;
        const actionLabel = String(buttonLabel || '').trim() || 'Open employee attendance';
        const shownDate = dateLabel || date;
        const title = String(emailTitle || '').trim()
            ? String(emailTitle).trim()
            : isFutureLate
            ? 'Late Arrival Request'
            : isFutureEarly
              ? 'Early Go Request'
              : isFutureAnnual
                ? 'Annual Leave Request'
              : isFutureLeave
                ? 'Future Leave Request'
                : isYellow
                  ? 'Attendance Clarification Request'
                  : 'Attendance Leave Request';
        const accent = isYellow ? '#F1C40F' : isFutureLate || isFutureEarly ? '#2ECC71' : '#EA3D2F';
        const headerColor = isYellow ? '#1e293b' : '#fff';
        const subjectLine = `${title}: ${empName} — ${shownDate}`;
        const intro =
            isFutureLate || isFutureEarly || isFutureLeave || isFutureAnnual
                ? `has sent a request for a future working day:`
                : isYellow
                  ? `has asked you to confirm their attendance day as <strong>Present</strong>:`
                  : `has asked you to change their leave status:`;
        const confirmLine = isFutureAnnual
            ? 'If you <strong>Approve</strong>, the day is marked as Annual Leave. If you <strong>Reject</strong>, it stays upcoming.'
            : isFutureLeave
            ? 'If you <strong>Approve</strong>, choose Paid or Unpaid Authorized Leave. If you <strong>Reject</strong>, it stays upcoming.'
            : isFutureLate
              ? 'If you <strong>Approve</strong>, the day shows green as Late arrival approved. If you <strong>Reject</strong>, it stays upcoming.'
              : isFutureEarly
                ? 'If you <strong>Approve</strong>, the day shows green as Early go approved. If you <strong>Reject</strong>, it stays upcoming.'
                : isYellow
                  ? 'If you <strong>Confirm</strong>, the day becomes Present (green). If you <strong>Reject</strong>, it stays as it is.'
                  : 'If you <strong>Approve</strong>, the requested leave status is applied. If you <strong>Reject</strong>, the current status stays.';

        await mail.transporter.sendMail({
            from: `"VeRP System" <${mail.from}>`,
            to,
            subject: subjectLine,
            html: `
                <div style="font-family:Segoe UI,Tahoma,sans-serif;color:#1e293b;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                    <div style="background:${accent};color:${headerColor};padding:20px;text-align:center;">
                        <h1 style="margin:0;font-size:20px;">${title}</h1>
                    </div>
                    <div style="padding:24px;">
                        <p>Dear <strong>${mgrName}</strong>,</p>
                        <p><strong>${empName}</strong> (${employee.employeeId || '—'}) ${intro}</p>
                        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:16px 0;">
                            <p style="margin:0 0 8px;"><strong>Date:</strong> ${shownDate}</p>
                            <p style="margin:0 0 8px;"><strong>Currently marked:</strong> ${currentLabel || '—'}</p>
                            <p style="margin:0 0 8px;"><strong>Asking for:</strong> ${requestedLabel || '—'}</p>
                            ${reason ? `<p style="margin:0 0 8px;"><strong>Reason:</strong> ${reason}</p>` : ''}
                            ${attachmentName ? `<p style="margin:0;"><strong>Attachment:</strong> ${attachmentName}</p>` : ''}
                        </div>
                        <p>${confirmLine}</p>
                        <div style="text-align:center;margin-top:24px;">
                            <a href="${buttonUrl}" style="background:#EA3D2F;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block;">
                                ${actionLabel}
                            </a>
                        </div>
                    </div>
                </div>
            `,
        });
    } catch (err) {
        console.error('[AttendanceLeaveEmail] request email failed:', err?.message || err);
    }
}

/**
 * Notify employee of HOD approve/reject on company email.
 */
export async function sendAttendanceLeaveDecisionEmail({
    employee,
    date,
    dateLabel = '',
    decision,
    requestedLabel,
    finalLabel,
}) {
    try {
        const mail = createTransport();
        const { email: to } = resolveEmployeeEmail(employee || {});
        if (!mail || !to) {
            console.warn('[AttendanceLeaveEmail] Missing SMTP or employee company email for decision.');
            return;
        }

        const empName = personName(employee);
        const approved = String(decision || '').toLowerCase() === 'approved';
        const accent = approved ? '#16a34a' : '#EA3D2F';
        const title = approved ? 'Leave Request Approved' : 'Leave Request Rejected';
        const shownDate = dateLabel || date;
        const body = approved
            ? `Your leave request for <strong>${shownDate}</strong> was <strong>approved</strong>. Status set to <strong>${finalLabel || requestedLabel}</strong>.`
            : `Your leave request for <strong>${shownDate}</strong> was <strong>rejected</strong>. Status remains <strong>${finalLabel || 'unchanged'}</strong>.`;

        await mail.transporter.sendMail({
            from: `"VeRP System" <${mail.from}>`,
            to,
            subject: `Attendance leave ${approved ? 'approved' : 'rejected'}: ${shownDate}`,
            html: `
                <div style="font-family:Segoe UI,Tahoma,sans-serif;color:#1e293b;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                    <div style="background:${accent};color:#fff;padding:20px;text-align:center;">
                        <h1 style="margin:0;font-size:20px;">${title}</h1>
                    </div>
                    <div style="padding:24px;">
                        <p>Dear <strong>${empName}</strong>,</p>
                        <p>${body}</p>
                    </div>
                </div>
            `,
        });
    } catch (err) {
        console.error('[AttendanceLeaveEmail] decision email failed:', err?.message || err);
    }
}
