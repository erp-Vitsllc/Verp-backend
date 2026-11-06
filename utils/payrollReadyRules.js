import { monthKeyOf } from './buildSalarySlipPayload.js';
import { fineNeedsAccountsPaymentInbox, fineStillNeedsInbox } from './fineStageAuth.js';
import { isLoanAwaitingEmployeePayment } from './loanStatusConstants.js';

const CLOSED_LOAN_STATUSES = new Set(['Rejected', 'Cancelled', 'Draft', 'Paid']);

export const PAYROLL_LOAN_QUERY_STATUSES = [
    'Pending',
    'Pending HR',
    'Pending Accounts',
    'Pending Authorization',
    'Pending Payment to Employee',
    'Approved',
];

export const PAYROLL_FINE_QUERY_STATUSES = [
    'Pending',
    'Pending HR',
    'Pending Accounts',
    'Pending Authorization',
    'Approved',
    'Active',
];

/**
 * A loan or advance blocks Ready while approval is open, or while Accounts still
 * has to disburse it (Zoho or employee pay). Salary repayment of money already
 * paid out does not block.
 */
export function loanBlocksPayrollReady(loan) {
    if (!loan) return false;
    const status = String(loan.approvalStatus || loan.status || '').trim();
    if (!status || CLOSED_LOAN_STATUSES.has(status)) return false;
    if (status === 'Approved') return isLoanAwaitingEmployeePayment(loan);
    return /pending/i.test(status);
}

export function loanPayrollTitle(loan) {
    const kind = String(loan?.type || 'Loan').trim() || 'Loan';
    if (isLoanAwaitingEmployeePayment(loan)) return `${kind} · Accounts payment`;
    return `${kind} approval`;
}

export function loanPayrollRole(loan) {
    if (isLoanAwaitingEmployeePayment(loan)) return 'Accounts';
    const status = String(loan?.approvalStatus || loan?.status || '');
    if (/account|finance/i.test(status)) return 'Accounts';
    if (/authoriz|management/i.test(status)) return 'Management';
    return 'HR';
}

export function fineBlocksPayrollReady(fine) {
    return fineStillNeedsInbox(fine);
}

function dubaiYearMonth(value) {
    if (value == null || value === '') return '';
    const raw = String(value).trim();
    if (/^\d{4}-\d{2}$/.test(raw)) return raw;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return monthKeyOf(value);
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Dubai',
        year: 'numeric',
        month: '2-digit',
    }).formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value || '';
    const month = parts.find((part) => part.type === 'month')?.value || '';
    return year && month ? `${year}-${month}` : '';
}

/** The payroll month a fine approval belongs to. Creation date wins for every fine type. */
export function finePendingPayrollMonth(fine) {
    return dubaiYearMonth(fine?.createdAt) || dubaiYearMonth(fine?.awardedDate);
}

/** An open fine blocks only the payroll month it was created in. */
export function fineBlocksThisPayrollMonth(fine, payrollMonth) {
    if (!fineBlocksPayrollReady(fine)) return false;
    const target = monthKeyOf(payrollMonth);
    if (!target) return false;
    return finePendingPayrollMonth(fine) === target;
}

export function finePayrollTitle(fine) {
    return fineNeedsAccountsPaymentInbox(fine) ? 'Fine · Accounts payment' : 'Fine approval';
}

export function finePayrollRole(fine) {
    if (fineNeedsAccountsPaymentInbox(fine)) return 'Accounts';
    const status = String(fine?.fineStatus || '');
    if (/account|finance/i.test(status)) return 'Accounts';
    if (/authoriz|management/i.test(status)) return 'Management';
    return 'HR';
}

export function utilityBillPending(bill) {
    return ['Pending Accounts', 'Pending HR'].includes(String(bill?.status || '').trim());
}

export function utilityPayeeCodes(bill) {
    const codes = [];
    const header = String(bill?.payByEmployeeId || '').trim();
    if (header) codes.push(header);
    for (const line of bill?.zohoLineItems || []) {
        const code = String(line?.payByEmployeeId || '').trim();
        if (code) codes.push(code);
    }
    return codes;
}

