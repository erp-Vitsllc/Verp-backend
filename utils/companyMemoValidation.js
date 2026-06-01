export const MEMO_CATEGORY_OPTIONS = ["HR", "Admin", "General", "Project"];

export function stripDangerousText(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object" || Array.isArray(value)) {
        throw new Error("Invalid data type for memo field");
    }
    let str = String(value).trim();
    str = str.replace(/<[^>]*>?/gm, "");
    return str;
}

export function normalizeMemoDocumentName(value) {
    return stripDangerousText(value).slice(0, 200);
}

export function normalizeMemoDescription(value) {
    return stripDangerousText(value).slice(0, 4000);
}

export function normalizeMemoCategory(value) {
    const v = stripDangerousText(value);
    if (v === "Projects") return "Project";
    return MEMO_CATEGORY_OPTIONS.includes(v) ? v : v;
}

function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function validateMemoDocumentName(value) {
    const normalized = normalizeMemoDocumentName(value);
    if (!normalized) return "Document Name is required";
    if (normalized.length < 3) return "Document Name must be at least 3 characters";
    if (normalized.length > 200) return "Document Name must be no more than 200 characters";
    if (!/[A-Za-z0-9]/.test(normalized)) {
        return "Document Name must not contain only special characters";
    }
    return null;
}

export function validateMemoIssueDate(value) {
    if (value == null || String(value).trim() === "") return null;
    const d = parseDate(value);
    if (!d) return "Issue Date must be a valid date";
    if (d.getFullYear() < 1900) return "Issue Date minimum year is 1900";
    return null;
}

export function validateMemoCategory(value) {
    const normalized = normalizeMemoCategory(value);
    if (!normalized) return "Category is required";
    if (!MEMO_CATEGORY_OPTIONS.includes(normalized)) {
        return "Category must be HR, Admin, General, or Project";
    }
    return null;
}

export function validateMemoDescription(value) {
    const normalized = normalizeMemoDescription(value);
    if (!normalized) return "Description is required";
    if (normalized.length < 10) return "Description must be at least 10 characters";
    if (normalized.length > 4000) return "Description must be no more than 4000 characters";
    return null;
}

export function validateMemoDocumentRow(doc) {
    if (!doc || typeof doc !== "object") return { ok: true };
    const ctx = String(doc.context || "").toLowerCase();
    if (ctx !== "memo") return { ok: true };

    const checks = [
        validateMemoDocumentName(doc.type),
        validateMemoIssueDate(doc.issueDate || doc.startDate),
        validateMemoCategory(doc.provider),
        validateMemoDescription(doc.description),
    ];
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

export function validateCompanyMemoDocumentsPayload(documents = []) {
    if (!Array.isArray(documents)) return { ok: true };
    for (const doc of documents) {
        const check = validateMemoDocumentRow(doc);
        if (!check.ok) return check;
    }
    return { ok: true };
}

export function normalizeCompanyMemoRow(doc) {
    if (!doc || typeof doc !== "object") return doc;
    const row = { ...doc };
    if (row.type !== undefined) row.type = normalizeMemoDocumentName(row.type);
    if (row.description !== undefined) row.description = normalizeMemoDescription(row.description);
    if (row.provider !== undefined) row.provider = normalizeMemoCategory(row.provider);
    if (row.context === undefined || String(row.context).trim() === "") row.context = "memo";
    row.expiryDate = "";
    return row;
}
