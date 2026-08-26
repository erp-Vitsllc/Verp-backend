import nodemailer from 'nodemailer';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Company from '../models/Company.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import {
    resolveEmployeeEmailWithReporteeLoaded,
    employeeDisplayName,
    getFallbackEmailNote,
    resolveEmployeeEmail,
} from './resolveEmployeeEmail.js';
import {
    buildEmailDedupeKey,
    sendErpEmail,
} from './emailDispatch.js';

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

function normalizeAction(action, isReassign) {
    const key = String(action || '').trim().toLowerCase();
    if (key === 'return' || key === 'reassign' || key === 'assign') return key;
    return isReassign ? 'reassign' : 'assign';
}

function actionLabels(action) {
    if (action === 'return') {
        return { word: 'Returned', lower: 'returned', subjectVerb: 'Returned (Unassigned)' };
    }
    if (action === 'reassign') {
        return { word: 'Reassigned', lower: 'reassigned', subjectVerb: 'Reassigned' };
    }
    return { word: 'Assigned', lower: 'assigned', subjectVerb: 'Assigned' };
}

async function resolvePartyEmail({ type, id, name }) {
    const kind = String(type || 'Employee').trim();
    const partyId = String(id || '').trim();
    if (!partyId) return null;

    if (kind === 'Company') {
        const company = await Company.findById(partyId).select('name companyId email').lean();
        const email = String(company?.email || '').trim() || null;
        if (!email) return null;
        return {
            email,
            greetName: company?.name || name || 'Company',
            subjectTarget: company?.name || name || 'Company',
            fallbackNoteHtml: '',
        };
    }

    const employee = await EmployeeBasic.findById(partyId)
        .select(
            'firstName lastName employeeId companyEmail workEmail primaryReportee status profileStatus',
        )
        .populate(
            'primaryReportee',
            'firstName lastName employeeId companyEmail workEmail status profileStatus',
        )
        .lean();

    if (!employee) return null;

    const { email, isFallbackToReportee, employee: resolved } =
        await resolveEmployeeEmailWithReporteeLoaded(employee);
    if (!email) return null;

    const empName = employeeDisplayName(employee);
    const greetName = isFallbackToReportee
        ? employeeDisplayName(resolved?.primaryReportee || employee.primaryReportee)
        : empName;

    return {
        email,
        greetName,
        subjectTarget: empName,
        fallbackNoteHtml: isFallbackToReportee ? getFallbackEmailNote(empName, greetName) : '',
    };
}

async function collectHrAndAdminOfficerEmails() {
    const emails = [];
    const [hr, adminOfficer] = await Promise.all([
        getDepartmentHOD('hr'),
        getDepartmentHOD('admincontroller'),
    ]);
    for (const emp of [hr, adminOfficer]) {
        if (!emp) continue;
        const { email } = resolveEmployeeEmail(emp);
        if (email) emails.push(email);
    }
    return emails;
}

function buildAssignmentHtml({
    greetName,
    fallbackNoteHtml = '',
    summary,
    labels,
    assigneeLine,
    buttonUrl,
}) {
    return `
            <div style="font-family: Segoe UI, Tahoma, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                <div style="background:#0d9488; color:#fff; padding:24px; text-align:center;">
                    <h1 style="margin:0; font-size:22px;">Utility ${labels.word}</h1>
                </div>
                <div style="padding:28px;">
                    <p>Hello <strong>${greetName}</strong>,</p>
                    ${fallbackNoteHtml}
                    <p style="margin:12px 0 20px;">
                        A <strong>${summary.type}</strong> utility has been <strong>${labels.lower}</strong>
                        ${assigneeLine}.
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
                            Open in ERP
                        </a>
                    </div>
                </div>
            </div>
        `;
}

/**
 * Notify parties when a utility entry is assigned / reassigned / returned.
 * One email: TO = assignee (or Admin Officer on return), CC = HR + Admin Officer stakeholders.
 */
export async function sendUtilityAssignmentEmail({
    entry,
    assignedToType = 'Employee',
    assignedToId = '',
    assignedToName = '',
    previousAssignedToName = '',
    isReassign = false,
    action = '',
} = {}) {
    try {
        const transporter = createTransport();
        if (!transporter) {
            console.warn('[UtilityAssignmentEmail] SMTP credentials missing.');
            return;
        }

        const normalizedAction = normalizeAction(action, isReassign);
        const labels = actionLabels(normalizedAction);
        const summary = entrySummaryLines(entry);
        const entryId = String(entry.id || entry._id || '');
        const frontendUrl = emailFrontendUrl();
        const detailsPath = `/HRM/Asset/UtilityBills/details/${encodeURIComponent(entryId)}`;
        const buttonUrl = `${frontendUrl}${detailsPath}`;

        const nextName = String(assignedToName || '').trim() || 'assignee';
        const prevName = String(previousAssignedToName || '').trim() || 'previous assignee';

        let assigneeLine = `to <strong>${nextName}</strong>`;
        if (normalizedAction === 'return') {
            assigneeLine = `and is now <strong>unassigned</strong> (previously ${prevName})`;
        } else if (normalizedAction === 'reassign') {
            assigneeLine = `from <strong>${prevName}</strong> to <strong>${nextName}</strong>`;
        }

        const stakeholderEmails = await collectHrAndAdminOfficerEmails();
        let primaryTo = null;
        let greetName = 'there';
        let fallbackNoteHtml = '';

        if (normalizedAction !== 'return') {
            const target = await resolvePartyEmail({
                type: assignedToType,
                id: assignedToId,
                name: assignedToName,
            });
            if (target?.email) {
                primaryTo = target.email;
                greetName = target.greetName;
                fallbackNoteHtml = target.fallbackNoteHtml;
            }
        }

        if (!primaryTo) {
            const adminOfficer = await getDepartmentHOD('admincontroller');
            const { email } = resolveEmployeeEmail(adminOfficer || {});
            primaryTo = email;
            greetName = adminOfficer
                ? employeeDisplayName(adminOfficer)
                : 'there';
        }

        if (!primaryTo) {
            console.warn(
                '[UtilityAssignmentEmail] No recipients resolved (assignee / HR / Admin Officer).',
            );
            return;
        }

        const cc = stakeholderEmails.filter(
            (e) => e.toLowerCase() !== primaryTo.toLowerCase(),
        );

        const subjectTarget =
            normalizedAction === 'return' ? summary.type : nextName;
        const subject = `${labels.subjectVerb}: ${summary.type} — ${subjectTarget}`;

        const result = await sendErpEmail({
            transporter,
            from: process.env.EMAIL_USER,
            to: primaryTo,
            cc,
            subject,
            html: buildAssignmentHtml({
                greetName,
                fallbackNoteHtml,
                summary,
                labels,
                assigneeLine,
                buttonUrl,
            }),
            dedupeKey: buildEmailDedupeKey([
                'UtilityAssignment',
                entryId,
                normalizedAction,
                assignedToId || 'none',
            ]),
            module: 'Utility',
            emailType: `assignment_${normalizedAction}`,
            recordId: entryId,
            metadata: { subjectCategory: 'information' },
        });

        if (result.sent) {
            console.log(
                `[UtilityAssignmentEmail] Sent ${labels.lower} notice (TO: ${primaryTo}, CC: ${cc.length})`,
            );
        }
    } catch (err) {
        console.error('[UtilityAssignmentEmail]', err?.message || err);
    }
}
