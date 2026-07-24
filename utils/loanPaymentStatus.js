import { syncDashboardAction } from './syncDashboard.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import User from '../models/User.js';
import {
    LOAN_PENDING_PAYMENT_STATUS,
    isLoanAwaitingEmployeePayment,
} from './loanStatusConstants.js';

/**
 * Resolve Accounts/Finance HOD for loan disbursement after Management approval.
 */
export async function resolveLoanAccountsHod(employeeId) {
    const finance = await getDepartmentHOD('finance', employeeId);
    if (finance?._id) return finance;
    return getDepartmentHOD('accounts', employeeId);
}

/**
 * Mark the "Paid to Employee" workflow step complete on the loan document.
 */
export function markLoanPaidToEmployeeWorkflow(loan) {
    if (!loan) return;
    if (!Array.isArray(loan.workflow)) loan.workflow = [];

    const pending = loan.workflow.find(
        (w) => w.role === 'Paid to Employee' && w.status === 'Pending',
    );
    if (pending) {
        pending.status = 'Approved';
        pending.actionedAt = new Date();
        return;
    }

    const alreadyDone = loan.workflow.some(
        (w) => w.role === 'Paid to Employee' && w.status === 'Approved',
    );
    if (!alreadyDone) {
        loan.workflow.push({
            role: 'Paid to Employee',
            assignedTo: loan.submittedTo || null,
            status: 'Approved',
            assignedAt: new Date(),
            actionedAt: new Date(),
        });
    }
}

/**
 * Clear Accounts "pay to employee" dashboard / notification-bar / sidebar bell.
 */
export async function clearLoanPaymentDueBell(loan) {
    if (!loan?._id) return;
    try {
        await syncDashboardAction({
            requestId: loan._id,
            requestType: 'Loan',
            assignedTo: null,
            status: 'Approved',
            subjectEmployee: null,
            extra1: loan.type || 'Loan',
            extra2: loan.amount ? `AED ${loan.amount}` : '',
        });
    } catch (err) {
        console.error('[clearLoanPaymentDueBell] Failed:', err?.message || err);
    }
}

/**
 * After Management approval: notify Accounts to disburse (dashboard + bar + sidebar).
 * Also opens a Pending "Paid to Employee" workflow step and sets submittedTo to Accounts.
 */
export async function syncLoanPaymentDueBell(loan, subjectEmployee, requestedByName = '') {
    const amount = parseFloat(loan?.amount || 0);
    if (!loan || amount <= 0) return null;

    const remaining = amount - parseFloat(loan.paidAmount || 0);
    if (remaining <= 0.01) return null;

    // Ensure status is awaiting payment (new flow + legacy Approved)
    if (!isLoanAwaitingEmployeePayment(loan.approvalStatus || loan.status)) {
        loan.status = LOAN_PENDING_PAYMENT_STATUS;
        loan.approvalStatus = LOAN_PENDING_PAYMENT_STATUS;
    }

    const accountsHOD = await resolveLoanAccountsHod(loan.employeeId);
    if (!accountsHOD?._id) {
        console.warn('[syncLoanPaymentDueBell] No Accounts/Finance HOD found for payment bell');
        return null;
    }

    let assignmentUserId = accountsHOD._id;
    try {
        const nextUser = await User.findOne({ employeeId: accountsHOD.employeeId }).select('_id');
        if (nextUser?._id) assignmentUserId = nextUser._id;
    } catch {
        /* keep employee id */
    }

    loan.submittedTo = assignmentUserId;
    if (!Array.isArray(loan.workflow)) loan.workflow = [];
    const hasPendingPay = loan.workflow.some(
        (w) => w.role === 'Paid to Employee' && w.status === 'Pending',
    );
    if (!hasPendingPay) {
        loan.workflow.push({
            role: 'Paid to Employee',
            assignedTo: assignmentUserId,
            status: 'Pending',
            assignedAt: new Date(),
        });
    }

    await syncDashboardAction({
        requestId: loan._id,
        requestType: 'Loan',
        assignedTo: accountsHOD._id,
        status: 'Pending',
        subjectEmployee,
        requestedByName,
        extra1: `Pay to employee — ${loan.type || 'Loan'} ${LOAN_PENDING_PAYMENT_STATUS}`,
        extra2: `AED ${amount.toLocaleString()}`,
    });

    return accountsHOD;
}

/**
 * When loan is fully disbursed: set Paid, complete workflow step, clear Accounts bell.
 */
export async function applyLoanFullyPaid(loan, { clearPayBell = true } = {}) {
    if (!loan) return null;

    markLoanPaidToEmployeeWorkflow(loan);
    loan.status = 'Paid';
    loan.approvalStatus = 'Paid';
    await loan.save();

    if (clearPayBell) {
        await clearLoanPaymentDueBell(loan);
    }
    return loan;
}
