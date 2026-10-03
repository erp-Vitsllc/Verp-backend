/** Closed months stay on screen from the stored row; refresh them about once a week. */
export const CLOSED_FUEL_MONTH_GPS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Current month GPS is reused for a couple of minutes, then refreshed behind the list. */
export const OPEN_FUEL_MONTH_GPS_TTL_MS = 2 * 60 * 1000;
/** Show a recent current-month figure immediately while a newer one is calculated. */
export const OPEN_FUEL_MONTH_GPS_USABLE_MS = 10 * 60 * 1000;

function computedAgeMs(stat, now) {
    const at = new Date(stat?.computedAt).getTime();
    if (!Number.isFinite(at)) return null;
    return now.getTime() - at;
}

export function fuelMonthRangeIsClosed(rangeEnd, now = new Date()) {
    const end = new Date(rangeEnd).getTime();
    return Number.isFinite(end) && end <= now.getTime();
}

/** A stored month can be shown without scanning GPS history again. */
export function fuelMonthGpsIsUsable(stat, rangeEnd, now = new Date()) {
    const age = computedAgeMs(stat, now);
    if (age == null || age < 0) return false;
    if (fuelMonthRangeIsClosed(rangeEnd, now)) return true;
    return age < OPEN_FUEL_MONTH_GPS_USABLE_MS;
}

/** Fresh rows do not need another Locator read. */
export function fuelMonthGpsIsFresh(stat, rangeEnd, now = new Date()) {
    const age = computedAgeMs(stat, now);
    if (age == null || age < 0) return false;
    const ttl = fuelMonthRangeIsClosed(rangeEnd, now)
        ? CLOSED_FUEL_MONTH_GPS_TTL_MS
        : OPEN_FUEL_MONTH_GPS_TTL_MS;
    return age < ttl;
}
