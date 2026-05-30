const EJARI_TYPE_REGEX = /^[A-Za-z0-9\s&(),.-]{3,100}$/;

export function sanitizeEjariField(val, fieldName) {
    if (val === undefined || val === null) return "";
    if (typeof val === "object" || Array.isArray(val)) {
        throw new Error(`Invalid data type for field ${fieldName}`);
    }
    let str = String(val).trim();
    str = str.replace(/<[^>]*>?/gm, "");
    return str;
}

export function normalizeEjariType(value) {
    return sanitizeEjariField(value, "Ejari Type");
}

export function normalizeEjariNote(value) {
    return sanitizeEjariField(value, "Note");
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

export function validateEjariType(value) {
    const normalized = normalizeEjariType(value);
    if (!normalized) return "Ejari Type is required";
    if (normalized.length < 3) return "Ejari Type must be at least 3 characters";
    if (normalized.length > 100) return "Ejari Type must be no more than 100 characters";
    if (!EJARI_TYPE_REGEX.test(normalized)) {
        return "Ejari Type may contain only letters, numbers, spaces, and & ( ) , . -";
    }
    return null;
}

export function validateEjariAddValue(value, hasValue) {
    if (hasValue === false) return null;
    if (value === "" || value === null || value === undefined) {
        return "Add Value (AED) is required when Add Value is Yes";
    }
    const str = String(value).trim();
    if (!/^\d+(\.\d+)?$/.test(str)) return "Add Value must be a valid number";
    if (Number(str) < 0) return "Add Value must be at least 0";
    return null;
}

export function validateEjariNote(value) {
    const note = normalizeEjariNote(value);
    if (!note) return null;
    if (note.length > 500) return "Note must be no more than 500 characters";
    return null;
}

export function validateEjariIssueDate(value) {
    if (!value) return null;
    const d = parseDate(value);
    if (!d) return "Issue Date must be a valid date";
    if (d.getFullYear() < 1900) return "Issue Date minimum year is 1900";
    return null;
}

export function validateEjariExpiryDate(value, issueDate) {
    if (!value) return "Expiry Date is required";
    const expiry = parseDate(value);
    if (!expiry) return "Expiry Date must be a valid date";
    if (expiry.getFullYear() < 1900) return "Expiry Date minimum year is 1900";
    const today = startOfDay(new Date());
    if (expiry <= today) return "Expiry Date must be a future date";
    const issue = parseDate(issueDate);
    if (issue && expiry <= issue) return "Expiry Date must be greater than Issue Date";
    return null;
}

export function normalizeEjariRow(row = {}) {
    const next = row && typeof row === "object" ? { ...row } : {};
    if (next.type != null) next.type = normalizeEjariType(next.type);
    if (next.description != null) next.description = normalizeEjariNote(next.description);
    if (next.hasValue === false || next.value === "" || next.value === null) {
        next.value = null;
    } else if (next.value != null && next.value !== "") {
        next.value = Number(String(next.value).trim());
        if (Number.isNaN(next.value)) next.value = null;
    }
    return next;
}

function rowHasAddValue(row) {
    if (row?.hasValue === false) return false;
    return row?.value !== "" && row?.value != null && row?.value !== undefined;
}

export function validateEjariRow(row = {}, { requireAttachment = true } = {}) {
    const issueRaw = row.startDate || row.issueDate || "";
    const hasValue = rowHasAddValue(row);

    const typeErr = validateEjariType(row.type);
    if (typeErr) return { ok: false, message: typeErr };

    const noteErr = validateEjariNote(row.description);
    if (noteErr) return { ok: false, message: noteErr };

    const issueErr = validateEjariIssueDate(issueRaw);
    if (issueErr) return { ok: false, message: issueErr };

    const expiryErr = validateEjariExpiryDate(row.expiryDate, issueRaw);
    if (expiryErr) return { ok: false, message: expiryErr };

    const valueErr = validateEjariAddValue(row.value, hasValue);
    if (valueErr) return { ok: false, message: valueErr };

    const attUrl = row.document?.url || row.attachment;
    if (requireAttachment && !attUrl) {
        return { ok: false, message: "PDF attachment is required (max 5MB)" };
    }

    return { ok: true };
}

export function validateEjariArrayPayload(ejari = []) {
    if (!Array.isArray(ejari)) return { ok: false, message: "Invalid Ejari data" };
    for (const row of ejari) {
        const check = validateEjariRow(row, { requireAttachment: true });
        if (!check.ok) return check;
    }
    return { ok: true };
}
