import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { sendProfileNotification } from "../../utils/sendProfileNotification.js";

export const rejectProfile = async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    if (!reason || reason.trim().length === 0) {
        return res.status(400).json({ message: "Reason for rejection is mandatory." });
    }

    try {
        // Get employee record
        const employee = await getCompleteEmployee(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;
        const submittedToAssigneeId = employee.profileSubmittedTo;

        // Update EmployeeBasic
        // Set profileApprovalStatus to 'rejected'
        // Update workflow entry to 'rejected'
        const updated = await EmployeeBasic.findOneAndUpdate(
            { employeeId },
            {
                profileApprovalStatus: "rejected",
                profileStatus: "inactive",
                $unset: { profileActivationHold: 1 },
                $set: {
                    "profileWorkflow.$[elem].status": "rejected",
                    "profileWorkflow.$[elem].actionedAt": new Date(),
                    "profileWorkflow.$[elem].comment": reason || "Profile activation request rejected."
                }
            },
            {
                new: true,
                arrayFilters: [{ "elem.status": "submitted" }] // Update only the submitted entry
            }
        );

        if (!updated) {
            return res.status(404).json({ message: "Employee submission not found" });
        }

        // === SYNC DASHBOARD ACTION ===
        try {
            const { syncDashboardAction } = await import("../../utils/syncDashboard.js");
            await syncDashboardAction({
                requestId: updated._id,
                requestType: "Profile Activation",
                status: "Rejected",
                assignedTo: submittedToAssigneeId ? String(submittedToAssigneeId) : undefined,
                subjectEmployee: updated,
                actionedBy: req.user?.employeeObjectId || req.user?._id,
                requestedByName: req.user?.name || "",
                comment: reason,
                notifySubjectEmployee: true
            });
        } catch (syncErr) {
            console.error("[RejectProfile] Dashboard Sync Error:", syncErr);
        }

        // Get complete employee data for response
        const completeEmployee = await getCompleteEmployee(employeeId);

        // Trigger Email Notification (Background)
        const manager = req.user; // The person who rejected
        sendProfileNotification({
            employee: completeEmployee,
            manager: manager,
            status: 'rejected',
            reason: reason || "Profile activation request rejected. Please review your details."
        }).catch(err => console.error("Async Email Error:", err));

        delete completeEmployee.password;

        return res.status(200).json({
            message: "Employee profile activation rejected.",
            employee: completeEmployee
        });
    } catch (error) {
        console.error("Failed to reject profile:", error);
        return res.status(500).json({ message: error.message || "Failed to reject profile." });
    }
};
