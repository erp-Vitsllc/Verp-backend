import { documentTaskLabel } from "./taskDuplicateKey.js";

export const SOURCE_STILL_PENDING_MESSAGE =
    "This task is already on Pending. You can go to the task. It can be completed only when that status is Completed or Closed.";

export const OLD_EXPIRY_STILL_SAME_MESSAGE =
    "The old document still has the same expiry date. Renew it, then confirm. This task can be completed only after that expiry date changes. You can go to the task.";

const CLOSED = new Set([
    "closed",
    "rejected",
    "cancelled",
    "canceled",
    "dismissed",
    "archived",
]);

const COMPLETED = new Set([
    "completed",
    "complete",
    "done",
    "approved",
    "paid",
    "billed",
    "renewed",
    "replaced",
    "accepted",
    "active",
]);

const OPEN = new Set([
    "on hold",
    "in progress",
    "open",
    "reopened",
    "draft",
    "processing",
    "submitted",
    "scheduled",
    "scheduled service",
    "failed",
    "not paid",
    "hold",
    "none",
]);

function normalizedStatus(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ");
}

/** pending, completed, closed, or unknown. Approved work counts as completed. */
export function classifyWorkStatus(value) {
    const text = normalizedStatus(value);
    if (!text) return "unknown";
    if (text.includes("not renew")) return "closed";
    if (text.startsWith("pending") || /\bpending\b/.test(text)) return "pending";
    if (OPEN.has(text)) return "pending";
    if (CLOSED.has(text)) return "closed";
    if (COMPLETED.has(text)) return "completed";
    return "unknown";
}

function titled(kind) {
    if (kind === "completed") return "Completed";
    if (kind === "closed") return "Closed";
    if (kind === "pending") return "Pending";
    return "Pending";
}

/**
 * The specific record wins. A dashboard row still marked Pending does not
 * keep the task open after that record is Completed or Closed.
 * An unknown record falls back to the dashboard status, and stays Pending
 * when neither status is finished.
 */
export function combineSourceStatus(recordStatus, actionStatus) {
    const record = classifyWorkStatus(recordStatus);
    if (record !== "unknown") return titled(record);
    const action = classifyWorkStatus(actionStatus);
    if (action !== "unknown") return titled(action);
    return "Pending";
}

export function serviceStageState(stage) {
    const kind = classifyWorkStatus(stage);
    if (kind === "unknown") return "Pending";
    return titled(kind);
}

function dayKeyFromParts(year, month, day) {
    const y = String(year || "");
    const m = String(month || "").padStart(2, "0");
    const d = String(day || "").padStart(2, "0");
    if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) return "";
    return `${y}-${m}-${d}`;
}

/** Calendar days that can represent this expiry. Reminder text uses Exp: dd/mm/yyyy. */
export function expiryDayKeys(value) {
    const keys = new Set();
    const add = (key) => {
        if (key) keys.add(key);
    };
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return keys;
        add(new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Dubai",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).format(value));
        add(new Intl.DateTimeFormat("en-CA", {
            timeZone: "UTC",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).format(value));
        add(expiryDayKey(value.toLocaleDateString("en-GB")));
        return keys;
    }
    add(expiryDayKey(value));
    return keys;
}

/** Calendar day in Dubai. Reminder text uses Exp: dd/mm/yyyy. */
export function expiryDayKey(value) {
    if (value == null || value === "") return "";
    if (value instanceof Date) {
        return [...expiryDayKeys(value)][0] || "";
    }
    const text = String(value).trim();
    const labeled = text.match(/exp:\s*(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/i);
    if (labeled) return dayKeyFromParts(labeled[3], labeled[2], labeled[1]);
    const slash = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
    if (slash) return dayKeyFromParts(slash[3], slash[2], slash[1]);
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return "";
    return [...expiryDayKeys(parsed)][0] || "";
}

export function isDocumentExpiryRequest(requestType, reminderText = "") {
    if (/document expiry/i.test(String(requestType || ""))) return true;
    return /^expiry follow-up required:/i.test(String(reminderText || ""));
}

function sameDocument(doc, label) {
    return documentTaskLabel(doc?.label) === label;
}

function dateKeys(doc) {
    return expiryDayKeys(doc?.expiryDate);
}

/**
 * Pending while this document's expiry is still the old date.
 * A renew counts only when a live card of that document has a different expiry.
 * An archived copy that still has the old date does not confirm the renew.
 * Closed when the document was removed or marked not renewed, with no live card left.
 */
export function expiryFollowUpState({ reminderText, liveDocs, oldDocs = [] }) {
    const label = documentTaskLabel(reminderText);
    if (!label) return "Pending";
    const expiryKey = expiryDayKey(reminderText);
    const live = (liveDocs || []).filter((doc) => sameDocument(doc, label));
    const old = (oldDocs || []).filter((doc) => sameDocument(doc, label));
    if (!expiryKey) return live.length || old.length ? "Pending" : "Closed";

    const stillOld = (doc) => dateKeys(doc).has(expiryKey);
    const renewed = (doc) => {
        const keys = dateKeys(doc);
        return keys.size > 0 && !keys.has(expiryKey);
    };
    if (live.some(stillOld) || live.some((doc) => dateKeys(doc).size === 0)) return "Pending";
    if (live.some(renewed)) return "Completed";

    const oldSame = old.filter(stillOld);
    if (oldSame.length) {
        return oldSame.every((doc) => doc.notRenewed === true) ? "Closed" : "Pending";
    }
    return "Closed";
}

export function sourceGateApplies(task, action, category = "") {
    if (!action || String(action.requestType || "") === "Task Manager") return false;
    const type = String(task?.taskType || category || "").trim().toLowerCase();
    if (type === "general task") return false;
    return type === "system task" || type === "workflow task" || type === "work flow task";
}
