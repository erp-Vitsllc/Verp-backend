import mongoose from "mongoose";
import DashboardAction from "../../models/DashboardAction.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { viewerMayDeleteDashboardAction } from "../../utils/viewerMayDeleteDashboardAction.js";

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

        const manager = await EmployeeBasic.findOne({
            $or: [
                ...(currentUser.employeeObjectId ? [{ _id: currentUser.employeeObjectId }] : []),
                ...(currentUser.employeeId ? [{ employeeId: currentUser.employeeId }] : []),
            ],
        })
            .select("_id employeeId")
            .lean();

        if (!viewerMayDeleteDashboardAction(currentUser, manager, action)) {
            return res.status(403).json({ message: "Not allowed to remove this notification" });
        }

        await DashboardAction.findByIdAndDelete(actionId);
        return res.status(200).json({ message: "Notification removed", ok: true });
    } catch (error) {
        console.error("[deleteDashboardAction]", error);
        return res.status(500).json({ message: "Failed to remove notification" });
    }
};
