/** Locator latest-position speed is knots. Convert once. */
export function convertKnotsToKmh(speedKnots) {
    const knots = Number(speedKnots);
    if (!Number.isFinite(knots)) return null;
    return knots * 1.852;
}

export function metersToKm(meters) {
    const value = Number(meters);
    if (!Number.isFinite(value)) return null;
    return value / 1000;
}

/**
 * Locator summary durations are milliseconds.
 * Under 24h: HH:mm:ss. At or over 24h: X day(s) HH:mm:ss.
 */
export function formatDuration(milliseconds) {
    const ms = Math.max(0, Math.round(Number(milliseconds) || 0));
    const totalSec = Math.floor(ms / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const clock = [hours, mins, secs].map((part) => String(part).padStart(2, '0')).join(':');
    if (days <= 0) return clock;
    return `${days} day${days === 1 ? '' : 's'} ${clock}`;
}

function dubaiParts(date = new Date()) {
    const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Dubai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    });
    return Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
}

/** Asia/Dubai calendar date key yyyy-MM-dd. */
export function dubaiDateKey(date = new Date()) {
    const parts = dubaiParts(date);
    return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Locator summary `from` / `to`: DD-MM-YYYY HH:mm:ss in the account calendar (Asia/Dubai). */
export function dubaiReportStamp(dateKey, time) {
    const [year, month, day] = String(dateKey || '').split('-');
    if (!year || !month || !day) return '';
    return `${day}-${month}-${year} ${time}`;
}

export function dubaiReportRange(fromKey, toKey) {
    return {
        from: dubaiReportStamp(fromKey, '00:00:00'),
        to: dubaiReportStamp(toKey, '23:59:59'),
    };
}

/**
 * Current odometer shown in Locator.
 * Prefer attributes.totalDistanceKm. Do not use attributes.odometer or attributes.distance.
 * Returns null when Locator did not send a cumulative kilometer reading.
 */
export function currentDistanceKm(positionOrAttrs) {
    const source = positionOrAttrs && typeof positionOrAttrs === 'object' ? positionOrAttrs : {};
    const attrs = source.attributes && typeof source.attributes === 'object' ? source.attributes : source;
    const explicit = Number(String(attrs.totalDistanceKm ?? source.totalDistanceKm ?? '').replace(/,/g, ''));
    if (Number.isFinite(explicit) && explicit > 0) return Number(explicit.toFixed(2));
    const meters = Number(attrs.totalDistance ?? source.totalDistance);
    if (Number.isFinite(meters) && meters > 0) return Number((meters / 1000).toFixed(2));
    return null;
}

export function rawOdometerMeters(positionOrAttrs) {
    const source = positionOrAttrs && typeof positionOrAttrs === 'object' ? positionOrAttrs : {};
    const attrs = source.attributes && typeof source.attributes === 'object' ? source.attributes : source;
    const meters = Number(attrs.odometer ?? source.odometer);
    return Number.isFinite(meters) && meters > 0 ? meters : null;
}

/** Prefer Locator's formatted temperature. Do not scale raw temp1. */
export function locatorTemperatureC(positionOrAttrs) {
    const source = positionOrAttrs && typeof positionOrAttrs === 'object' ? positionOrAttrs : {};
    const attrs = source.attributes && typeof source.attributes === 'object' ? source.attributes : source;
    const formatted = attrs.temperature ?? source.temperature;
    if (formatted == null || formatted === '') return null;
    const value = Number(formatted);
    return Number.isFinite(value) ? value : null;
}

export function locatorSampleTime(position) {
    const raw = position?.deviceTime || position?.fixTime || position?.serverTime;
    if (!raw) return null;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
}
