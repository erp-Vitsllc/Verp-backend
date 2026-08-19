/**
 * Fine issued/report dates are calendar days, not timestamps.
 * Store at UTC noon so the same day is shown in UAE (UTC+4) and UTC-based servers.
 */

function ymdFromValue(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return {
            year: value.getUTCFullYear(),
            month: value.getUTCMonth() + 1,
            day: value.getUTCDate(),
        };
    }

    const raw = String(value).trim();
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
        return {
            year: Number(iso[1]),
            month: Number(iso[2]),
            day: Number(iso[3]),
        };
    }

    const dmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (dmy) {
        const first = Number(dmy[1]);
        const second = Number(dmy[2]);
        const year = Number(dmy[3]);
        // Prefer dd/MM when the first part is > 12; otherwise treat as MM/dd (en-US display).
        if (first > 12 && second >= 1 && second <= 12) {
            return { year, month: second, day: first };
        }
        return { year, month: first, day: second };
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return {
        year: parsed.getUTCFullYear(),
        month: parsed.getUTCMonth() + 1,
        day: parsed.getUTCDate(),
    };
}

export function parseFineCalendarDate(value) {
    const ymd = ymdFromValue(value);
    if (!ymd || !ymd.year || ymd.month < 1 || ymd.month > 12 || ymd.day < 1 || ymd.day > 31) {
        return null;
    }
    return new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day, 12, 0, 0));
}

export function formatFineCalendarDate(value) {
    const d = parseFineCalendarDate(value);
    if (!d) return '—';
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}
