/**
 * Preserve repayment schedule as it was when the loan/advance was approved.
 */
export function snapshotLoanScheduleOnApproval(loan) {
    if (!loan) return;
    if (!loan.originalMonthStart) {
        loan.originalMonthStart = loan.monthStart || '';
    }
    if (loan.originalDuration == null && loan.duration != null) {
        loan.originalDuration = loan.duration;
    }
}

export function preserveOriginalLoanScheduleBeforeEdit(loan) {
    if (!loan) return;
    if (!loan.originalMonthStart && loan.monthStart) {
        loan.originalMonthStart = loan.monthStart;
    }
    if (loan.originalDuration == null && loan.duration != null) {
        loan.originalDuration = loan.duration;
    }
}
