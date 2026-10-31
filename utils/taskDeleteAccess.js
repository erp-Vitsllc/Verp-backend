function baseName(value) {
    return String(value || "")
        .trim()
        .replace(/\s*\([^)]*\)\s*$/, "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}

function employeeCode(value) {
    const match = String(value || "").match(/\(([^)]+)\)\s*$/);
    return match ? String(match[1] || "").trim().toLowerCase() : "";
}

function categoryKey(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Admin delete is for a system task or a workflow task. */
function adminMayDeleteCategory(taskCategory) {
    const category = categoryKey(taskCategory);
    return category === "system task" || category === "workflow task" || category === "work flow task";
}

/** The requester can delete a general task, a system task, or a workflow task. */
export function requesterMayDeleteCategory(taskCategory) {
    const category = categoryKey(taskCategory);
    return category === "general task" || adminMayDeleteCategory(taskCategory);
}

function viewerIsRequester(viewer, requestedByName, requestedByUserId) {
    if (
        requestedByUserId
        && viewer?.userId
        && String(requestedByUserId) === String(viewer.userId)
    ) {
        return true;
    }
    const code = employeeCode(requestedByName);
    if (
        code
        && viewer?.employeeId
        && code === String(viewer.employeeId).trim().toLowerCase()
    ) {
        return true;
    }
    const owner = baseName(requestedByName);
    if (!owner || owner === "system") return false;
    return owner === baseName(viewer?.name);
}

/** Completed and closed tasks stay on the list, and only an admin can remove them. */
export function statusAllowsOnlyAdminDelete(status) {
    const value = String(status || "").trim().toLowerCase();
    return value === "completed" || value === "closed";
}

/**
 * A completed or closed task of any type can be deleted only by an admin super user.
 * An open system or workflow task can be deleted by an admin super user.
 * The requester can delete an open General Task, System Task, or Workflow Task.
 */
export function viewerMayDeleteTask(viewer, {
    taskCategory = "",
    requestedByName = "",
    requestedByUserId = "",
    closed = false,
    finished = false,
    status = "",
} = {}) {
    if (finished || statusAllowsOnlyAdminDelete(status)) return Boolean(viewer?.superUser);
    if (closed) return false;
    if (viewer?.superUser && adminMayDeleteCategory(taskCategory)) return true;
    if (!requesterMayDeleteCategory(taskCategory)) return false;
    return viewerIsRequester(viewer, requestedByName, requestedByUserId);
}

/** The task list shows this row as Completed or Closed. */
export function recordIsFinishedForDelete(task, action) {
    const taskStatus = String(task?.status || "");
    const actionStatus = String(action?.status || "");
    if (taskStatus === "Rejected" || taskStatus === "Cancelled") return false;
    if (actionStatus === "Rejected" || actionStatus === "Dismissed" || actionStatus === "Cancelled") return false;
    const saved = task?.closeRequest || {};
    if (saved.reviewPending) return false;
    if (taskStatus === "Completed") return true;
    if (saved.closedAt) return true;
    if (taskStatus === "In Progress") return false;
    if (taskStatus === "Pending" && saved.reopenedAt) return false;
    return actionStatus === "Approved" || actionStatus === "Completed";
}