/** Unpaid employee excess on this salary month. Pending bills are a separate blocker. */
export function utilityExcessForMonth(bill, monthKey) {
    if (!bill || utilityBillPending(bill)) return false;
    const status = String(bill.status || '').trim();
    if (!['Approved', 'Paid'].includes(status)) return false;
    if (String(bill.paymentBy || '').toLowerCase() === 'company') return false;
    const excess = Number(bill.employeeDiffAmount);
    if (!(excess > 0.009)) return false;
    const target = monthKeyOf(monthKey);
    return Boolean(target) && monthKeyOf(bill.billMonth) === target;
}

export function partyBalanceDueInMonth(expense, monthKey) {
    if (!expense || expense.kind !== 'balance') return false;
    if (String(expense.status || '') === 'Paid') return false;
    const target = monthKeyOf(monthKey);
    if (!target) return false;
    if (monthKeyOf(expense.billMonth) === target) return true;
    return (expense.installments || []).some(
        (row) => monthKeyOf(row?.monthKey) === target && String(row?.status || '') !== 'Paid',
    );
}

function refId(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'object') {
        if (value._id) return String(value._id);
        if (typeof value.toHexString === 'function') return value.toHexString();
    }
    return String(value);
}

/**
 * Payroll blocks while an assignment to this employee is still unaccepted,
 * or while a return of their asset is still pending.
 * Transfers and other asset requests do not block.
 */
export function assetPayrollInvolvement(asset, employeeMongoId) {
    const emp = String(employeeMongoId || '').trim();
    if (!asset || !emp) return null;
    const assignedTo = refId(asset.assignedTo);
    const actionBy = refId(asset.actionRequiredBy);
    const requestedBy = refId(asset.pendingActionDetails?.requestedBy);
    const accepting = String(asset.acceptanceStatus || '') === 'Pending' && emp === assignedTo;
    if (accepting) {
        return {
            title: 'Asset assignment pending',
            assigneeMongoId: emp,
            responsibleRole: 'Employee',
            onSubject: true,
        };
    }

    if (String(asset.pendingAction || '').trim() !== 'Return Asset') return null;
    const onHim = emp === assignedTo || (Boolean(actionBy) && emp === actionBy);
    const sentByHim = emp === requestedBy;
    if (!onHim && !sentByHim) return null;
    if (onHim) {
        return {
            title: 'Asset return pending',
            assigneeMongoId: actionBy || emp,
            responsibleRole: !actionBy || actionBy === emp ? 'Employee' : 'Approver',
            onSubject: !actionBy || actionBy === emp,
        };
    }
    return {
        title: 'Asset return sent',
        assigneeMongoId: actionBy || assignedTo,
        responsibleRole: 'Approver',
        onSubject: false,
    };
}

export function assetTaskPath(asset) {
    const id = String(asset?._id || '').trim();
    if (!id) return '/HRM/Asset';
    const vehicle = String(asset.plateNumber || asset.vehicleCode || '').trim();
    const base = vehicle ? `/HRM/Asset/Vehicle/details/${id}` : `/HRM/Asset/details/${id}`;
    return `${base}?tab=document`;
}

export function utilityBillPath(bill) {
    const entryId = String(bill?.entryId || '').trim();
    const billId = String(bill?._id || '').trim();
    if (!entryId) return '/HRM/Asset/UtilityBills';
    const base = `/HRM/Asset/UtilityBills/details/${encodeURIComponent(entryId)}`;
    return billId ? `${base}?billId=${encodeURIComponent(billId)}` : base;
}

export function utilityPendingRole(bill) {
    const role = String(bill?.pendingWithRole || '').trim().toLowerCase();
    if (role === 'accounts') return 'Accounts';
    if (role === 'hr') return 'HR';
    const status = String(bill?.status || '');
    if (/account/i.test(status)) return 'Accounts';
    if (/hr/i.test(status)) return 'HR';
    return 'Approver';
}
