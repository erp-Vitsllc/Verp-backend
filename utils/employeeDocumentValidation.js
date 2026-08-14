import { stripDangerousText } from "./employeeAddValidation.js";

const TYPE_REGEX = /^[A-Za-z0-9\s.,\-()/'"]+$/;
const NOTE_REGEX = /^[A-Za-z0-9\s.,\-()/'"]*$/;
const VALUE_REGEX = /^\d+(\.\d{1,2})?$/;

function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function validateDocumentType(value) {
    const normalized = stripDangerousText(value);
    if (!normalized) return "Document Type is required";
    if (normalized.length < 2) return "Document Type must be at least 2 characters";
    if (normalized.length > 120) return "Document Type must be no more than 120 characters";
    if (!TYPE_REGEX.test(normalized)) return "Document Type contains invalid characters";
    return null;
}

function validateDocumentName(value, { required = true } = {}) {
    const normalized = stripDangerousText(value);
    if (!normalized) return required ? "Document Name is required" : null;
    if (normalized.length < 2) return "Document Name must be at least 2 characters";
    if (normalized.length > 150) return "Document Name must be no more than 150 characters";
    if (!TYPE_REGEX.test(normalized)) return "Document Name contains invalid characters";
    return null;
}

function validateDescription(value) {
    const normalized = stripDangerousText(value);
    if (!normalized) return null;
    if (normalized.length < 2) return "Description must be at least 2 characters when provided";
    if (normalized.length > 500) return "Description must be no more than 500 characters";
    if (!NOTE_REGEX.test(normalized)) return "Description contains invalid characters";
    return null;
}

function validateIssueDate(value) {
    if (!value || String(value).trim() === "") return null;
    const d = parseDate(value);
    if (!d) return "Issue Date must be a valid date";
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (d > today) return "Issue Date cannot be in the future";
    return null;
}

function validateExpiryDate(value, issueDate, hasExpiry) {
    if (hasExpiry === false) return null;
    if (!value || String(value).trim() === "") {
        return "Expiry date is required when Has Expiry Date is Yes";
    }
    const expiry = parseDate(value);
    if (!expiry) return "Expiry Date must be a valid date";
    const issue = parseDate(issueDate);
    if (issue) {
        issue.setHours(0, 0, 0, 0);
        expiry.setHours(0, 0, 0, 0);
        if (expiry <= issue) return "Expiry Date must be after Issue Date";
    }
    return null;
}

function validateDocumentValue(value, hasValue) {
    if (hasValue === false) return null;
    if (value === "" || value === null || value === undefined) {
        return "Value is required when Add Value is Yes";
    }
    const str = String(value).trim();
    if (!VALUE_REGEX.test(str)) return "Value must be a number with up to 2 decimal places";
    const num = parseFloat(str);
    if (num < 0) return "Value must be 0 or greater";
    if (num > 10000000) return "Value must not exceed 10,000,000";
    return null;
}

function validateDocumentAttachment(document, { requireFile = true, hasExisting = false } = {}) {
    const hasFile = Boolean(document?.url || document?.data || (document?.name && hasExisting));
    if (!hasFile) return requireFile && !hasExisting ? "Document File is required" : null;
    const name = String(document?.name || "").toLowerCase();
    const mime = String(document?.mimeType || "").toLowerCase();
    if (mime && mime !== "application/pdf" && !name.endsWith(".pdf")) {
        return "Only PDF files are allowed";
    }
    if (!mime && name && !name.endsWith(".pdf")) return "Only PDF files are allowed";
    return null;
}

export function validateEmployeeDocumentPayload(body = {}, options = {}) {
    const {
        isLabourModal = false,
        requireFile = true,
        hasExistingFile = false,
    } = options;

    const errors = [];
    const push = (err) => {
        if (err) errors.push(err);
    };

    if (!isLabourModal) {
        push(validateDocumentType(body.type));
        push(validateDocumentName(body.documentName, { required: true }));
        push(validateDescription(body.description));
        push(validateIssueDate(body.issueDate));
        const hasExpiry = body.expiryDate !== null && body.expiryDate !== undefined && String(body.expiryDate).trim() !== "";
        push(validateExpiryDate(body.expiryDate, body.issueDate, hasExpiry));
        const hasValue = body.cost !== null && body.cost !== undefined && body.cost !== "";
        push(validateDocumentValue(body.cost ?? body.value, hasValue));
    }

    push(
        validateDocumentAttachment(body.document, {
            requireFile,
            hasExisting: hasExistingFile,
        }),
    );

    return { ok: errors.length === 0, errors, message: errors[0] || "" };
}
