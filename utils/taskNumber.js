const DUBAI_DATE = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});

function dubaiYear(value) {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return "0000";
    return DUBAI_DATE.format(date).slice(0, 4) || "0000";
}

/** TSK-26-925 — prefix, two-digit year, and that year's task count. */
export function formatTaskNumber(year, count) {
    const yy = String(year || "0000").slice(-2);
    return `TSK-${yy}-${Number(count) || 0}`;
}

export function taskNumberYear(value) {
    return dubaiYear(value).slice(-2);
}

/** TSK-26-218, or null when the value is not a saved task number. */
export function parseTaskNumber(value) {
    const match = /^TSK-(\d{2})-(\d+)$/i.exec(String(value || "").trim());
    if (!match) return null;
    const count = Number(match[2]);
    if (!Number.isInteger(count) || count < 1) return null;
    return { year: match[1], count };
}

export function firstStoredTaskNumber(...values) {
    for (const value of values) {
        const number = String(value || "").trim();
        if (parseTaskNumber(number)) return number;
    }
    return "";
}

/** The earlier saved number. A task keeps the first number it was given. */
export function earlierTaskNumber(left, right) {
    const first = String(left || "").trim();
    const second = String(right || "").trim();
    const a = parseTaskNumber(first);
    const b = parseTaskNumber(second);
    if (!a) return b ? second : "";
    if (!b) return first;
    if (a.year !== b.year) return a.year < b.year ? first : second;
    return a.count <= b.count ? first : second;
}

function byRequestOrder(left, right) {
    const aTime = new Date(left?.requestDate || 0).getTime();
    const bTime = new Date(right?.requestDate || 0).getTime();
    if (aTime !== bTime) return aTime - bTime;
    return String(left?.actionId || "").localeCompare(String(right?.actionId || ""));
}

/**
 * Keep a number that is already saved.
 * The first time nothing is saved, numbering matches the current list order.
 * After that, a new task gets the next number. Older numbers stay where they are.
 */
export function applyStableTaskNumbers(tasks, { nextCountByYear = null } = {}) {
    const list = Array.isArray(tasks) ? tasks : [];
    const missing = [];
    const maxByYear = new Map();
    for (const task of list) {
        if (!task) continue;
        const parsed = parseTaskNumber(task.taskNumber);
        if (!parsed) {
            task.taskNumber = "";
            missing.push(task);
            continue;
        }
        maxByYear.set(parsed.year, Math.max(maxByYear.get(parsed.year) || 0, parsed.count));
    }
    if (!missing.length) return { tasks: list, filled: [], maxByYear };

    const counters = new Map(maxByYear);
    if (nextCountByYear) {
        for (const [year, count] of nextCountByYear) {
            const key = String(year || "").slice(-2);
            counters.set(key, Math.max(counters.get(key) || 0, Number(count) || 0));
            maxByYear.set(key, counters.get(key));
        }
    }
    if (maxByYear.size === 0 && !nextCountByYear) {
        assignTaskNumbers(missing);
        for (const task of missing) {
            const parsed = parseTaskNumber(task.taskNumber);
            if (!parsed) continue;
            maxByYear.set(parsed.year, Math.max(maxByYear.get(parsed.year) || 0, parsed.count));
        }
        return { tasks: list, filled: missing.filter((task) => parseTaskNumber(task.taskNumber)), maxByYear };
    }

    const filled = [];
    for (const task of [...missing].sort(byRequestOrder)) {
        const year = taskNumberYear(task?.requestDate);
        const next = (counters.get(year) || 0) + 1;
        counters.set(year, next);
        maxByYear.set(year, next);
        task.taskNumber = formatTaskNumber(year, next);
        filled.push(task);
    }
    return { tasks: list, filled, maxByYear };
}

/** A later save must not wipe a task number that was already stored. */
export function guardStoredTaskNumber(schema) {
    schema.pre("save", async function keepSavedTaskNumber() {
        if (this.isNew || !this.isModified("taskNumber")) return;
        const nextNumber = String(this.taskNumber || "").trim();
        const existing = await this.constructor.findById(this._id).select("taskNumber").lean();
        const saved = String(existing?.taskNumber || "").trim();
        if (parseTaskNumber(saved) && saved !== nextNumber) this.taskNumber = saved;
    });
}

/**
 * Number tasks in the order they were requested. Each calendar year starts again at 1.
 * Same request time keeps a stable order by action id.
 */
export function assignTaskNumbers(tasks) {
    const numbered = [...(tasks || [])].sort((a, b) => {
        const aTime = new Date(a?.requestDate || 0).getTime();
        const bTime = new Date(b?.requestDate || 0).getTime();
        if (aTime !== bTime) return aTime - bTime;
        return String(a?.actionId || "").localeCompare(String(b?.actionId || ""));
    });
    const yearSequence = new Map();
    for (const task of numbered) {
        const year = dubaiYear(task?.requestDate || new Date());
        const next = (yearSequence.get(year) || 0) + 1;
        yearSequence.set(year, next);
        task.taskNumber = formatTaskNumber(year, next);
    }
    return numbered;
}
