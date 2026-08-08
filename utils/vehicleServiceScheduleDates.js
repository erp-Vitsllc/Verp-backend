/**
 * Shared service window date rules for Oil / Tire / Mechanical / Body / Accident:
 * - start >= today
 * - end >= start
 */

export function localYmd(value = new Date()) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

export function normalizeServiceScheduleDate(value) {
    if (value == null || String(value).trim() === '') return '';
    const str = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return localYmd(d);
}

/**
 * Throws if start/end violate schedule rules.
 */
export function assertServiceScheduleDates(
    startRaw,
    endRaw,
    { requireBoth = true, requireStartFromToday = true } = {},
) {
    const start = normalizeServiceScheduleDate(startRaw);
    const end = normalizeServiceScheduleDate(endRaw);
    const today = localYmd();

    if (requireBoth && !start) {
        throw new Error('Service start date is required.');
    }
    if (requireBoth && !end) {
        throw new Error('Service end date is required.');
    }
    if (start && requireStartFromToday && start < today) {
        throw new Error('Service start date must be today or later.');
    }
    if (start && end && end < start) {
        throw new Error('Service end date must be on or after the start date.');
    }

    return { start, end, today };
}
