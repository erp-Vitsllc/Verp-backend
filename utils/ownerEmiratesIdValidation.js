const EMIRATES_ID_REGEX = /^[0-9]{15}$/;

export function stripDangerousText(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object" || Array.isArray(value)) {
        throw new Error("Invalid data type for Emirates ID field");
    }
    let str = String(value).trim();
    str = str.replace(/<[^>]*>?/gm, "");
    return str;
}

export function normalizeEmiratesIdNumber(value) {
    return stripDangerousText(value)
        .replace(/[\u200E\u200F\u202A-\u202E]/g, "")
        .replace(/\D/g, "");
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

export function validateEmiratesIdNumber(value, { existingNumbers = [], skipNumber = "" } = {}) {
    const normalized = normalizeEmiratesIdNumber(value);
    if (!normalized) return "Emirates ID Number is required";
    if (normalized.length !== 15) return "Emirates ID Number must be exactly 15 digits";
    if (!normalized.startsWith("784")) return "Emirates ID Number must start with 784";
    if (!EMIRATES_ID_REGEX.test(normalized)) {
        return "Emirates ID Number must contain digits only";
    }
    const skip = normalizeEmiratesIdNumber(skipNumber);
    for (const other of existingNumbers) {
        const n = normalizeEmiratesIdNumber(other);
        if (n && n === normalized && n !== skip) {
            return "Emirates ID Number must be unique";
        }
    }
    return null;
}

export function validateEmiratesIdIssueDate(value) {
    if (!value) return "Issue Date is required";
    const d = parseDate(value);
    if (!d) return "Issue Date must be a valid date";
    if (d.getFullYear() < 1900) return "Issue Date minimum year is 1900";
    const today = startOfDay(new Date());
    if (d > today) return "Issue Date cannot be in the future";
    return null;
}

export function validateEmiratesIdExpiryDate(value, issueDate) {
    if (!value) return "Expiry Date is required";
    const expiry = parseDate(value);
    if (!expiry) return "Expiry Date must be a valid date";
    if (expiry.getFullYear() < 1900) return "Expiry Date minimum year is 1900";
    const issue = parseDate(issueDate);
    if (issue && expiry <= issue) return "Expiry Date must be greater than Issue Date";
    return null;
}

export function normalizeOwnerEmiratesIdRow(emiratesId) {
    if (!emiratesId || typeof emiratesId !== "object") return emiratesId;
    const row = { ...emiratesId };
    if (row.number !== undefined) row.number = normalizeEmiratesIdNumber(row.number);
    return row;
}

export function validateOwnerEmiratesIdRow(emiratesId, { owners = [], ownerIndex = -1 } = {}) {
    if (!emiratesId || typeof emiratesId !== "object") {
        return { ok: true };
    }
    const hasContent =
        emiratesId.number ||
        emiratesId.issueDate ||
        emiratesId.expiryDate ||
        emiratesId.attachment;
    if (!hasContent) return { ok: true };

    const existingNumbers = [];
    owners.forEach((owner, idx) => {
        if (idx === ownerIndex) return;
        const n = owner?.emiratesId?.number;
        if (n) existingNumbers.push(n);
    });

    const checks = [
        validateEmiratesIdNumber(emiratesId.number, { existingNumbers }),
        validateEmiratesIdIssueDate(emiratesId.issueDate),
        validateEmiratesIdExpiryDate(emiratesId.expiryDate, emiratesId.issueDate),
    ];
    for (const err of checks) {
        if (err) return { ok: false, message: err };
    }
    if (!emiratesId.attachment) {
        return { ok: false, message: "Emirates ID document is required" };
    }
    return { ok: true };
}

export function validateOwnersEmiratesIdPayload(owners = [], { onlyValidateOwnerIndices = null } = {}) {
    if (!Array.isArray(owners)) return { ok: true };
    const onlySet = Array.isArray(onlyValidateOwnerIndices)
        ? new Set(onlyValidateOwnerIndices)
        : null;
    for (let i = 0; i < owners.length; i++) {
        if (onlySet && !onlySet.has(i)) continue;
        const check = validateOwnerEmiratesIdRow(owners[i]?.emiratesId, { owners, ownerIndex: i });
        if (!check.ok) return check;
    }
    const numbers = new Set();
    for (const owner of owners) {
        const n = normalizeEmiratesIdNumber(owner?.emiratesId?.number);
        if (!n) continue;
        if (numbers.has(n)) {
            return { ok: false, message: "Emirates ID Number must be unique" };
        }
        numbers.add(n);
    }
    return { ok: true };
}
