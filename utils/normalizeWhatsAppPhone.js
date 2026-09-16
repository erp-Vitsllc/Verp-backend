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
