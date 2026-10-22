import nodemailer from 'nodemailer';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';
import { rememberSentEmail } from './emailDispatch.js';

function mailRecordIds(recordIds) {
    const list = Array.isArray(recordIds) ? recordIds : [recordIds];
    return [...new Set(list.map((id) => String(id || '').trim()).filter(Boolean))];
}

/** Save the exact message that went out, keyed to this request's task. */
async function keepSentMail({ from, to, subject, html, recordIds, emailType }) {
    const ids = mailRecordIds(recordIds);
    if (!ids.length || !String(html || '').trim()) return;
    await Promise.all(ids.map((recordId) => rememberSentEmail({
        from,
        to,
        subject,
        html,
        recordId,
        module: 'Attendance',
        emailType,
    }).catch((err) => {
        console.warn('[AttendanceEmail] copy not saved:', err?.message || err);
    })));
}

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

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function withDecisionIntent(path, intent) {
    const raw = String(path || '').trim();
    if (!raw) return '';
    const hashIndex = raw.indexOf('#');
    const beforeHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
    const hash = hashIndex >= 0 ? raw.slice(hashIndex) : '';
    const join = beforeHash.includes('?') ? '&' : '?';
    return `${beforeHash}${join}intent=${encodeURIComponent(intent)}${hash}`;
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
    recordIds = [],
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
        const fallbackGroup = String(employee?.staffType || 'office').trim().toLowerCase() || 'office';
        const path =
            String(reviewPath || '').trim() ||
            `/HRM/Attendance/mark?date=${encodeURIComponent(String(date || ''))}&staffType=${encodeURIComponent(fallbackGroup)}&group=${encodeURIComponent(fallbackGroup)}&blinkEmployee=${encodeURIComponent(String(employee?._id || ''))}`;
        const buttonUrl = path.startsWith('http')
            ? path
            : `${base}${path.startsWith('/') ? path : `/${path}`}`;
        const acceptUrl = withDecisionIntent(buttonUrl, 'approved');
        const rejectUrl = withDecisionIntent(buttonUrl, 'rejected');
        const actionLabel = String(buttonLabel || '').trim() || 'Open employee attendance';
        const decisionButtons = String(reviewPath || '').trim()
            ? `
                        <div style="text-align:center;margin-top:24px;">
                            <a href="${acceptUrl}" style="background:#16A34A;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block;margin:0 6px 8px;">
                                Accept
                            </a>
                            <a href="${rejectUrl}" style="background:#DC2626;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block;margin:0 6px 8px;">
                                Reject
                            </a>
                            <p style="margin:8px 0 0;font-size:12px;color:#64748b;">These open the leave card so you can confirm. Only the person this request is pending with can accept or reject it.</p>
                        </div>`
            : `
                        <div style="text-align:center;margin-top:24px;">
                            <a href="${buttonUrl}" style="background:#EA3D2F;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block;">
                                ${actionLabel}
                            </a>
                        </div>`;
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
            ? 'If you <strong>Approve</strong>, the day is marked as Authorized Leave. Authorized leave is unpaid. If you <strong>Reject</strong>, it stays upcoming.'
            : isFutureLate
              ? 'If you <strong>Approve</strong>, the day shows green as Late arrival approved. If you <strong>Reject</strong>, it stays upcoming.'
              : isFutureEarly
                ? 'If you <strong>Approve</strong>, the day shows green as Early go approved. If you <strong>Reject</strong>, it stays upcoming.'
                : isYellow
                  ? 'If you <strong>Confirm</strong>, the day becomes Present (green). If you <strong>Reject</strong>, it stays as it is.'
                  : 'If you <strong>Approve</strong>, the requested leave status is applied. If you <strong>Reject</strong>, the current status stays.';
        const html = `
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
                        ${decisionButtons}
                    </div>
                </div>
            `;

        await mail.transporter.sendMail({
            from: `"VeRP System" <${mail.from}>`,
            to,
            subject: subjectLine,
            html,
        });
        await keepSentMail({
            from: `"VeRP System" <${mail.from}>`,
            to: [to],
            subject: subjectLine,
            html,
            recordIds,
            emailType: title,
        });
    } catch (err) {
        console.error('[AttendanceLeaveEmail] request email failed:', err?.message || err);
    }
}

function hourTypeLabel(value) {
    return value === 'waived' ? 'Waived off' : 'Authorized';
}

