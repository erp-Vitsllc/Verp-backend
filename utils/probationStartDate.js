function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeVisaDocumentTypeLabel(type) {
    return String(type || "")
        .trim()
        .toLowerCase()
        .replace(/^previous\s+/, "");
}

function isEmploymentVisaDocumentType(type) {
    const normalized = normalizeVisaDocumentTypeLabel(type);
    return normalized === "employment visa" || normalized === "employment";
}

function employeeHasEmploymentVisaRecord(employeeBasic = {}, visaRecord = null) {
    if (String(visaRecord?.employment?.number || "").trim()) return true;
    if (parseDate(visaRecord?.employment?.issueDate)) return true;

    const oldDocs = Array.isArray(employeeBasic?.oldDocuments) ? employeeBasic.oldDocuments : [];
    return oldDocs.some(
        (doc) =>
            isEmploymentVisaDocumentType(doc?.type) &&
            (String(doc?.number || "").trim() || parseDate(doc?.issueDate)),
    );
}

/**
 * Earliest employment visa issue date — survives renewals and archived "Previous Employment Visa" rows.
 */
export function resolveFirstEmploymentVisaIssueDate(employeeBasic = {}, visaRecord = null) {
    const candidates = [];
    const add = (value) => {
        const d = parseDate(value);
        if (d) candidates.push(d);
    };

    add(visaRecord?.employment?.issueDate);

    const oldDocs = Array.isArray(employeeBasic?.oldDocuments) ? employeeBasic.oldDocuments : [];
    oldDocs.forEach((doc) => {
        if (isEmploymentVisaDocumentType(doc?.type)) add(doc.issueDate);
    });

    const docs = Array.isArray(employeeBasic?.documents) ? employeeBasic.documents : [];
    docs.forEach((doc) => {
        if (isEmploymentVisaDocumentType(doc?.type)) add(doc.issueDate);
    });

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.getTime() - b.getTime());
    return candidates[0];
}

/** Probation anchor — first employment visa when present, else stored contract joining date. */
export function resolveProbationStartDate(employeeBasic = {}, visaRecord = null) {
    if (employeeHasEmploymentVisaRecord(employeeBasic, visaRecord)) {
        const firstEmployment = resolveFirstEmploymentVisaIssueDate(employeeBasic, visaRecord);
        if (firstEmployment) return firstEmployment;
    }
    return parseDate(employeeBasic?.contractJoiningDate);
}

export function isProbationPeriodComplete(startDate, probationMonths = 6, today = new Date()) {
    const start = parseDate(startDate);
    if (!start) return null;

    const months = Number(probationMonths);
    if (!Number.isFinite(months) || months < 0) return null;

    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setMonth(end.getMonth() + months);
    end.setHours(0, 0, 0, 0);

    const t = new Date(today);
    t.setHours(0, 0, 0, 0);
    return t.getTime() >= end.getTime();
}
