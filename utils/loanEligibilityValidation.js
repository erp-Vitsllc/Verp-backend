import { isJwtSystemSuperUser } from "./systemSuperUser.js";
import { isRequestUserDesignatedFlowchartHr } from "./isDesignatedFlowchartHr.js";
import { isUserInFlowchart } from "./getDepartmentHOD.js";

function monthsUntil(dateValue) {
    const expiryDate = new Date(dateValue);
    const today = new Date();
    return (
        (expiryDate.getFullYear() - today.getFullYear()) * 12 +
        (expiryDate.getMonth() - today.getMonth())
    );
}

function isDateInPast(dateValue) {
    const expiry = new Date(dateValue);
    if (Number.isNaN(expiry.getTime())) return false;
    const today = new Date();
    expiry.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    return expiry < today;
}

function isAdvanceType(type) {
    return String(type || "").toLowerCase().includes("advance");
}

function isVisitVisaType(visaType) {
    const t = String(visaType || "").toLowerCase().replace(/\s+/g, "");
    return t === "visit" || t === "visitvisa";
}

function hasVisaSlot(slot) {
    if (!slot) return false;
    return Boolean(slot.expiryDate || slot.number || slot.issueDate);
}

export function primaryVisaFromDetails(visaDetails) {
    if (hasVisaSlot(visaDetails?.employment)) {
        return { type: "Employment", expiry: visaDetails.employment.expiryDate || null };
    }
    if (hasVisaSlot(visaDetails?.spouse)) {
        return { type: "Spouse", expiry: visaDetails.spouse.expiryDate || null };
    }
    if (hasVisaSlot(visaDetails?.visit)) {
        return { type: "Visit", expiry: visaDetails.visit.expiryDate || null };
    }
    return { type: null, expiry: null };
}

export function collectLoanEligibilityBlocks({ status, visaType, visaExpiry, type } = {}) {
    const issues = [];
    const kindLabel = isAdvanceType(type) ? "an Advance" : "a Loan";
    const statusNorm = String(status || "").toLowerCase();

    if (statusNorm === "notice") {
        issues.push("Employee is in Notice period and cannot apply for a loan/advance.");
    }
    if (statusNorm === "probation" && !isAdvanceType(type)) {
        issues.push("Employees on probation cannot apply for personal loans.");
    }
    if (isVisitVisaType(visaType)) {
        issues.push(`Employees on Visit Visa cannot apply for ${kindLabel}.`);
    }
    if (visaExpiry) {
        if (isDateInPast(visaExpiry)) {
            issues.push("This employee's visa has expired. Cannot apply for a loan/advance.");
        } else if (!isAdvanceType(type) && monthsUntil(visaExpiry) < 3) {
            issues.push("Visa expires in less than 3 months. Cannot apply for a Loan.");
        }
    }

    return issues;
}

export async function requesterCanOverrideLoanEligibility(req) {
    if (!req?.user) return false;
    if (isJwtSystemSuperUser(req.user)) return true;
    if (await isRequestUserDesignatedFlowchartHr(req)) return true;
    if (await isUserInFlowchart(req.user, "hr")) return true;
    return false;
}

/**
 * Visa / status eligibility. Flowchart HR may continue after confirming in the UI
 * (`hrEligibilityOverride: true`). Duplicate active-loan checks stay elsewhere.
 */
export async function assertLoanEmployeeEligibility(req, employee, type) {
    const visa = primaryVisaFromDetails(employee?.visaDetails);
    const issues = collectLoanEligibilityBlocks({
        status: employee?.status,
        visaType: visa.type,
        visaExpiry: visa.expiry,
        type,
    });

    if (!issues.length) return { ok: true, issues: [] };

    const wantsOverride = req.body?.hrEligibilityOverride === true;
    if (wantsOverride) {
        const allowed = await requesterCanOverrideLoanEligibility(req);
        if (!allowed) {
            return {
                ok: false,
                status: 403,
                message: "Only the flowchart HR assigned user can override eligibility warnings.",
            };
        }
        return { ok: true, issues, overridden: true };
    }

    return { ok: false, status: 400, message: issues[0] };
}
