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

/** Profile progress counts only the document saved from Basic Details. */
export function outsideUaeProfileIdentitySatisfied(employee) {
    return hasCompleteOutsideUaeIdentityDocument(employee);
}
