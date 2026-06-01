const PROVIDER_REGEX = /^[A-Za-z0-9\s&().,-]{2,100}$/;
const POLICY_NUMBER_REGEX = /^[A-Za-z0-9]{5,30}$/;

export function stripDangerousText(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object" || Array.isArray(value)) {
        throw new Error("Invalid data type for Medical Insurance field");
    }
    let str = String(value).trim();
    str = str.replace(/<[^>]*>?/gm, "");
    return str;
}

export function normalizeMedicalProvider(value) {
    return stripDangerousText(value).replace(/\s+/g, " ").trim();
}

export function normalizeMedicalPolicyNumber(value) {
    return stripDangerousText(value).replace(/\s/g, "");
}

function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function validateMedicalProvider(value) {
    const normalized = normalizeMedicalProvider(value);
    if (!normalized) return "Insurance Provider is required";
    if (normalized.length < 2) return "Insurance Provider must be at least 2 characters";
    if (normalized.length > 100) return "Insurance Provider must be no more than 100 characters";
    if (!PROVIDER_REGEX.test(normalized)) {
        return "Insurance Provider may contain only letters, numbers, spaces, and & ( ) . , -";
    }
    return null;
}

export function validateMedicalPolicyNumber(value) {
    const normalized = normalizeMedicalPolicyNumber(value);
    if (!normalized) return "Policy Number is required";
    if (normalized.length < 5) return "Policy Number must be at least 5 characters";
    if (normalized.length > 30) return "Policy Number must be no more than 30 characters";
    if (!POLICY_NUMBER_REGEX.test(normalized)) {
        return "Policy Number may contain only letters and numbers (A–Z, a–z, 0–9)";
    }
    return null;
}

export function validateMedicalIssueDate(value) {
    if (!value) return "Issue Date is required";
    const d = parseDate(value);
    if (!d) return "Issue Date must be a valid date";
    if (d.getFullYear() < 1900) return "Issue Date minimum year is 1900";
    return null;
}

export function validateMedicalExpiryDate(value, issueDate) {
    if (!value) return "Expiry Date is required";
    const expiry = parseDate(value);
    if (!expiry) return "Expiry Date must be a valid date";
    if (expiry.getFullYear() < 1900) return "Expiry Date minimum year is 1900";
    const issue = parseDate(issueDate);
    if (issue && expiry <= issue) return "Expiry Date must be greater than Issue Date";
    return null;
}

export function normalizeOwnerMedicalInsuranceRow(medical) {
    if (!medical || typeof medical !== "object") return medical;
    const row = { ...medical };
    if (row.provider !== undefined) row.provider = normalizeMedicalProvider(row.provider);
    if (row.number !== undefined) row.number = normalizeMedicalPolicyNumber(row.number);
    return row;
}

export function validateOwnerMedicalInsuranceRow(medical) {
    if (!medical || typeof medical !== "object") {
        return { ok: true };
    }
    const hasContent =
        medical.provider ||
        medical.number ||
        medical.issueDate ||
        medical.expiryDate ||
        medical.attachment;
    if (!hasContent) return { ok: true };

    const checks = [
        validateMedicalProvider(medical.provider),
        validateMedicalPolicyNumber(medical.number),
        validateMedicalIssueDate(medical.issueDate),
        validateMedicalExpiryDate(medical.expiryDate, medical.issueDate),
    ];
    for (const err of checks) {
        if (err) return { ok: false, message: err };
    }
    if (!medical.attachment) {
        return { ok: false, message: "Medical Insurance document is required" };
    }
    return { ok: true };
}

export function validateOwnersMedicalInsurancePayload(owners = []) {
    if (!Array.isArray(owners)) return { ok: true };
    for (const owner of owners) {
        const check = validateOwnerMedicalInsuranceRow(owner?.medical);
        if (!check.ok) return check;
    }
    return { ok: true };
}