/** Tell the previous person that the hour request type was changed. */
export async function sendHourTypeChangedEmail({
    toEmp,
    changedByName = '',
    employeeName = '',
    date = '',
    fromType = '',
    toType = '',
    hours = 0,
    recordIds = [],
}) {
    try {
        const mail = createTransport();
        const { email: to } = resolveEmployeeEmail(toEmp || {});
        if (!mail || !to) return;
        const who = changedByName || 'Someone';
        const subject = `Hour request changed to ${hourTypeLabel(toType)}`;
        const html = `
            <p>Hello,</p>
            <p><strong>${who}</strong> changed the hour request for <strong>${employeeName || 'the employee'}</strong> on <strong>${date || 'this day'}</strong>.</p>
            <p><strong>From:</strong> ${hourTypeLabel(fromType)}<br><strong>To:</strong> ${hourTypeLabel(toType)}<br><strong>Approved hours:</strong> ${hours}</p>
        `;
        await mail.transporter.sendMail({
            from: `"VeRP System" <${mail.from}>`,
            to,
            subject,
            html,
        });
        await keepSentMail({
            from: mail.from,
            to: [to],
            subject,
            html,
            recordIds,
            emailType: 'Hour request type changed',
        });
    } catch (err) {
        console.error('[AttendanceChangeEmail] hour type change email failed:', err?.message || err);
    }
}

/**
 * Notify the primary reportee or flowchart HR that an attendance edit is waiting.
 */
export async function sendAttendanceChangeRequestEmail({
    approver,
    employee,
    date,
    requestedByName = '',
    currentLabel,
    requestedLabel,
    timeIn = '',
    timeOut = '',
    reason = '',
    stage = 'pending_reportee',
    reviewPath = '/HRM/Attendance?bell=1',
    recordIds = [],
}) {
    try {
        const mail = createTransport();
        const { email: to } = resolveEmployeeEmail(approver || {});
        if (!mail || !to) {
            console.warn('[AttendanceChangeEmail] Missing SMTP or approver email.');
            return;
        }

        const hrStep = String(stage || '') === 'pending_hr';
        const approverName = personName(approver);
        const empName = personName(employee);
        const base = emailFrontendUrl();
        const path = String(reviewPath || '/HRM/Attendance?bell=1');
        const buttonUrl = path.startsWith('http')
            ? path
            : `${base}${path.startsWith('/') ? path : `/${path}`}`;
        const onMarkPage = path.includes('/HRM/Attendance/mark');
        const title = hrStep ? 'Attendance Change — HR Approval' : 'Attendance Change Approval';
        const intro = hrStep
            ? 'is waiting for your approval. Approving it updates the attendance day.'
            : 'was submitted and needs your approval. Approving it sends the change to HR. The day stays as it is until HR approves.';
        const times =
            timeIn || timeOut
                ? `<p style="margin:0 0 8px;"><strong>Time:</strong> ${timeIn || '—'} – ${timeOut || '—'}</p>`
                : '';

        const subjectLine = `${title}: ${empName} — ${date}`;
        const html = `
                <div style="font-family:Segoe UI,Tahoma,sans-serif;color:#1e293b;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                    <div style="background:#EA3D2F;color:#fff;padding:20px;text-align:center;">
                        <h1 style="margin:0;font-size:20px;">${title}</h1>
                    </div>
                    <div style="padding:24px;">
                        <p>Dear <strong>${approverName}</strong>,</p>
                        <p>Attendance for <strong>${empName}</strong> (${employee?.employeeId || '—'}) ${intro}</p>
                        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:16px 0;">
                            <p style="margin:0 0 8px;"><strong>Date:</strong> ${date || '—'}</p>
                            <p style="margin:0 0 8px;"><strong>Changed by:</strong> ${requestedByName || '—'}</p>
                            <p style="margin:0 0 8px;"><strong>Currently:</strong> ${currentLabel || 'Not marked'}</p>
                            <p style="margin:0 0 8px;"><strong>Requested:</strong> ${requestedLabel || '—'}</p>
                            ${times}
                            ${reason ? `<p style="margin:0;"><strong>Reason:</strong> ${reason}</p>` : ''}
                        </div>
                        <p>${onMarkPage ? 'Open Mark Attendance to approve or reject this request.' : 'Open the Attendance bell to approve or reject this change.'}</p>
                        <div style="text-align:center;margin-top:24px;">
                            <a href="${buttonUrl}" style="background:#EA3D2F;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block;">
                                Open attendance
                            </a>
                        </div>
                    </div>
                </div>
            `;
        await mail.transporter.sendMail({
            from: `"VeRP System" <${mail.from}>`,
            to,
            subject: subjectLine,
            html,
        });
        await keepSentMail({
            from: `"VeRP System" <${mail.from}>`,
            to: [to],
            subject: subjectLine,
            html,
            recordIds,
            emailType: title,
        });
    } catch (err) {
        console.error('[AttendanceChangeEmail] request email failed:', err?.message || err);
    }
}

