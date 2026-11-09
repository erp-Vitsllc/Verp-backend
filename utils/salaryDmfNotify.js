import DashboardAction from '../models/DashboardAction.js';
import SalaryMonthDmf from '../models/SalaryMonthDmf.js';
import SalaryMonthPayment from '../models/SalaryMonthPayment.js';
import { syncDashboardAction } from './syncDashboard.js';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';
import { sendMailLater } from './salaryEnrollmentApprovalNotify.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import {
    SALARY_DMF_REQUEST_TYPE,
    currentDmfStep,
    personDisplayName,
} from './salaryDmfApproval.js';
import {
    buildAccountsPayrollApprovedEmailHtml,
    buildPayrollApprovalEmailHtml,
    formatPayrollApprovalWhen,
    payrollApprovalSubject,
    payrollMonthLabel,
    summarizePayrollApproval,
} from './payrollApprovalMail.js';
import { loadPayrollApprovalRows, loadPayrollSheetEmployees } from './loadPayrollApprovalRows.js';

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function extraPayload({ kind, employeeId, monthKey, href }) {
    return JSON.stringify({
        kind,
        employeeId: employeeId || '',
        monthKey: monthKey || '',
        href,
    });
}

async function deliverPayrollApprovalEmail({
    to,
    stage,
    monthKey,
    baseUrl,
    hrApproverName,
    hrApprovedAt,
    returnReason,
}) {
    const rows = await loadPayrollApprovalRows(monthKey);
    const summary = summarizePayrollApproval(rows);
    const monthLabel = payrollMonthLabel(monthKey);
    sendMailLater({
        to,
        subject: payrollApprovalSubject(stage, monthLabel),
        html: buildPayrollApprovalEmailHtml({
            stage,
            monthKey,
            monthLabel,
            summary,
            hrApproverName,
            hrApprovedAt: formatPayrollApprovalWhen(hrApprovedAt),
            returnReason,
            baseUrl,
        }),
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
    returnReason,
    silent = false,
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
        extra2: `Pending for ${step.label}`,
        extra3: extraPayload({ kind, employeeId, monthKey, href }),
    });

    const to = String(step.assignedTo?.companyEmail || '').trim();
    const assigneeName = step.assignedTo?.name || step.label;
    if (!to || silent) return;
    const baseUrl = resolveFrontendBaseUrl(req);
    const stepKey = String(step.key || '');
    if (kind === 'month' && (stepKey === 'hr' || stepKey === 'management') && monthKey) {
        const stage = stepKey === 'management' ? 'MANAGEMENT' : 'HR';
        const hrStep = (Array.isArray(dmf?.steps) ? dmf.steps : []).find((row) => row.key === 'hr');
        void deliverPayrollApprovalEmail({
            to,
            stage,
            monthKey,
            baseUrl,
            hrApproverName: hrStep?.actionedByName || '',
            hrApprovedAt: hrStep?.actionedAt || null,
            returnReason,
        }).catch((error) => {
            console.error('[payroll approval email]', monthKey, stage, error?.message || error);
        });
        return;
    }
    const payrollTitle =
        kind === 'month' ? `${monthKey} payroll` : `${subjectName} payroll`;
    const openLabel = kind === 'month' ? 'Open the payroll' : 'Open in VERP';
    const decisionLine =
        kind === 'month'
            ? `<p>Approve or reject it on that page.</p>`
            : '';
    sendMailLater({
        to,
        subject: `${payrollTitle} waiting for ${step.label}`,
        html: `
            <p>Hello ${escapeHtml(assigneeName)},</p>
            <p><strong>${escapeHtml(payrollTitle)}</strong> is waiting for ${escapeHtml(step.label)} approval.</p>
            <p><a href="${baseUrl}${href}">${openLabel}</a></p>
            ${decisionLine}
        `,
    });
}

export async function notifySalaryMonthRejected({ req, dmf, monthKey, rejectedByName, reason }) {
    const accountsStep = (Array.isArray(dmf?.steps) ? dmf.steps : []).find((step) => step.key === 'accounts');
    const to = String(accountsStep?.assignedTo?.companyEmail || '').trim();
    const name = accountsStep?.assignedTo?.name || 'Accounts';
    if (!to || !monthKey) {
        console.warn('[notifySalaryMonthRejected] Accounts has no company email for', monthKey || '');
        return;
    }
    const href = inboxHref({ kind: 'month', monthKey });
    const baseUrl = resolveFrontendBaseUrl(req);
    const who = String(rejectedByName || 'an approver').trim() || 'an approver';
    const why = String(reason || '').trim();
    sendMailLater({
        to,
        subject: `${monthKey} payroll was rejected`,
        html: `
            <p>Hello ${escapeHtml(name)},</p>
            <p><strong>${escapeHtml(monthKey)} payroll</strong> was rejected by ${escapeHtml(who)}.</p>
            ${why ? `<p>Reason: ${escapeHtml(why)}</p>` : ''}
            <p>Submit is available again on the payroll page.</p>
            <p><a href="${baseUrl}${href}">Open the payroll</a></p>
        `,
    });
}

