function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Mail for the assignee when an admin super user deletes their task.
 * The task is already gone, so this message has no open link.
 */
export function adminDeletedTaskEmail({
    assigneeName = "",
    taskName = "",
    taskNumber = "",
    description = "",
    actorName = "",
} = {}) {
    const name = String(taskName || "").trim() || "Task";
    const number = String(taskNumber || "").trim();
    const hello = String(assigneeName || "").trim() || "there";
    const actor = String(actorName || "").trim();
    const detail = String(description || "").trim();
    const subject = number ? `Task deleted: ${number} — ${name}` : `Task deleted: ${name}`;
    const note = detail && detail !== name
        ? `<p>${escapeHtml(detail).replace(/\n/g, "<br>")}</p>`
        : "";
    const html = `
        <p>Hello ${escapeHtml(hello)},</p>
        <p>Admin deleted this task. You no longer need to work on it.</p>
        <p><strong>${escapeHtml(name)}</strong></p>
        ${number ? `<p><strong>Task number:</strong> ${escapeHtml(number)}</p>` : ""}
        ${note}
        ${actor ? `<p><strong>Deleted by:</strong> ${escapeHtml(actor)}</p>` : ""}
    `;
    return { subject, html };
}
