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
