const CERTIFICATE_TYPE_OPTIONS = new Set(["Installer", "Safety", "Administration", "Others"]);
const ISSUED_BY_REGEX = /^[A-Za-z0-9\s]{2,150}$/;

export function stripDangerousText(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object" || Array.isArray(value)) {
        throw new Error("Invalid data type for Certificate field");
    }
    let str = String(value).trim();
    str = str.replace(/<[^>]*>?/gm, "");
    return str;
}

function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function parseCertificateStoredDescription(raw) {
    const text = String(raw ?? "");
    const m = text.match(/^\s*Issued By:\s*(.+?)\s*\|\s*Issued To:\s*(.+?)\s*\|\s*([\s\S]*)$/i);
    if (m) {
        return {
            issuedBy: m[1].trim(),
            issuedTo: m[2].trim(),
            userDescription: m[3].trim(),
        };
    }
    return { issuedBy: "", issuedTo: "", userDescription: text.trim() };
}

export function validateCertificateTypeName(typeName) {
    const normalized = stripDangerousText(typeName);
    if (!normalized) return "Certificate Type is required";
    if (normalized.length > 50) return "Certificate Type must be no more than 50 characters";
    const lower = normalized.toLowerCase();
    if (["installer", "safety", "administration"].includes(lower)) return null;
    return null;
}

export function validateCertificateIssuedBy(value) {
    const normalized = stripDangerousText(value).replace(/\s+/g, " ").trim();
    if (!normalized) return "Certificate Issued By is required";
    if (normalized.length < 2) return "Certificate Issued By must be at least 2 characters";
    if (normalized.length > 150) return "Certificate Issued By must be no more than 150 characters";
    if (!ISSUED_BY_REGEX.test(normalized)) {
        return "Certificate Issued By may contain only letters, numbers, and spaces";
    }
    return null;
}

export function validateCertificateDescription(value) {
    if (value == null || String(value).trim() === "") return null;
    const normalized = stripDangerousText(value);
    if (normalized.length > 1000) return "Certificate Description must be no more than 1000 characters";
    return null;
}

export function validateCertificateIssueDate(value) {
    if (!value) return "Issue Date is required";
    const d = parseDate(value);
    if (!d) return "Issue Date must be a valid date";
    if (d.getFullYear() < 1900) return "Issue Date minimum year is 1900";
    return null;
}

export function validateCertificateExpiryDate(value, issueDate) {
    if (!value) return null;
    const expiry = parseDate(value);
    if (!expiry) return "Expiry Date must be a valid date";
    if (expiry.getFullYear() < 1900) return "Expiry Date minimum year is 1900";
    const issue = parseDate(issueDate);
    if (issue && expiry <= issue) return "Expiry Date must be greater than Issue Date";
    return null;
}

export function validateCertificateIssuedToLabel(value) {
    const normalized = stripDangerousText(value);
    if (!normalized) return "Certificate Issued To is required";
    if (normalized.length > 150) return "Certificate Issued To must be no more than 150 characters";
    return null;
}

export function validateCertificateDocumentRow(doc) {
    if (!doc || typeof doc !== "object") return { ok: true };
    const ctx = String(doc.context || "").toLowerCase();
    const typeLower = String(doc.type || "").toLowerCase();
    if (ctx !== "certificate" && !typeLower.includes("certificate")) return { ok: true };

    const parsed = parseCertificateStoredDescription(doc.description);
    const checks = [
        validateCertificateTypeName(doc.type),
        validateCertificateIssuedBy(parsed.issuedBy),
        validateCertificateDescription(parsed.userDescription),
        validateCertificateIssueDate(doc.issueDate || doc.startDate),
        validateCertificateIssuedToLabel(parsed.issuedTo),
        validateCertificateExpiryDate(doc.expiryDate, doc.issueDate || doc.startDate),
    ];
    for (const err of checks) {
        if (err) return { ok: false, message: err };
    }
    const attachment = doc?.document?.url || doc?.attachment;
    if (!attachment) return { ok: false, message: "Certificate Attachment is required" };
    const mime = String(doc?.document?.mimeType || "").toLowerCase();
    const name = String(doc?.document?.name || "").toLowerCase();
    if (mime && mime !== "application/pdf") {
        return { ok: false, message: "Certificate Attachment must be a PDF file" };
    }
    if (name && !name.endsWith(".pdf")) {
        return { ok: false, message: "Certificate Attachment must be a PDF file" };
    }
    return { ok: true };
}

export function normalizeCompanyCertificateRow(doc) {
    if (!doc || typeof doc !== "object") return doc;
    const ctx = String(doc.context || "").toLowerCase();
    const typeLower = String(doc.type || "").toLowerCase();
    if (ctx !== "certificate" && !typeLower.includes("certificate")) return doc;
    const row = { ...doc, context: "certificate" };
    if (row.issueDate && !(row.issueDate instanceof Date)) {
        const d = new Date(row.issueDate);
        if (!Number.isNaN(d.getTime())) row.issueDate = d;
    }
    if (row.expiryDate && !(row.expiryDate instanceof Date)) {
        const d = new Date(row.expiryDate);
        if (!Number.isNaN(d.getTime())) row.expiryDate = d;
    }
    return row;
}

export function validateCompanyCertificateDocumentsPayload(documents = []) {
    if (!Array.isArray(documents)) return { ok: true };
    for (const doc of documents) {
        const check = validateCertificateDocumentRow(doc);
        if (!check.ok) return check;
    }
    return { ok: true };
}
