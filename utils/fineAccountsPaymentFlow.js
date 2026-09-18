import User from '../models/User.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { getManagementHOD } from './getManagementHOD.js';
import { syncDashboardAction } from './syncDashboard.js';
import { sendFineAccountsActionEmail } from './sendFineAccountsActionEmail.js';
import { addEmployeeEmailToSet } from './resolveEmployeeEmail.js';

function applicantEmployeeId(fine) {
    const real = (fine.assignedEmployees || []).find(
        (e) => e.employeeId && e.employeeId !== 'VEGA-HR-0000' && e.employeeId !== 'VEGA_INTERNAL',
    );
    return real?.employeeId || fine.assignedEmployees?.[0]?.employeeId || null;
}

export async function resolveFineAccountsActor(fine) {
    const applicantId = applicantEmployeeId(fine);
    const accountsHOD = await getDepartmentHOD('finance', applicantId);
    if (!accountsHOD) return { accountsHOD: null, accountsUser: null };
    const accountsUser = await User.findOne({ employeeId: accountsHOD.employeeId });
    return { accountsHOD, accountsUser };
}

export async function resolveFineManagementActor(fine) {
    const applicantId = applicantEmployeeId(fine);
    const managementHOD = await getManagementHOD(applicantId);
    if (!managementHOD) return { managementHOD: null, mgmtUser: null };
    const mgmtUser = await User.findOne({ employeeId: managementHOD.employeeId });
    return { managementHOD, mgmtUser };
}

function inboxMeta(fine, fines = []) {
    const group = (fines || []).length > 1;
    return {
        requestId: fine._id,
        requestType: group ? 'Group Fine Request' : 'Fine',
        subjectName: group
            ? `Group Fine - ${fines.length} Employees`
            : fine.assignedEmployees?.[0]?.employeeName,
        extra1: fine.fineType,
        extra2: `Payment pending · AED ${fines.reduce((sum, f) => sum + (f.fineAmount || 0), 0)}`,
        requestedByName: fine.createdBy?.name || '',
    };
}

export async function openAccountsPaymentInbox(fine, fines = []) {
    // Fine notifications are approval-stage only. Payable / Zoho settlement
    // is not an approval step, so do not create a Pending Fine inbox row.
    const { accountsHOD, accountsUser } = await resolveFineAccountsActor(fine);
    void fines;
    return { accountsHOD, accountsUser };
}

export async function closeAccountsPaymentInbox(fine, fines = []) {
    await syncDashboardAction({
        ...inboxMeta(fine, fines),
        assignedTo: null,
        status: 'Approved',
    });
}

export function accountsHodEmails(accountsHOD) {
    const emails = new Set();
    addEmployeeEmailToSet(emails, accountsHOD);
    return Array.from(emails);
}

export function managementHodEmails(managementHOD) {
    const emails = new Set();
    addEmployeeEmailToSet(emails, managementHOD);
    return Array.from(emails);
}

export async function emailAccountsPaymentRequest(fine, accountsHOD) {
    const to = accountsHodEmails(accountsHOD);
    if (!to.length) return;
    const greetingName = `${accountsHOD.firstName || ''} ${accountsHOD.lastName || ''}`.trim();
    await sendFineAccountsActionEmail({
        kind: 'accounts_payment_request',
        fine,
        to,
        greetingName,
    });
}

export async function emailManagementAccountsSettlement(fine, kind) {
    const { managementHOD } = await resolveFineManagementActor(fine);
    const to = managementHodEmails(managementHOD);
    if (!to.length) {
        console.warn(`[FineAccountsFlow] No Management email for ${kind} (${fine.fineId}).`);
        return;
    }
    const greetingName = `${managementHOD.firstName || ''} ${managementHOD.lastName || ''}`.trim();
    await sendFineAccountsActionEmail({
        kind,
        fine,
        to,
        greetingName,
    });
}
