const PROVIDER_REGEX = /^[A-Za-z0-9\s]{2,100}$/;
const POLICY_NUMBER_REGEX = /^[A-Za-z0-9]{3,50}$/;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(d) {
    const copy = new Date(d);
    copy.setHours(0, 0, 0, 0);
    return copy;
}

function normalizeProvider(value) {
    return String(value || "").trim();
}

function normalizeNumber(value) {
    return String(value || "").replace(/\s/g, "").trim();
}

function validateProvider(value) {
    const provider = normalizeProvider(value);
    if (!provider) return "Provider is required";
    if (provider.length < 2) return "Provider must be at least 2 characters";
    if (provider.length > 100) return "Provider must be no more than 100 characters";
    if (!PROVIDER_REGEX.test(provider)) {
        return "Provider may contain only letters, numbers, and spaces";
    }
    return null;
}

function validatePolicyNumber(value) {
    const number = normalizeNumber(value);
    if (!number) return "Policy number is required";
    if (number.length < 3) return "Policy number must be at least 3 characters";
    if (number.length > 50) return "Policy number must be no more than 50 characters";
    if (!POLICY_NUMBER_REGEX.test(number)) {
        return "Policy number may contain only letters and numbers";
    }
    return null;
}

function validateIssueDate(value) {
    if (!value) return "Issue date is required";
    const d = parseDate(value);
    if (!d) return "Issue date must be a valid date";
    if (d.getFullYear() < 1900) return "Issue date minimum year is 1900";
    const today = startOfDay(new Date());
    if (startOfDay(d) > today) return "Issue date cannot be in the future";
    return null;
}

function validateExpiryDate(expiryDate, issueDate) {
    if (!expiryDate) return "Expiry date is required";
    const expiry = parseDate(expiryDate);
    if (!expiry) return "Expiry date must be a valid date";
    const issue = parseDate(issueDate);
    if (issue && startOfDay(expiry) <= startOfDay(issue)) {
        return "Expiry date must be later than the issue date";
    }
    return null;
}

function validateAttachment(document, fileName) {
    const hasDoc = Boolean(
        document?.url || document?.data || document?.publicId ||
        (typeof document === "string" && document.trim()),
    );
    if (!hasDoc) return "Medical insurance document is required";
    const mime = String(document?.mimeType || "").toLowerCase();
    if (mime && mime !== "application/pdf") return "Only PDF file format is allowed";
    const name = String(fileName || document?.name || "").toLowerCase();
    if (name && !name.endsWith(".pdf")) return "Only PDF file format is allowed";
    return null;
}

export function normalizeEmployeeMedicalInsurancePayload(payload = {}) {
    return {
        ...payload,
        provider: payload.provider !== undefined ? normalizeProvider(payload.provider) : payload.provider,
        number: payload.number !== undefined ? normalizeNumber(payload.number) : payload.number,
    };
}

export function validateEmployeeMedicalInsurancePayload(payload = {}) {
    const checks = [
        validateProvider(payload.provider),
        validatePolicyNumber(payload.number),
        validateIssueDate(payload.issueDate),
        validateExpiryDate(payload.expiryDate, payload.issueDate),
        validateAttachment(payload.document, payload.documentName),
    ];
    for (const err of checks) {
        if (err) return { ok: false, message: err };
    }
    return { ok: true };
}

export { MAX_FILE_BYTES };