async function payrollExcelAttachment(monthKey) {
    const monthLabel = payrollMonthLabel(monthKey);
    const employees = await loadPayrollSheetEmployees(monthKey);
    const { buildPayrollWorkbookBytes } = await import(new URL(
        '../../VERP_frontend/src/app/HRM/Salary/utils/payrollExcel.js',
        import.meta.url,
    ));
    const bytes = buildPayrollWorkbookBytes({ monthLabel, employees });
    return {
        filename: `Payroll ${monthLabel}.xlsx`,
        content: Buffer.from(bytes),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
}

async function accountsAssigneeId(dmf) {
    const step = (Array.isArray(dmf?.steps) ? dmf.steps : []).find((row) => row.key === 'accounts');
    const id = step?.assignedTo?.employeeObjectId;
    if (id) return String(id);
    const accounts = await getDepartmentHOD('accounts');
    return accounts?._id ? String(accounts._id) : '';
}

/** Bell only. Accounts sees this while the payroll is back with them, or while Update Zoho is still open. */
export async function notifyAccountsPayrollBell({ requestId, dmf, monthKey, phase }) {
    const assignedTo = await accountsAssigneeId(dmf);
    if (!requestId || !assignedTo || !monthKey) return;
    const zoho = phase === 'zoho';
    const href = inboxHref({ kind: 'month', monthKey });
    const label = payrollMonthLabel(monthKey);
    await syncDashboardAction({
        requestId,
        requestType: SALARY_DMF_REQUEST_TYPE,
        assignedTo,
        status: 'Pending',
        subjectEmployee: {
            employeeId: monthKey,
            firstName: label,
            lastName: 'payroll',
        },
        requestedByName: 'Payroll',
        extra1: zoho
            ? `${label} payroll — update Zoho.`
            : `${label} payroll waiting for Accounts.`,
        extra2: zoho ? 'Update Zoho' : 'Pending for Accounts',
        extra3: extraPayload({
            kind: zoho ? 'salary-zoho' : 'salary-accounts',
            monthKey,
            href,
        }),
    });
}

/** Open bells for payroll already sitting with Accounts, without sending another email. */
export async function syncSalaryMonthRoleBells() {
    const [approved, rejected] = await Promise.all([
        SalaryMonthDmf.find({ 'dmfApproval.status': 'approved' })
            .select('monthKey dmfApproval zohoJournalUpdatedAt')
            .lean(),
        SalaryMonthDmf.find({ 'dmfApproval.status': 'rejected' })
            .select('monthKey dmfApproval')
            .lean(),
    ]);
    for (const doc of approved || []) {
        if (!doc?.zohoJournalUpdatedAt) {
            await notifyAccountsPayrollBell({
                requestId: doc._id,
                dmf: doc.dmfApproval,
                monthKey: doc.monthKey,
                phase: 'zoho',
            });
            continue;
        }
        const open = await DashboardAction.findOne({
            requestId: doc._id,
            requestType: SALARY_DMF_REQUEST_TYPE,
            status: 'Pending',
        })
            .select('extra3')
            .lean();
        let kind = '';
        try {
            kind = JSON.parse(String(open?.extra3 || '{}'))?.kind || '';
        } catch {
            kind = '';
        }
        if (kind === 'salary-zoho') {
            await closeSalaryDmfInbox({
                requestId: doc._id,
                status: 'Approved',
                comment: 'Zoho journal published',
            });
        }
    }
    for (const doc of rejected || []) {
        await notifyAccountsPayrollBell({
            requestId: doc._id,
            dmf: doc.dmfApproval,
            monthKey: doc.monthKey,
            phase: 'accounts',
        });
    }
}

export async function notifySalaryMonthSlotReady({ dmf, monthKey }) {
    const accountsStep = (Array.isArray(dmf?.steps) ? dmf.steps : []).find((step) => step.key === 'accounts');
    const to = String(accountsStep?.assignedTo?.companyEmail || '').trim();
    if (!to || !monthKey) return;
    const monthLabel = payrollMonthLabel(monthKey);
    let attachments;
    try {
        attachments = [await payrollExcelAttachment(monthKey)];
    } catch (error) {
        console.error('[notifySalaryMonthSlotReady] excel', monthKey, error?.message || error);
    }
    sendMailLater({
        to,
        subject: `${monthKey} payroll approved — create slot`,
        html: buildAccountsPayrollApprovedEmailHtml({ monthLabel }),
        attachments,
    });
}

export function sendSalarySlotMail({
    req,
    to,
    name,
    subject,
    monthKey,
    lines,
    href,
    buttonLabel,
    attachments,
}) {
    const address = String(to || '').trim();
    if (!address || !monthKey) return;
    const path = href || inboxHref({ kind: 'month', monthKey });
    const baseUrl = resolveFrontendBaseUrl(req);
    const label = String(buttonLabel || 'Open the payroll').trim() || 'Open the payroll';
    const body = (Array.isArray(lines) ? lines : [])
        .map((line) => String(line || '').trim())
        .filter(Boolean)
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join('');
    sendMailLater({
        to: address,
        subject,
        html: `
            <p>Hello ${escapeHtml(name || '')},</p>
            ${body}
            <p><a href="${baseUrl}${path}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:8px;">${escapeHtml(label)}</a></p>
        `,
        attachments,
    });
}

export async function notifyHrSalarySlot({ payment, monthKey }) {
    const hr = await getDepartmentHOD('hr');
    const assignedTo = hr?._id ? String(hr._id) : '';
    if (!payment?._id || !assignedTo || !monthKey) return;
    const slotNo = Number(payment.paymentNo) || 0;
    const company = String(payment.companyName || '').trim();
    const href = `${inboxHref({ kind: 'month', monthKey })}?slot=${encodeURIComponent(String(payment._id))}`;
    await syncDashboardAction({
        requestId: payment._id,
        requestType: SALARY_DMF_REQUEST_TYPE,
        assignedTo,
        status: 'Pending',
        subjectEmployee: {
            employeeId: monthKey,
            firstName: slotNo ? `Slot ${slotNo}` : 'Salary slot',
            lastName: company,
        },
        requestedByName: 'Accounts',
        extra1: company
            ? `${monthKey} slot ${slotNo} (${company}) is waiting for HR.`
            : `${monthKey} slot ${slotNo} is waiting for HR.`,
        extra2: 'Pending for HR',
        extra3: JSON.stringify({
            kind: 'salary-slot',
            monthKey,
            href,
            paymentId: String(payment._id),
            slotNo,
        }),
    });
}

/** Bell for a slot already sitting with HR, including ones applied before this notice existed. */
export async function syncPendingHrSalarySlotBells() {
    const rows = await SalaryMonthPayment.find({ status: 'pending_hr' })
        .select('_id monthKey paymentNo companyName')
        .lean();
    for (const payment of rows || []) {
        await notifyHrSalarySlot({ payment, monthKey: payment.monthKey });
    }
}

export async function notifyAccountsSalarySlot({ payment, monthKey, phase }) {
    const accounts = await getDepartmentHOD('accounts');
    const assignedTo = accounts?._id;
    if (!payment?._id || !assignedTo || !monthKey) return;
    const slotNo = Number(payment.paymentNo) || 0;
    const cash = String(payment.paymentMethod || '').trim().toUpperCase() === 'CASH';
    const readyToUpdate = phase === 'update' || cash;
    const href = `${inboxHref({ kind: 'month', monthKey })}?slot=${encodeURIComponent(String(payment._id))}`;
    await syncDashboardAction({
        requestId: payment._id,
        requestType: SALARY_DMF_REQUEST_TYPE,
        assignedTo: String(assignedTo),
        status: 'Pending',
        subjectEmployee: {
            employeeId: monthKey,
            firstName: slotNo ? `Slot ${slotNo}` : 'Salary slot',
            lastName: '',
        },
        requestedByName: 'HR',
        extra1: readyToUpdate
            ? `${monthKey} slot ${slotNo} is ready for Update payment.`
            : `${monthKey} slot ${slotNo} — check the WPS send.`,
        extra2: 'Salary slot',
        extra3: JSON.stringify({
            kind: 'salary-slot',
            monthKey,
            href,
            paymentId: String(payment._id),
            slotNo,
        }),
    });
}

export async function closeAccountsSalarySlotInbox(paymentId) {
    if (!paymentId) return;
    await syncDashboardAction({
        requestId: paymentId,
        requestType: SALARY_DMF_REQUEST_TYPE,
        status: 'Dismissed',
        comment: 'Salary slot finished',
        subjectEmployee: { employeeId: '', firstName: '', lastName: '' },
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
