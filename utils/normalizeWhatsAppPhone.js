/**
 * Normalize a phone number for Meta WhatsApp Cloud API (digits only, no +).
 * UAE local forms become 971... without corrupting other international numbers.
 */
export function normalizeWhatsAppPhone(input) {
    if (input == null) return '';

    let raw = String(input).trim();
    if (!raw) return '';

    raw = raw.replace(/[()\-\s.]/g, '');
    raw = raw.replace(/^\+/, '');

    if (raw.startsWith('00')) {
        raw = raw.slice(2);
    }

    const digits = raw.replace(/\D/g, '');
    if (!digits) return '';

    if (digits.startsWith('971')) {
        return digits;
    }

    // UAE local mobile: 0501234567 / 05XXXXXXXX
    if (digits.length === 10 && digits.startsWith('05')) {
        return `971${digits.slice(1)}`;
    }

    // UAE local without trunk 0: 501234567
    if (digits.length === 9 && digits.startsWith('5')) {
        return `971${digits}`;
    }

    // Other local numbers written with a leading 0 (e.g. 04 landline) — UAE default.
    if (digits.length === 9 && digits.startsWith('0')) {
        return `971${digits.slice(1)}`;
    }

    return digits;
}

export function isValidWhatsAppPhone(input) {
    const normalized = normalizeWhatsAppPhone(input);
    return /^\d{8,15}$/.test(normalized);
}

/** Full mobile WhatsApp only — not an empty field or a country code by itself. */
export function usableWhatsAppNumber(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    const phone = normalizeWhatsAppPhone(raw);
    if (!isValidWhatsAppPhone(phone) || phone.length < 11) return '';
    return phone;
}

/** All stored forms we may have used for the same WhatsApp number. */
export function whatsAppPhoneKeys(input) {
    const n = normalizeWhatsAppPhone(input);
    if (!n) return [];
    const keys = new Set([n, String(input || '').replace(/\D/g, '')].filter(Boolean));
    if (n.startsWith('971') && n.length >= 12) {
        keys.add(`0${n.slice(3)}`);
        keys.add(n.slice(3));
    }
    if (n.length === 10 && n.startsWith('05')) {
        keys.add(`971${n.slice(1)}`);
    }
    if (n.length === 9 && n.startsWith('5')) {
        keys.add(`971${n}`);
    }
    return [...keys];
}
