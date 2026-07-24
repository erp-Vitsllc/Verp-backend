/** Set after Management approval — Accounts must pay the employee. */
export const LOAN_PENDING_PAYMENT_STATUS = 'Pending Payment to Employee';

/** Management has approved (legacy `Approved` or awaiting Accounts disbursement). */
export const LOAN_AWAITING_PAYMENT_STATUSES = ['Approved', LOAN_PENDING_PAYMENT_STATUS];

/** Management-approved or fully paid. */
export const LOAN_POST_MANAGEMENT_STATUSES = [
    'Approved',
    LOAN_PENDING_PAYMENT_STATUS,
    'Paid',
];

export function isLoanAwaitingEmployeePayment(status) {
    return LOAN_AWAITING_PAYMENT_STATUSES.includes(String(status || '').trim());
}

export function isLoanPostManagementStatus(status) {
    return LOAN_POST_MANAGEMENT_STATUSES.includes(String(status || '').trim());
}
