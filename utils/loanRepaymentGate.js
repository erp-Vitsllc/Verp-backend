import Loan from "../models/Loan.js";
import { requesterCanOverrideLoanEligibility } from "./loanEligibilityValidation.js";

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

/** Advance and Loan are separate. Only the same kind blocks another request. */
export function moneyRequestKind(type) {
    return String(type || "").toLowerCase().includes("advance") ? "advance" : "loan";
}

export function moneyRequestLabel(type) {
    return moneyRequestKind(type) === "advance" ? "Advance" : "Loan";
}

/**
 * A prior record of the same type blocks a new one while the application is
 * still in progress, or while an approved record has not been fully repaid.
 * A loan does not block an advance, and an advance does not block a loan.
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
    const kind = moneyRequestLabel(loan?.type);
    const loanId = loan?.loanId || "";
    if (OPEN_APPLICATION_STATUSES.has(status)) {
        const open = `This employee already has a ${kind} application in progress (${loanId} - ${status}). Another ${kind} cannot be added until that application is finished.`;
        return resubmit ? `Cannot resubmit this application. ${open}` : open;
    }
    const unpaid = `This employee still has an unpaid ${kind} (${loanId}). Another ${kind} can be added only after this ${kind} is fully repaid.`;
    return resubmit ? `Cannot resubmit this application. ${unpaid}` : unpaid;
}

export function selectBlockingLoan(records, { type, excludeId = null } = {}) {
    const kind = moneyRequestKind(type);
    const exclude = excludeId ? String(excludeId) : "";
    const blocking = (records || []).filter((loan) => {
        const id = String(loan?._id || loan?.id || "");
        if (exclude && id === exclude) return false;
        if (moneyRequestKind(loan?.type) !== kind) return false;
        return loanBlocksAnotherRequest(loan);
    });
    blocking.sort((a, b) => {
        const aOpen = isOpenLoanApplication(a) ? 0 : 1;
        const bOpen = isOpenLoanApplication(b) ? 0 : 1;
        return aOpen - bOpen;
    });
    return blocking[0] || null;
}

export async function findBlockingLoanObligation(employeeId, excludeId = null, type = null) {
    if (!employeeId || !type) return null;

    const records = await Loan.find({ employeeId })
        .select("loanId type status approvalStatus amount repaidAmount")
        .lean();

    return selectBlockingLoan(records, { type, excludeId });
}

/**
 * Same-type open or unpaid record blocks another request of that type.
 * Flowchart HR may continue with hrEligibilityOverride. The employee cannot.
 */
export async function assertSameTypeRequestAllowed(req, {
    employeeId,
    type,
    excludeId = null,
    resubmit = false,
} = {}) {
    const existing = await findBlockingLoanObligation(employeeId, excludeId, type);
    if (!existing) return { ok: true, existing: null };

    const message = blockingLoanMessage(existing, { resubmit });
    if (req?.selfServiceLoan) {
        return { ok: false, status: 400, message, canContinue: false, existing };
    }
    if (req?.body?.hrEligibilityOverride === true) {
        const allowed = await requesterCanOverrideLoanEligibility(req);
        if (!allowed) {
            return {
                ok: false,
                status: 403,
                message: "Only the flowchart HR assigned user can override this policy.",
                canContinue: false,
                existing,
            };
        }
        return { ok: true, overridden: true, message, existing };
    }
    return { ok: false, status: 400, message, canContinue: true, existing };
}
