/** Set after Management approval — Accounts must pay the employee. */
export const LOAN_PENDING_PAYMENT_STATUS = 'Pending Payment to Employee';

/** Management has approved (legacy `Approved` or awaiting Accounts disbursement). */
export const LOAN_AWAITING_PAYMENT_STATUSES = ['Approved', LOAN_PENDING_PAYMENT_STATUS];

/** Management-approved or fully disbursed (legacy `Paid` still recognized). */
export const LOAN_POST_MANAGEMENT_STATUSES = [
    'Approved',
    LOAN_PENDING_PAYMENT_STATUS,
    'Paid',
];

export function isLoanAwaitingEmployeePayment(statusOrLoan) {
    if (statusOrLoan && typeof statusOrLoan === 'object') {
        const status = String(statusOrLoan.approvalStatus || statusOrLoan.status || '').trim();
        if (status === LOAN_PENDING_PAYMENT_STATUS) return true;
        if (status === 'Approved') {
            const amount = Number(statusOrLoan.amount) || 0;
            const paid = Number(statusOrLoan.paidAmount) || 0;
            return !(amount > 0 && paid >= amount - 0.01);
        }
        return false;
    }
    return LOAN_AWAITING_PAYMENT_STATUSES.includes(String(statusOrLoan || '').trim());
}

export function isLoanPostManagementStatus(status) {
    return LOAN_POST_MANAGEMENT_STATUSES.includes(String(status || '').trim());
}
