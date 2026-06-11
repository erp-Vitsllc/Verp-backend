const hasVisaNumber = (value) => Boolean(String(value || "").trim());

/** Emirates ID is optional only when the employee is on a visit visa (no employment/spouse visa). */
export function employeeRequiresEmiratesId(employee = {}, pendingVisa = null) {
    const visaDetails = employee?.visaDetails || {};
    if (hasVisaNumber(visaDetails.employment?.number) || hasVisaNumber(visaDetails.spouse?.number)) {
        return true;
    }
    if (hasVisaNumber(visaDetails.visit?.number)) {
        return false;
    }
    const pendingType = String(pendingVisa?.visaType || pendingVisa?.type || "").toLowerCase();
    if (hasVisaNumber(pendingVisa?.number)) {
        return pendingType !== "visit";
    }
    return true;
}
