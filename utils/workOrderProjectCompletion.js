import DashboardAction from "../models/DashboardAction.js";
import TaskManagerTask from "../models/TaskManagerTask.js";

const FINISHED_TASK = new Set(["Completed", "Cancelled", "Rejected", "Closed"]);
const OPEN_ACTION = new Set(["Pending", "On Hold"]);

export function taskIsFinished(task) {
    if (!task) return false;
    if (FINISHED_TASK.has(String(task.status || ""))) return true;
    const close = task.closeRequest || {};
    return Boolean(close.closedAt) && !close.reviewPending;
}

/** Drop the work order number so the pending line can end with the employee. */
export function pendingTaskLabel(raw, workOrderNo) {
    let text = String(raw || "").replace(/\s+/g, " ").trim();
    const number = String(workOrderNo || "").trim();
    if (number && text) {
        const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        text = text
            .replace(new RegExp(`\\s+on\\s+${escaped}\\b`, "ig"), "")
            .replace(new RegExp(`\\s+for\\s+${escaped}\\b`, "ig"), "")
            .replace(new RegExp(`\\s+to the work order\\s+${escaped}\\b`, "ig"), "")
            .replace(new RegExp(`\\s+${escaped}\\b`, "ig"), "")
            .replace(/\s{2,}/g, " ")
            .trim();
    }
    return text.replace(/^[\s—–\-:]+|[\s—–\-:]+$/g, "").trim();
}

/** One sidebar line: pending task, then the employee it is waiting on. */
export function pendingTaskLine(label, assigneeName) {
    const what = String(label || "").trim() || "task";
    const who = String(assigneeName || "").trim();
    return who ? `pending ${what} on ${who}` : `pending ${what}`;
}

/** A work-order step is still open when its task is unfinished, or when no task exists and the action is still pending. */
export function workOrderStepIsOpen(action, tasks = []) {
    const rows = (Array.isArray(tasks) ? tasks : []).filter(Boolean);
    if (rows.length && rows.every(taskIsFinished)) return false;
    if (rows.some((task) => !taskIsFinished(task))) return true;
    return OPEN_ACTION.has(String(action?.status || "Pending"));
}

export function isCreatedWorkOrderProject(action) {
    return String(action?.requestType || "").trim() === "Work Order Project";
}

function stepLabel(action, tasks) {
    const named = (tasks || []).map((task) => String(task?.taskName || "").trim()).find(Boolean);
    return named || String(action?.extra1 || "").trim() || "A task";
}

/** Other work-order tasks that must finish before the created project task can be completed. */
export function openWorkOrderSteps(root, actions, tasks = []) {
    if (!isCreatedWorkOrderProject(root)) return [];
    const rootId = String(root?._id || "");
    const grouped = new Map();
    for (const task of tasks || []) {
        const key = String(task?.sourceDashboardActionId || "");
        const list = grouped.get(key) || [];
        list.push(task);
        grouped.set(key, list);
    }
    return (actions || []).flatMap((action) => {
        if (String(action?._id || "") === rootId) return [];
        if (!String(action?.requestType || "").startsWith("Work Order ")) return [];
        const rows = grouped.get(String(action._id)) || [];
        if (!workOrderStepIsOpen(action, rows)) return [];
        return [{ id: String(action._id || ""), label: stepLabel(action, rows) }];
    });
}

export function projectCompletionBlockMessage(steps) {
    const names = [...new Set((steps || []).map((step) => String(step?.label || "").trim()).filter(Boolean))];
    if (!names.length) return "";
    if (names.length === 1) {
        return `This project task cannot be completed while ${names[0]} is still pending.`;
    }
    const preview = names.slice(0, 3).join(", ");
    const rest = names.length > 3 ? ` and ${names.length - 3} more` : "";
    return `This project task cannot be completed while other tasks on this work order are still pending: ${preview}${rest}.`;
}

export async function projectTaskCompletionMessage(action) {
    if (!isCreatedWorkOrderProject(action) || !action?.requestId) return "";
    const actions = await DashboardAction.find({
        requestId: action.requestId,
        _id: { $ne: action._id },
        requestType: /^Work Order /,
    }).select("requestType status extra1").lean();
    if (!actions.length) return "";
    const tasks = await TaskManagerTask.find({
        sourceDashboardActionId: { $in: actions.map((item) => item._id) },
    }).select("sourceDashboardActionId status taskName closeRequest.closedAt closeRequest.reviewPending").lean();
    return projectCompletionBlockMessage(openWorkOrderSteps(action, actions, tasks));
}
