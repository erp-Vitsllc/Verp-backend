import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { sendProfileNotification } from "../../utils/sendProfileNotification.js";

export const approveProfile = async (req, res) => {
    const { id } = req.params;

    try {
        // Get employeeId from employee record
        const employee = await getCompleteEmployee(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;

        // Update EmployeeBasic
        const updated = await EmployeeBasic.findOneAndUpdate(
            { employeeId },
            {
                profileApprovalStatus: "active",
                profileStatus: "active",
                // WORKFLOW: Update to Active
                $set: {
                    "profileWorkflow.$[elem].status": "active",
                    "profileWorkflow.$[elem].actionedAt": new Date()
                }
            },
            {
                new: true,
                arrayFilters: [{ "elem.status": "submitted" }] // Update only the submitted entry
            }
        );

        if (!updated) {
            return res.status(404).json({ message: "Employee not found" });
        }

        // === SYNC DASHBOARD ACTION ===
        try {
            const { syncDashboardAction } = await import("../../utils/syncDashboard.js");
            await syncDashboardAction({
                requestId: updated._id,
                requestType: 'Profile Activation',
                status: 'Approved',
                subjectEmployee: updated,
                requestedByName: req.user.name
            });
        } catch (syncErr) {
            console.error("[ApproveProfile] Dashboard Sync Error:", syncErr);
        }

        // Get complete employee data for response
        const completeEmployee = await getCompleteEmployee(employeeId);

        // Trigger Email Notification (Background)
        const manager = req.user; // The person who approved
        sendProfileNotification({
            employee: completeEmployee,
            manager: manager,
            status: 'active'
        }).catch(err => console.error("Async Email Error:", err));

        delete completeEmployee.password;

        return res.status(200).json({
            message: "Employee profile marked as approved.",
            employee: completeEmployee
        });
    } catch (error) {
        console.error("Failed to approve profile:", error);
        return res.status(500).json({ message: error.message || "Failed to approve profile." });
    }
};


