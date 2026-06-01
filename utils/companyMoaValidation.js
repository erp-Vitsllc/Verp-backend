export function stripDangerousText(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object" || Array.isArray(value)) {
        throw new Error("Invalid data type for MOA field");
    }
    let str = String(value).trim();
    str = str.replace(/<[^>]*>?/gm, "");
    return str;
}

export function normalizeMoaVersion(value) {
    return stripDangerousText(value).slice(0, 30);
}

export function normalizeMoaNote(value) {
    return stripDangerousText(value).slice(0, 2000);
}

function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function validateMoaVersion(value) {
    const normalized = normalizeMoaVersion(value);
    if (!normalized) return "MOA Version is required";
    if (normalized.length > 30) return "MOA Version must be no more than 30 characters";
    return null;
}

export function validateMoaNote(value) {
    if (value == null || String(value).trim() === "") return null;
    const normalized = normalizeMoaNote(value);
    if (normalized.length > 2000) return "Note must be no more than 2000 characters";
    return null;
}

export function validateMoaIssueDate(value) {
    if (!value) return "Issue Date is required";
    const d = parseDate(value);
    if (!d) return "Issue Date must be a valid date";
    if (d.getFullYear() < 1900) return "Issue Date minimum year is 1900";
    return null;
}

export function validateMoaDocumentRow(doc) {
    if (!doc || typeof doc !== "object") return { ok: true };
    const ctx = String(doc.context || "").toLowerCase();
    const typeLower = String(doc.type || "").toLowerCase();
    if (ctx !== "moa" && !typeLower.includes("moa")) return { ok: true };

    const checks = [
        validateMoaVersion(doc.type),
        validateMoaNote(doc.description),
        validateMoaIssueDate(doc.issueDate || doc.startDate),
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

export function validateCompanyMoaDocumentsPayload(documents = []) {
    if (!Array.isArray(documents)) return { ok: true };
    for (const doc of documents) {
        const check = validateMoaDocumentRow(doc);
        if (!check.ok) return check;
    }
    return { ok: true };
}

export function normalizeCompanyMoaRow(doc) {
    if (!doc || typeof doc !== "object") return doc;
    const row = { ...doc };
    if (row.type !== undefined) row.type = normalizeMoaVersion(row.type);
    if (row.description !== undefined) row.description = normalizeMoaNote(row.description);
    if (row.context === undefined || String(row.context).trim() === "") row.context = "moa";
    row.expiryDate = "";
    return row;
}