/**
 * Tell the previous approver that an hour request was rejected and needs action.
 */
export async function sendAttendanceChangeRejectedEmail({
    approver,
    employee,
    date,
    rejectedByName = '',
    reason = '',
    requestedLabel = 'Hour approval',
    requestNoun = 'Hour',
    reviewPath = '/HRM/Attendance/mark',
    recordIds = [],
}) {
    try {
        const mail = createTransport();
        const { email: to } = resolveEmployeeEmail(approver || {});
        if (!mail || !to) {
            console.warn('[AttendanceChangeEmail] Missing SMTP or approver email for rejection.');
            return;
        }
        const approverName = personName(approver);
        const empName = personName(employee);
        const noun = String(requestNoun || 'Hour').trim() || 'Hour';
        const base = emailFrontendUrl();
        const path = String(reviewPath || '/HRM/Attendance/mark');
        const buttonUrl = path.startsWith('http')
            ? path
            : `${base}${path.startsWith('/') ? path : `/${path}`}`;
        const safeReason = escapeHtml(reason);
        const safeBy = escapeHtml(rejectedByName || 'Approver');

        const subjectLine = `${noun} request rejected: ${empName} — ${date}`;
        const html = `
                <div style="font-family:Segoe UI,Tahoma,sans-serif;color:#1e293b;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                    <div style="background:#EA3D2F;color:#fff;padding:20px;text-align:center;">
                        <h1 style="margin:0;font-size:20px;">${escapeHtml(noun)} request rejected</h1>
                    </div>
                    <div style="padding:24px;">
                        <p>Dear <strong>${escapeHtml(approverName)}</strong>,</p>
                        <p>This request was <strong>rejected</strong> and sent back to you. Reapply it or reject it from your task bar.</p>
                        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:16px 0;">
                            <p style="margin:0 0 8px;"><strong>Employee:</strong> ${escapeHtml(empName)} (${escapeHtml(employee?.employeeId || '—')})</p>
                            <p style="margin:0 0 8px;"><strong>Date:</strong> ${escapeHtml(date || '—')}</p>
                            <p style="margin:0 0 8px;"><strong>Request:</strong> ${escapeHtml(requestedLabel || 'Hour approval')}</p>
                            <p style="margin:0 0 8px;"><strong>Rejected by:</strong> ${safeBy}</p>
                            <p style="margin:0;"><strong>Reason:</strong> ${safeReason || '—'}</p>
                        </div>
                        <p>Open the task on your bar. Use Reapply to send it on, or Reject to send it back.</p>
                        <div style="text-align:center;margin-top:24px;">
                            <a href="${buttonUrl}" style="background:#EA3D2F;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block;">
                                Open attendance
                            </a>
                        </div>
                    </div>
                </div>
            `;
        await mail.transporter.sendMail({
            from: `"VeRP System" <${mail.from}>`,
            to,
            subject: subjectLine,
            html,
        });
        await keepSentMail({
            from: `"VeRP System" <${mail.from}>`,
            to: [to],
            subject: subjectLine,
            html,
            recordIds,
            emailType: `${noun} request rejected`,
        });
    } catch (err) {
        console.error('[AttendanceChangeEmail] rejection email failed:', err?.message || err);
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
    rejectReason = '',
    recordIds = [],
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
        const why = String(rejectReason || '').trim();
        const base = emailFrontendUrl();
        const group = String(employee?.staffType || 'office').trim().toLowerCase() || 'office';
        const day = String(date || '').trim();
        const buttonUrl = `${base}/HRM/Attendance/mark?date=${encodeURIComponent(day)}&staffType=${encodeURIComponent(group)}&group=${encodeURIComponent(group)}&blinkEmployee=${encodeURIComponent(String(employee?._id || ''))}`;
        const body = approved
            ? `Your leave request for <strong>${shownDate}</strong> was <strong>approved</strong>. Status set to <strong>${finalLabel || requestedLabel}</strong>.`
            : `Your leave request for <strong>${shownDate}</strong> was <strong>rejected</strong>. Status remains <strong>${finalLabel || 'unchanged'}</strong>.${
                  why ? ` Reason: <strong>${escapeHtml(why)}</strong>.` : ''
              }`;

        const subjectLine = `Attendance leave ${approved ? 'approved' : 'rejected'}: ${shownDate}`;
        const html = `
                <div style="font-family:Segoe UI,Tahoma,sans-serif;color:#1e293b;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                    <div style="background:${accent};color:#fff;padding:20px;text-align:center;">
                        <h1 style="margin:0;font-size:20px;">${title}</h1>
                    </div>
                    <div style="padding:24px;">
                        <p>Dear <strong>${empName}</strong>,</p>
                        <p>${body}</p>
                        <div style="text-align:center;margin-top:24px;">
                            <a href="${buttonUrl}" style="background:#EA3D2F;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block;">
                                Open this day
                            </a>
                        </div>
                    </div>
                </div>
            `;
        await mail.transporter.sendMail({
            from: `"VeRP System" <${mail.from}>`,
            to,
            subject: subjectLine,
            html,
        });
        await keepSentMail({
            from: `"VeRP System" <${mail.from}>`,
            to: [to],
            subject: subjectLine,
            html,
            recordIds,
            emailType: title,
        });
    } catch (err) {
        console.error('[AttendanceLeaveEmail] decision email failed:', err?.message || err);
    }
}

