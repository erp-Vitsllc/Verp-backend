import mongoose from "mongoose";
import DashboardAction from "../../models/DashboardAction.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";

/**
 * Remove a single dashboard notification row (DashboardAction).
 * Allowed for the assignee (or matching employee id) and for top-level admins.
 */
export const deleteDashboardAction = async (req, res) => {
    try {
        const currentUser = req.user;
        if (!currentUser) return res.status(401).json({ message: "Unauthorized" });

        const { actionId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(actionId)) {
            return res.status(400).json({ message: "Invalid notification id" });
        }

        const action = await DashboardAction.findById(actionId).lean();
        if (!action) return res.status(404).json({ message: "Notification not found" });

        const isAdmin =
            ["Admin", "CEO", "Director", "General Manager"].includes(currentUser.role) ||
            currentUser.isAdmin;

        const manager = await EmployeeBasic.findOne({
            $or: [
                ...(currentUser.employeeObjectId ? [{ _id: currentUser.employeeObjectId }] : []),
                ...(currentUser.employeeId ? [{ employeeId: currentUser.employeeId }] : []),
            ],
        }).select("_id employeeId");

        const relevantIds = [currentUser.employeeObjectId, manager?._id, currentUser._id].filter(Boolean);

        const assigneeMatches = relevantIds.some(
            (id) => id && action.assignedTo && id.toString() === action.assignedTo.toString()
        );

        const norm = (s) => (s || "").toString().trim().toLowerCase();
        const empIdMatches =
            (norm(currentUser.employeeId) && norm(action.assignedToEmpId) === norm(currentUser.employeeId)) ||
            (manager?.employeeId && norm(action.assignedToEmpId) === norm(manager.employeeId));

        if (!isAdmin && !assigneeMatches && !empIdMatches) {
            return res.status(403).json({ message: "Not allowed to remove this notification" });
        }

        await DashboardAction.findByIdAndDelete(actionId);
        return res.status(200).json({ message: "Notification removed", ok: true });
    } catch (error) {
        console.error("[deleteDashboardAction]", error);
        return res.status(500).json({ message: "Failed to remove notification" });
    }
};
