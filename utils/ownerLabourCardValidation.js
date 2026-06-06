const LABOUR_CARD_NUMBER_REGEX = /^[A-Za-z0-9]{5,20}$/;

export function stripDangerousText(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object" || Array.isArray(value)) {
        throw new Error("Invalid data type for Labour Card field");
    }
    let str = String(value).trim();
    str = str.replace(/<[^>]*>?/gm, "");
    return str;
}

export function normalizeLabourCardNumber(value) {
    return stripDangerousText(value).replace(/\s/g, "");
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

export function validateLabourCardNumber(value) {
    const normalized = normalizeLabourCardNumber(value);
    if (!normalized) return "Labour Card Number is required";
    if (normalized.length < 5) return "Labour Card Number must be at least 5 characters";
    if (normalized.length > 20) return "Labour Card Number must be no more than 20 characters";
    if (!LABOUR_CARD_NUMBER_REGEX.test(normalized)) {
        return "Labour Card Number may contain only letters and numbers (A–Z, a–z, 0–9)";
    }
    return null;
}

export function validateLabourCardExpiryDate(value) {
    if (!value) return "Expiry Date is required";
    const expiry = parseDate(value);
    if (!expiry) return "Expiry Date must be a valid date";
    if (expiry.getFullYear() < 1900) return "Expiry Date minimum year is 1900";
    const today = startOfDay(new Date());
    if (expiry <= today) return "Expiry Date must be a future date";
    return null;
}

export function normalizeOwnerLabourCardRow(labourCard) {
    if (!labourCard || typeof labourCard !== "object") return labourCard;
    const row = { ...labourCard };
    if (row.number !== undefined) row.number = normalizeLabourCardNumber(row.number);
    return row;
}

export function validateOwnerLabourCardRow(labourCard) {
    if (!labourCard || typeof labourCard !== "object") {
        return { ok: true };
    }
    const hasContent =
        labourCard.number ||
        labourCard.expiryDate ||
        labourCard.attachment;
    if (!hasContent) return { ok: true };

    const checks = [
        validateLabourCardNumber(labourCard.number),
        validateLabourCardExpiryDate(labourCard.expiryDate),
    ];
    for (const err of checks) {
        if (err) return { ok: false, message: err };
    }
    if (!labourCard.attachment) {
        return { ok: false, message: "Labour Card document is required" };
    }
    return { ok: true };
}

export function validateOwnersLabourCardPayload(owners = [], { onlyValidateOwnerIndices = null } = {}) {
    if (!Array.isArray(owners)) return { ok: true };
    const onlySet = Array.isArray(onlyValidateOwnerIndices)
        ? new Set(onlyValidateOwnerIndices)
        : null;
    for (let i = 0; i < owners.length; i++) {
        if (onlySet && !onlySet.has(i)) continue;
        const check = validateOwnerLabourCardRow(owners[i]?.labourCard);
        if (!check.ok) return check;
    }
    return { ok: true };
}
