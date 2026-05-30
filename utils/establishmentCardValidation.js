const CARD_NUMBER_REGEX = /^[A-Z0-9-]{4,30}$/;

const ALLOWED_MIME_TYPES = new Set([
    "application/pdf",
    "image/jpeg",
    "image/jpg",
    "image/png",
]);

export function sanitizeEstablishmentField(val, fieldName) {
    if (val === undefined || val === null) return "";
    if (typeof val === "object" || Array.isArray(val)) {
        throw new Error(`Invalid data type for field ${fieldName}`);
    }
    let str = String(val).trim();
    str = str.replace(/<[^>]*>?/gm, "");
    return str;
}

export function normalizeEstablishmentCardNumber(value) {
    return sanitizeEstablishmentField(value, "Card Number").toUpperCase();
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

export function validateEstablishmentCardNumber(value) {
    const normalized = normalizeEstablishmentCardNumber(value);
    if (!normalized) return "Card Number is required";
    if (normalized.length < 4) return "Card Number must be at least 4 characters";
    if (normalized.length > 30) return "Card Number must be no more than 30 characters";
    if (!CARD_NUMBER_REGEX.test(normalized)) {
        return "Card Number may contain only letters, numbers, and hyphens (A–Z, 0–9, -)";
    }
    return null;
}

export function validateEstablishmentCardExpiryDate(value) {
    if (!value) return "Expiry Date is required";
    const expiry = parseDate(value);
    if (!expiry) return "Expiry Date must be a valid date";
    if (expiry.getFullYear() < 1900) return "Expiry Date minimum year is 1900";
    const today = startOfDay(new Date());
    if (expiry <= today) return "Expiry Date must be a future date";
    return null;
}

export function validateEstablishmentCardPayload(payload = {}, { requireAttachment = true } = {}) {
    const touched =
        Object.prototype.hasOwnProperty.call(payload, "establishmentCardNumber") ||
        Object.prototype.hasOwnProperty.call(payload, "establishmentCardExpiry") ||
        Object.prototype.hasOwnProperty.call(payload, "establishmentCardAttachment");

    if (!touched) return { ok: true };

    const number = Object.prototype.hasOwnProperty.call(payload, "establishmentCardNumber")
        ? payload.establishmentCardNumber
        : undefined;
    const expiry = Object.prototype.hasOwnProperty.call(payload, "establishmentCardExpiry")
        ? payload.establishmentCardExpiry
        : undefined;

    const numberErr = validateEstablishmentCardNumber(number);
    if (numberErr) return { ok: false, message: numberErr };

    const expiryErr = validateEstablishmentCardExpiryDate(expiry);
    if (expiryErr) return { ok: false, message: expiryErr };

    if (requireAttachment && !payload.establishmentCardAttachment) {
        return { ok: false, message: "Attachment is required (PDF, JPG, JPEG, or PNG, max 5MB)" };
    }

    return { ok: true };
}
