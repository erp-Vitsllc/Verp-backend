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

/** Admin delete is only for a system task or a workflow task. */
function adminMayDeleteCategory(taskCategory) {
    const category = categoryKey(taskCategory);
    return category === "system task" || category === "workflow task" || category === "work flow task";
}

/**
 * Admin super user can delete an open System Task or Workflow Task.
 * The requester can delete only a General Task.
 */
export function viewerMayDeleteTask(viewer, {
    taskCategory = "",
    requestedByName = "",
    requestedByUserId = "",
    closed = false,
} = {}) {
    if (closed) return false;
    if (viewer?.superUser) return adminMayDeleteCategory(taskCategory);
    const category = categoryKey(taskCategory);
    if (category !== "general task") return false;
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
