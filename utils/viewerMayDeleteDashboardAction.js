/**
 * Whether the logged-in user may delete a DashboardAction row (assignee, matching emp id, or admin).
 */
export const viewerMayDeleteDashboardAction = (currentUser, manager, action) => {
    if (!currentUser || !action) return false;

    const isAdmin =
        ["Admin", "CEO", "Director", "General Manager"].includes(currentUser.role) ||
        currentUser.isAdmin;
    if (isAdmin) return true;

    const relevantIds = [currentUser.employeeObjectId, manager?._id, currentUser._id].filter(Boolean);

    const assigneeMatches = relevantIds.some(
        (id) => id && action.assignedTo && id.toString() === action.assignedTo.toString(),
    );

    const norm = (s) => (s || "").toString().trim().toLowerCase();
    const empIdMatches =
        (norm(currentUser.employeeId) && norm(action.assignedToEmpId) === norm(currentUser.employeeId)) ||
        (manager?.employeeId && norm(action.assignedToEmpId) === norm(manager.employeeId));

    return assigneeMatches || empIdMatches;
};
