import Loan from "../models/Loan.js";

const OPEN_APPLICATION_STATUSES = new Set([
    "Pending",
    "Pending HR",
    "Pending Accounts",
    "Pending Authorization",
]);

const APPROVED_LIKE_STATUSES = new Set([
    "Approved",
    "Paid",
    "Pending Payment to Employee",
]);

/** Employee has returned the full amount to the company. */
export function isLoanFullyRepaidByEmployee(loan) {
    const amount = Number(loan?.amount) || 0;
    const repaid = Number(loan?.repaidAmount) || 0;
    return amount > 0.01 && repaid >= amount - 0.01;
}

export function isOpenLoanApplication(loan) {
    const status = String(loan?.approvalStatus || loan?.status || "").trim();
    return OPEN_APPLICATION_STATUSES.has(status);
}

/**
 * A prior loan or advance blocks a new one while the application is still
 * in progress, or while an approved record has not been fully repaid.
 */
export function loanBlocksAnotherRequest(loan) {
    const status = String(loan?.approvalStatus || loan?.status || "").trim();
    if (!status || status === "Draft" || status === "Rejected" || status === "Cancelled") {
        return false;
    }
    if (OPEN_APPLICATION_STATUSES.has(status)) return true;
    if (APPROVED_LIKE_STATUSES.has(status)) return !isLoanFullyRepaidByEmployee(loan);
    return true;
}

export function blockingLoanMessage(loan, { resubmit = false } = {}) {
    const status = String(loan?.approvalStatus || loan?.status || "").trim();
    const type = loan?.type || "loan";
    const loanId = loan?.loanId || "";
    if (OPEN_APPLICATION_STATUSES.has(status)) {
        return resubmit
            ? `Cannot resubmit this application. The employee already has another application in progress (${loanId} - ${status}).`
            : `This employee already has a ${type} application in progress (${loanId} - ${status}).`;
    }
    const unpaid = `This employee still has an unpaid ${type} (${loanId}). A new loan or advance can be added only after every previous loan and advance is fully repaid.`;
    return resubmit ? `Cannot resubmit this application. ${unpaid}` : unpaid;
}

export async function findBlockingLoanObligation(employeeId, excludeId = null) {
    if (!employeeId) return null;
    const query = { employeeId };
    if (excludeId) query._id = { $ne: excludeId };

    const records = await Loan.find(query)
        .select("loanId type status approvalStatus amount repaidAmount")
        .lean();

    const blocking = records.filter(loanBlocksAnotherRequest);
    blocking.sort((a, b) => {
        const aOpen = isOpenLoanApplication(a) ? 0 : 1;
        const bOpen = isOpenLoanApplication(b) ? 0 : 1;
        return aOpen - bOpen;
    });
    return blocking[0] || null;
}
