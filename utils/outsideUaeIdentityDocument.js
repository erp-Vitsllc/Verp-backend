export function isCompleteOutsideUaeIdentityDocument(doc) {
    if (!doc || doc.outsideUaeIdentity !== true) return false;
    const type = String(doc.type || doc.documentName || "").trim();
    const country = String(doc.countryIssued || "").trim();
    const file = doc.document?.url || doc.document?.data || doc.document?.name;
    return Boolean(type && doc.issueDate && doc.expiryDate && country && file);
}

export function hasCompleteOutsideUaeIdentityDocument(employee) {
    return (employee?.documents || []).some(isCompleteOutsideUaeIdentityDocument);
}

function passportNumberPresent(passport) {
    const number = passport?.number;
    if (number == null) return false;
    const text = String(number).trim();
    return text !== "" && text !== "—";
}

/** Outside UAE activation identity: a saved passport or a complete identity document. */
export function outsideUaeProfileIdentitySatisfied(employee, passport = employee?.passportDetails) {
    return hasCompleteOutsideUaeIdentityDocument(employee) || passportNumberPresent(passport);
}
