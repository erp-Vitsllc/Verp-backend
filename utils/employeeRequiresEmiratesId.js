const hasVisaNumber = (value) => Boolean(String(value || "").trim());

const isVisitVisaTypeKey = (type) => {
    const normalized = String(type || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return normalized === "visit" || normalized === "visiting";
};

/** Emirates ID / Labour Card are optional only for visit-visa-only employees (no employment/spouse visa). */
export function employeeRequiresEmiratesId(employee = {}, pendingVisa = null) {
    const visaDetails = employee?.visaDetails || {};
    if (hasVisaNumber(visaDetails.employment?.number) || hasVisaNumber(visaDetails.spouse?.number)) {
        return true;
    }
    if (hasVisaNumber(visaDetails.visit?.number)) {
        return false;
    }
    const pendingType = pendingVisa?.visaType || pendingVisa?.type || "";
    if (hasVisaNumber(pendingVisa?.number)) {
        return !isVisitVisaTypeKey(pendingType);
    }
    return true;
}

export const employeeRequiresLabourCard = employeeRequiresEmiratesId;