/**
 * Tell flowchart HR and the primary reportee that a permitted user already changed the day.
 * This is a notice. It does not ask them to approve.
 */
export async function sendAttendanceDirectChangeEmail({
    recipients = [],
    actor,
    employee,
    date,
    previousLabel = '',
    nextLabel = '',
    timeIn = '',
    timeOut = '',
    reason = '',
    recordIds = [],
}) {
    try {
        const mail = createTransport();
        if (!mail) {
            console.warn('[AttendanceDirectChangeEmail] Missing SMTP.');
            return;
        }
        const actorEmail = resolveEmployeeEmail(actor || {}).email;
        const seen = new Set();
        const targets = [];
        for (const person of recipients) {
            const { email } = resolveEmployeeEmail(person || {});
            const key = String(email || '').trim().toLowerCase();
            if (!key || seen.has(key)) continue;
            if (actorEmail && key === String(actorEmail).trim().toLowerCase()) continue;
            seen.add(key);
            targets.push({ person, email });
        }
        if (!targets.length) return;

        const actorName = personName(actor);
        const empName = personName(employee);
        const times =
            timeIn || timeOut
                ? `<p style="margin:0 0 8px;"><strong>Time:</strong> ${timeIn || '—'} – ${timeOut || '—'}</p>`
                : '';
        const base = emailFrontendUrl();
        const group = String(employee?.staffType || 'office').trim().toLowerCase() || 'office';
        const buttonUrl = `${base}/HRM/Attendance/mark?date=${encodeURIComponent(String(date || ''))}&staffType=${encodeURIComponent(group)}&group=${encodeURIComponent(group)}&blinkEmployee=${encodeURIComponent(String(employee?._id || ''))}`;

        const subjectLine = `Attendance updated: ${empName} — ${date || ''}`;
        await Promise.all(
            targets.map(async ({ person, email }) => {
                const html = `
                        <div style="font-family:Segoe UI,Tahoma,sans-serif;color:#1e293b;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                            <div style="background:#1B2A4A;color:#fff;padding:20px;text-align:center;">
                                <h1 style="margin:0;font-size:20px;">Attendance updated</h1>
                            </div>
                            <div style="padding:24px;">
                                <p>Dear <strong>${personName(person)}</strong>,</p>
                                <p><strong>${actorName}</strong> changed attendance for <strong>${empName}</strong> (${employee?.employeeId || '—'}). The day is already updated.</p>
                                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:16px 0;">
                                    <p style="margin:0 0 8px;"><strong>Date:</strong> ${date || '—'}</p>
                                    <p style="margin:0 0 8px;"><strong>Changed by:</strong> ${actorName}</p>
                                    <p style="margin:0 0 8px;"><strong>Was:</strong> ${previousLabel || 'Not marked'}</p>
                                    <p style="margin:0 0 8px;"><strong>Now:</strong> ${nextLabel || '—'}</p>
                                    ${times}
                                    ${reason ? `<p style="margin:0;"><strong>Reason:</strong> ${reason}</p>` : ''}
                                </div>
                                <div style="text-align:center;margin-top:24px;">
                                    <a href="${buttonUrl}" style="background:#EA3D2F;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block;">
                                        Open attendance
                                    </a>
                                </div>
                            </div>
                        </div>
                    `;
                await mail.transporter.sendMail({
                    from: `"VeRP System" <${mail.from}>`,
                    to: email,
                    subject: subjectLine,
                    html,
                });
                await keepSentMail({
                    from: `"VeRP System" <${mail.from}>`,
                    to: [email],
                    subject: subjectLine,
                    html,
                    recordIds,
                    emailType: 'Attendance updated',
                });
            }),
        );
    } catch (err) {
        console.error('[AttendanceDirectChangeEmail] notice failed:', err?.message || err);
    }
}
