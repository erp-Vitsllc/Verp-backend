import mongoose from "mongoose";
import DashboardAction from "../../models/DashboardAction.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { viewerMayDeleteDashboardAction } from "../../utils/viewerMayDeleteDashboardAction.js";

export const deleteCompanyActivationDashboardByRequest = async (req, res) => {
    try {
        const currentUser = req.user;
        if (!currentUser) return res.status(401).json({ message: "Unauthorized" });

        const { requestId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(requestId)) {
            return res.status(400).json({ message: "Invalid request id" });
        }

        const manager = await EmployeeBasic.findOne({
            $or: [
                ...(currentUser.employeeObjectId ? [{ _id: currentUser.employeeObjectId }] : []),
                ...(currentUser.employeeId ? [{ employeeId: currentUser.employeeId }] : []),
            ],
        })
            .select("_id employeeId")
            .lean();

        const actions = await DashboardAction.find({
            requestId,
            requestType: "Company Activation",
            status: { $in: ["Pending", "On Hold"] },
        }).lean();

        let deleted = 0;
        for (const action of actions) {
            if (viewerMayDeleteDashboardAction(currentUser, manager, action)) {
                await DashboardAction.findByIdAndDelete(action._id);
                deleted += 1;
            }
        }

        if (deleted === 0) {
            return res.status(403).json({
                message: "Not allowed to remove these notifications, or none exist for this request.",
                deleted: 0,
            });
        }

        return res.status(200).json({ message: "Notification(s) removed", ok: true, deleted });
    } catch (error) {
        console.error("[deleteCompanyActivationDashboardByRequest]", error);
        return res.status(500).json({ message: "Failed to remove notifications" });
    }
};
