/**
 * Leave bell rows stay only while someone still has to accept or reject them.
 * Accepted, rejected, and deleted requests stay off the bell.
 * A request that is still pending stays on the bell after its last leave day.
 */

const MONTHS = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
};

const CLOSED_STATUSES = new Set([
    "approved",
    "accepted",
    "rejected",
    "deleted",
    "dismissed",
    "completed",
    "cancelled",
    "canceled",
]);

export function dubaiTodayKey(now = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Dubai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(now);
}

function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
}

function isoKey(year, month, day) {
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    if (!y || m < 1 || m > 12 || d < 1 || d > 31) return "";
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function yearOf(value, fallbackYear) {
    const match = clean(value).match(/\b(20\d{2})\b/);
    if (match) return Number(match[1]);
    const year = Number(fallbackYear);
    return year >= 2000 && year <= 2100 ? year : new Date().getFullYear();
}

function readMeta(value) {
    if (!value) return {};
    if (typeof value === "object") return value;
    try {
        const parsed = JSON.parse(String(value));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

/** Every calendar day mentioned in leave copy, oldest first. */
export function leaveDateKeysInText(text, fallbackYear) {
    const raw = clean(text);
    if (!raw) return [];
    const keys = [];
    const push = (key) => {
        if (key && !keys.includes(key)) keys.push(key);
    };

    for (const match of raw.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) {
        push(isoKey(match[1], match[2], match[3]));
    }

    const monthName = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
    const named = new RegExp(
        `\\b(?:(\\d{1,2})\\s+(${monthName})(?:\\s+(20\\d{2}))?|(${monthName})\\s+(\\d{1,2})(?:,?\\s+(20\\d{2}))?)\\b`,
        "gi",
    );
    for (const match of raw.matchAll(named)) {
        const day = match[1] || match[5];
        const monthWord = match[2] || match[4];
        const year = match[3] || match[6] || fallbackYear;
        push(isoKey(year, MONTHS[String(monthWord || "").toLowerCase()], day));
    }

    keys.sort();
    return keys;
}

export function leaveRangeOf(item = {}, today = dubaiTodayKey()) {
    const meta = readMeta(item.extra3);
    const directEnd = clean(item.endDateKey || meta.to || meta.end || "").slice(0, 10);
    const directStart = clean(item.startDateKey || meta.from || meta.start || item.extra1 || "").slice(0, 10);
    const fallbackYear = yearOf(item.requestedDate || item.createdAt || directStart || today, today.slice(0, 4));
    const blob = [
        item.extra1,
        item.extra2,
        item.message,
        item.description,
        item.reason,
        meta.summary,
    ].map(clean).filter(Boolean).join(" ");
    const found = leaveDateKeysInText(
        [directStart, directEnd, blob].filter(Boolean).join(" "),
        fallbackYear,
    );
    const start = /^\d{4}-\d{2}-\d{2}$/.test(directStart) ? directStart : found[0] || "";
    const end = /^\d{4}-\d{2}-\d{2}$/.test(directEnd) ? directEnd : found[found.length - 1] || start;
    return { start, end };
}

export function isClosedLeaveStatus(status) {
    return CLOSED_STATUSES.has(clean(status).toLowerCase());
}

function rangesOverlap(start, end, otherStart, otherEnd) {
    if (!start || !end || !otherStart || !otherEnd) return false;
    return start <= otherEnd && otherStart <= end;
}

/**
 * @param {object[]} items
 * @param {{ today?: string, pendingRanges?: {employeeMongoId: string, from: string, to: string}[], decidedRanges?: {employeeMongoId: string, from: string, to: string}[] }} [options]
 */
export function selectOpenLeaveBellItems(items, options = {}) {
    const today = options.today || dubaiTodayKey();
    const pendingRanges = options.pendingRanges || [];
    const decidedRanges = options.decidedRanges || [];
    return (items || []).filter((item) => {
        if (isClosedLeaveStatus(item?.status)) return false;
        const range = leaveRangeOf(item, today);

        const employeeId = clean(item?.employeeMongoId);
        if (!employeeId || !range.start || !range.end) return true;
        const overlaps = (rows) => rows.some((row) =>
            clean(row.employeeMongoId) === employeeId
            && rangesOverlap(range.start, range.end, row.from, row.to),
        );
        if (overlaps(decidedRanges) && !overlaps(pendingRanges)) return false;
        return true;
    });
}
