const NOTE_REGEX = /^[A-Za-z0-9\s.,\-()/'"]*$/;
const TYPE_REGEX = /^[A-Za-z0-9\s.,\-()/'"]*$/;

export function stripDangerousText(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object" || Array.isArray(value)) {
        throw new Error("Invalid data type for live document field");
    }
    let str = String(value).trim();
    str = str.replace(/<[^>]*>?/gm, "");
    return str;
}

export function normalizeLiveDocumentType(value) {
    return stripDangerousText(value);
}

export function normalizeLiveDocumentNote(value) {
    return stripDangerousText(value).slice(0, 500);
}

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

export function validateLiveDocumentType(value) {
    const normalized = normalizeLiveDocumentType(value);
    if (!normalized) return "Document Type is required";
    if (normalized.length < 3) return "Document Type must be at least 3 characters";
    if (normalized.length > 100) return "Document Type must be no more than 100 characters";
    if (!TYPE_REGEX.test(normalized)) return "Document Type contains invalid special characters";
    return null;
}

export function validateLiveDocumentValue(value, hasValue) {
    if (hasValue === false) return null;
    if (value === "" || value === null || value === undefined) {
        return "Value (AED) is required when Add Value is Yes";
    }
    const str = String(value).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(str)) return "Value must contain numbers only";
    const num = Number(str);
    if (num <= 0) return "Value must be greater than 0";
    return null;
}

export function validateLiveDocumentNote(value) {
    if (value == null || String(value).trim() === "") return null;
    const normalized = normalizeLiveDocumentNote(value);
    if (normalized.length > 500) return "Note must be no more than 500 characters";
    if (!NOTE_REGEX.test(normalized)) return "Note contains invalid special characters";
    return null;
}

export function validateLiveDocumentIssueDate(value) {
    if (value == null || String(value).trim() === "") return null;
    const d = parseDate(value);
    if (!d) return "Issue Date must be a valid date";
    if (d.getFullYear() < 1900) return "Issue Date minimum year is 1900";
    const today = startOfDay(new Date());
    if (d > today) return "Issue Date cannot be in the future";
    return null;
}

export function validateLiveDocumentExpiryDate(value, issueDate, hasExpiry) {
    if (hasExpiry === false) return null;
    if (!value) return "Expiry Date is required when Has Expiry Date is Yes";
    const expiry = parseDate(value);
    if (!expiry) return "Expiry Date must be a valid date";
    if (expiry.getFullYear() < 1900) return "Expiry Date minimum year is 1900";
    const issue = parseDate(issueDate);
    if (issue && expiry <= issue) return "Expiry Date must be greater than Issue Date";
    return null;
}

export function validateLiveDocumentRow(doc) {
    if (!doc || typeof doc !== "object") return { ok: true };
    const ctx = String(doc.context || "").toLowerCase();
    if (ctx !== "document_with_expiry" && ctx !== "document_without_expiry") {
        return { ok: true };
    }

    const hasExpiry = ctx === "document_with_expiry";
    const hasValueData =
        doc.value !== "" && doc.value !== null && doc.value !== undefined;
    const checks = [
        validateLiveDocumentType(doc.type),
        validateLiveDocumentNote(doc.description),
        validateLiveDocumentIssueDate(doc.issueDate || doc.startDate),
        validateLiveDocumentExpiryDate(doc.expiryDate, doc.issueDate || doc.startDate, hasExpiry),
    ];
    if (hasValueData) {
        checks.push(validateLiveDocumentValue(doc.value, true));
    }
    for (const err of checks) {
        if (err) return { ok: false, message: err };
    }

    const attachment = doc?.document?.url || doc?.attachment;
    if (!attachment) return { ok: false, message: "Attachment is required" };
    const mime = String(doc?.document?.mimeType || "").toLowerCase();
    const name = String(doc?.document?.name || "").toLowerCase();
    if (mime && mime !== "application/pdf") {
        return { ok: false, message: "Attachment must be a PDF file" };
    }
    if (name && !name.endsWith(".pdf")) {
        return { ok: false, message: "Attachment must be a PDF file" };
    }
    return { ok: true };
}

export function validateCompanyLiveDocumentsPayload(documents = []) {
    if (!Array.isArray(documents)) return { ok: true };
    for (const doc of documents) {
        const check = validateLiveDocumentRow(doc);
        if (!check.ok) return check;
    }
    return { ok: true };
}

export function normalizeCompanyLiveDocumentRow(doc) {
    if (!doc || typeof doc !== "object") return doc;
    const ctx = String(doc.context || "").toLowerCase();
    if (ctx !== "document_with_expiry" && ctx !== "document_without_expiry") return doc;

    const row = { ...doc };
    if (row.type !== undefined) row.type = normalizeLiveDocumentType(row.type);
    if (row.description !== undefined) row.description = normalizeLiveDocumentNote(row.description);
    if (ctx === "document_without_expiry") row.expiryDate = "";
    if (row.value === "" || row.value === null || row.value === undefined) row.value = "";
    return row;
}
