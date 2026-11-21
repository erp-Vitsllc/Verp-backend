const REPAYMENT_TYPES = new Set(['LoanRepayment', 'AdvanceRepayment']);

function sameLoan(payment, loan) {
    if (!payment || !loan) return false;
    const sameId = loan._id && String(payment.relatedEntityId) === String(loan._id);
    const sameRef =
        loan.loanId &&
        payment.referenceId &&
        String(payment.referenceId) === String(loan.loanId);
    return Boolean(sameId || sameRef);
}

/** Salary recovery and employee repayment. The company payout is a different payment. */
export function isLoanRepaymentPayment(payment, loan) {
    if (!REPAYMENT_TYPES.has(payment?.relatedEntityType)) return false;
    return sameLoan(payment, loan);
}

/**
 * Amount the employee has returned toward this loan or advance.
 * Payout payments (related type Loan / Advance) are not included — adding them
 * doubles a fully repaid advance (amount paid out + amount paid back).
 * The result never exceeds the loan amount.
 */
export function loanRecoveredAmount(loan, payments = []) {
    const amount = Number(loan?.amount) || 0;
    const fromPayments = (payments || []).reduce((sum, payment) => {
        if (!isLoanRepaymentPayment(payment, loan)) return sum;
        return sum + (Number(payment.amount) || 0);
    }, 0);
    const repaid = Number(loan?.repaidAmount) || 0;
    const recovered = Math.max(0, fromPayments, repaid);
    if (amount > 0) return Math.min(recovered, amount);
    return recovered;
}
