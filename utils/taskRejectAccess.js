function taskTypeLabel(value) {
    const key = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (key === "system" || key === "system task") return "System Task";
    if (key === "workflow" || key === "workflow task" || key === "work flow task") return "Workflow Task";
    if (key === "general" || key === "general task") return "General Task";
    return "";
}

/** System Task and Workflow Task. A stored General Task stays a general task. */
export function isSystemOrWorkflowTask(task, category = "") {
    const stored = taskTypeLabel(task?.taskType);
    if (stored === "General Task") return false;
    if (stored === "System Task" || stored === "Workflow Task") return true;
    const fromCategory = taskTypeLabel(category);
    return fromCategory === "System Task" || fromCategory === "Workflow Task";
}

/**
 * Admin super user reject on a system or workflow task is final.
 * The status becomes Rejected and does not wait for the assignee to approve.
 */
export function superUserRejectsImmediately(task, viewer, category = "") {
    return Boolean(viewer?.superUser) && isSystemOrWorkflowTask(task, category);
}
