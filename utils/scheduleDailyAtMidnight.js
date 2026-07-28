/**
 * Schedule a job for local midnight (00:00) in a timezone, then every 24h after that.
 * Used for date-based auto emails (birthdays, document expiry, utility reminders, etc.).
 *
 * Default TZ: SCHEDULED_EMAIL_TZ → BIRTHDAY_TZ → Asia/Dubai
 */

const DEFAULT_TZ = "Asia/Dubai";

export const getScheduledEmailTimeZone = () =>
    (process.env.SCHEDULED_EMAIL_TZ || process.env.BIRTHDAY_TZ || DEFAULT_TZ).trim() ||
    DEFAULT_TZ;

/**
 * Calendar / clock parts in the given IANA timezone.
 */
export const getZonedParts = (date = new Date(), timeZone = getScheduledEmailTimeZone()) => {
    const formatter = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
        hourCycle: "h23",
    });
    const parts = formatter.formatToParts(date);
    const pick = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
    return {
        year: pick("year"),
        month: pick("month"),
        day: pick("day"),
        hour: pick("hour"),
        minute: pick("minute"),
        second: pick("second"),
    };
};

export const getCalendarPartsInTz = (date = new Date(), timeZone = getScheduledEmailTimeZone()) => {
    const { year, month, day } = getZonedParts(date, timeZone);
    return { year, month, day };
};

/**
 * Convert a wall-clock datetime in `timeZone` to a UTC Date.
 * (Iterative correction — works with DST and fixed-offset zones.)
 */
export const zonedWallTimeToUtc = (
    { year, month, day, hour = 0, minute = 0, second = 0 },
    timeZone = getScheduledEmailTimeZone(),
) => {
    // First guess: treat the wall time as if it were UTC.
    let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);

    for (let i = 0; i < 3; i += 1) {
        const seen = getZonedParts(new Date(utcMs), timeZone);
        const seenAsUtc = Date.UTC(
            seen.year,
            seen.month - 1,
            seen.day,
            seen.hour,
            seen.minute,
            seen.second,
        );
        const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
        utcMs += desiredAsUtc - seenAsUtc;
    }

    return new Date(utcMs);
};

/**
 * Instant of the next 00:00:00 in `timeZone` strictly after `from`.
 */
export const getNextMidnightInTz = (from = new Date(), timeZone = getScheduledEmailTimeZone()) => {
    const { year, month, day } = getCalendarPartsInTz(from, timeZone);
    let midnight = zonedWallTimeToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone);

    // If we are already at/past today's midnight, use tomorrow.
    if (midnight.getTime() <= from.getTime()) {
        // Advance calendar day via UTC noon probe (avoids month/year edge bugs).
        const tomorrowProbe = new Date(Date.UTC(year, month - 1, day + 1, 12, 0, 0));
        const t = getCalendarPartsInTz(tomorrowProbe, timeZone);
        midnight = zonedWallTimeToUtc(
            { year: t.year, month: t.month, day: t.day, hour: 0, minute: 0, second: 0 },
            timeZone,
        );
    }

    return midnight;
};

/**
 * Milliseconds until the next midnight in the configured timezone.
 */
export const msUntilNextMidnight = (from = new Date(), timeZone = getScheduledEmailTimeZone()) => {
    const next = getNextMidnightInTz(from, timeZone);
    return Math.max(1000, next.getTime() - from.getTime());
};

/**
 * Run `fn` once at the next local midnight, then re-arm for each following midnight
 * (more accurate than a fixed 24h interval across DST boundaries).
 * Returns a cancel function.
 *
 * @param {() => void | Promise<void>} fn
 * @param {{ name?: string, timeZone?: string }} [options]
 */
export const scheduleDailyAtMidnight = (fn, options = {}) => {
    const name = options.name || "DailyMidnightJob";
    const timeZone = options.timeZone || getScheduledEmailTimeZone();
    let timeoutId = null;
    let cancelled = false;

    const runSafe = async () => {
        try {
            await fn();
        } catch (err) {
            console.error(`[${name}] midnight run failed:`, err?.message || err);
        }
    };

    const arm = () => {
        if (cancelled) return;
        const delayMs = msUntilNextMidnight(new Date(), timeZone);
        const nextAt = new Date(Date.now() + delayMs);
        console.log(
            `[${name}] next run at ${nextAt.toISOString()} (${timeZone} midnight, in ${Math.round(delayMs / 1000)}s)`,
        );

        timeoutId = setTimeout(async () => {
            if (cancelled) return;
            await runSafe();
            arm();
        }, delayMs);
    };

    arm();

    return () => {
        cancelled = true;
        if (timeoutId) clearTimeout(timeoutId);
    };
};
