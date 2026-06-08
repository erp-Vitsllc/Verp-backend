import {
    validatePassportCountryOfIssue,
    validatePassportIssueDate,
    validatePassportNationality,
    validatePassportNumber,
    normalizePassportNumber,
    normalizePassportNationality,
    normalizePassportCountryOfIssue,
} from "./ownerPassportValidation.js";

const SAFE_FILE_NAME_REGEX = /^[A-Za-z0-9._ -]+$/;
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

function validateEmployeePassportExpiryDate(expiryDate, issueDate, { profileActive = false } = {}) {
    if (!expiryDate) return "Expiry date is required";
    const expiry = parseDate(expiryDate);
    if (!expiry) return "Expiry date must be a valid date";
    const issue = parseDate(issueDate);
    if (issue && startOfDay(expiry) <= startOfDay(issue)) {
        return "Expiry date must be later than the issue date";
    }
    return null;
}

function validatePassportAttachment(document, fileName) {
    const name = String(fileName || document?.name || "").trim();
    const hasDoc = Boolean(
        document?.url ||
        document?.data ||
        document?.publicId ||
        (typeof document === "string" && document.trim()),
    );
    if (!hasDoc) return "Passport copy is required";
    if (name && !SAFE_FILE_NAME_REGEX.test(name)) {
        return "File name must not contain special characters";
    }
    const mime = String(document?.mimeType || "").toLowerCase();
    if (mime && mime !== "application/pdf") {
        return "Only PDF file format is allowed";
    }
    return null;
}

export function normalizeEmployeePassportPayload(payload = {}) {
    return {
        ...payload,
        number: payload.number !== undefined ? normalizePassportNumber(payload.number) : payload.number,
        nationality:
            payload.nationality !== undefined
                ? normalizePassportNationality(payload.nationality)
                : payload.nationality,
        placeOfIssue:
            payload.placeOfIssue !== undefined
                ? normalizePassportCountryOfIssue(payload.placeOfIssue)
                : payload.placeOfIssue,
    };
}

export function validateEmployeePassportPayload(
    payload = {},
    { profileActive = false, existingPassportNumber = "" } = {},
) {
    const checks = [
        validatePassportNumber(payload.number, { skipNumber: existingPassportNumber }),
        validatePassportNationality(payload.nationality),
        validatePassportIssueDate(payload.issueDate),
        validateEmployeePassportExpiryDate(payload.expiryDate, payload.issueDate, { profileActive }),
        validatePassportCountryOfIssue(payload.placeOfIssue),
        validatePassportAttachment(payload.document, payload.documentName),
    ];

    for (const err of checks) {
        if (err) return { ok: false, message: err };
    }
    return { ok: true };
}

export { MAX_FILE_BYTES };
