import { syncDashboardAction } from './syncDashboard.js';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';
import { sendMailLater } from './salaryEnrollmentApprovalNotify.js';
import {
    SALARY_DMF_REQUEST_TYPE,
    currentDmfStep,
    personDisplayName,
} from './salaryDmfApproval.js';

function extraPayload({ kind, employeeId, monthKey, href }) {
    return JSON.stringify({
        kind,
        employeeId: employeeId || '',
        monthKey: monthKey || '',
        href,
    });
}

function inboxHref({ kind, employeeId, monthKey }) {
    if (kind === 'month' && monthKey) {
        return `/HRM/Salary/${encodeURIComponent(monthKey)}`;
    }
    if (employeeId) return `/HRM/Salary/enroll/${encodeURIComponent(employeeId)}`;
    return '/HRM/Salary';
}

export async function notifySalaryDmfStep({
    req,
    requestId,
    dmf,
    subjectEmployee,
    kind,
    employeeId,
    monthKey,
    requestedByName,
}) {
    const step = currentDmfStep(dmf);
    const assignedTo = step?.assignedTo?.employeeObjectId;
    if (!requestId || !assignedTo) return;

    const href = inboxHref({ kind, employeeId, monthKey });
    const subjectName = personDisplayName(subjectEmployee) || employeeId || monthKey || 'Salary';
    const extra1 =
        kind === 'month'
            ? `${monthKey} payroll waiting for ${step.label}.`
            : `${subjectName} (${employeeId || ''}) payroll waiting for ${step.label}.`.replace(' ()', '');

    await syncDashboardAction({
        requestId,
        requestType: SALARY_DMF_REQUEST_TYPE,
        assignedTo: String(assignedTo),
        status: 'Pending',
        subjectEmployee: subjectEmployee || {
            employeeId: employeeId || monthKey || '',
            firstName: subjectName,
            lastName: '',
        },
        requestedByName: requestedByName || dmf.submittedByName || '',
        extra1,
        extra2: `Pending ${step.label}`,
        extra3: extraPayload({ kind, employeeId, monthKey, href }),
    });

    const to = String(step.assignedTo?.companyEmail || '').trim();
    const assigneeName = step.assignedTo?.name || step.label;
    if (!to) return;
    const baseUrl = resolveFrontendBaseUrl(req);
    const payrollTitle =
        kind === 'month' ? `${monthKey} payroll` : `${subjectName} payroll`;
    sendMailLater({
        to,
        subject: `${payrollTitle} waiting for ${step.label}`,
        html: `
            <p>Hello ${assigneeName},</p>
            <p><strong>${payrollTitle}</strong> is waiting for ${step.label} approval.</p>
            <p><a href="${baseUrl}${href}">Open in VERP</a></p>
        `,
    });
}

export async function closeSalaryDmfInbox({ requestId, status, actionedBy, comment }) {
    if (!requestId) return;
    await syncDashboardAction({
        requestId,
        requestType: SALARY_DMF_REQUEST_TYPE,
        status: status || 'Dismissed',
        actionedBy: actionedBy || null,
        comment: comment || '',
        subjectEmployee: { employeeId: '', firstName: '', lastName: '' },
    });
}
