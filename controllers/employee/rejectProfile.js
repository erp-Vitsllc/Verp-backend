import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { sendProfileNotification } from "../../utils/sendProfileNotification.js";
import { syncDashboardAction } from "../../utils/syncDashboard.js";

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
        const activationSubmitterId = employee.profileActivationSubmittedBy || null;

        // Update EmployeeBasic
        // Set profileApprovalStatus to 'rejected'
        // Update workflow entry to 'rejected'
        const updated = await EmployeeBasic.findOneAndUpdate(
            { employeeId },
            {
                profileApprovalStatus: "rejected",
                profileStatus: "inactive",
                $unset: { profileActivationHold: 1, profileActivationSubmittedBy: 1 },
                $set: {
                    pendingReactivationChanges: [],
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

        // Close every open dashboard row for this activation (HR Pending + submitter On Hold).
        try {
            const DashboardAction = (await import("../../models/DashboardAction.js")).default;
            await DashboardAction.updateMany(
                {
                    requestId: updated._id,
                    requestType: "Profile Activation",
                    status: { $in: ["Pending", "On Hold"] },
                },
                {
                    status: "Rejected",
                    actionedDate: new Date(),
                    actionedBy: req.user?.employeeObjectId || req.user?._id,
                    comment: reason || "",
                },
            );
        } catch (syncErr) {
            console.error("[RejectProfile] Dashboard Update Error:", syncErr);
        }

        const subjectLean = await EmployeeBasic.findOne({ employeeId })
            .select("_id employeeId firstName lastName designation companyEmail workEmail email personalEmail")
            .lean();

        const submitterForNotify = activationSubmitterId
            ? await EmployeeBasic.findById(activationSubmitterId)
                  .select("_id employeeId firstName lastName designation companyEmail workEmail email personalEmail primaryReportee")
                  .populate("primaryReportee", "firstName lastName companyEmail workEmail email")
                  .lean()
            : null;

        if (submitterForNotify?._id) {
            try {
                await syncDashboardAction({
                    requestId: updated._id,
                    requestType: "Profile Activation",
                    assignedTo: String(submitterForNotify._id),
                    status: "Rejected",
                    skipPendingCompletion: true,
                    subjectEmployee: subjectLean || updated,
                    profileActivationNotifyAssignee: submitterForNotify,
                    requestedByName: req.user?.name || "",
                    actionedBy: req.user?.employeeObjectId || req.user?._id,
                    comment: reason || "",
                });
            } catch (syncErr) {
                console.error("[RejectProfile] Dashboard Sync Error:", syncErr);
            }
        }

        // Get complete employee data for response
        const completeEmployee = await getCompleteEmployee(employeeId);
        const recipientForActivationEmail = submitterForNotify;

        // Trigger Email Notification (Background)
        const manager = req.user; // The person who rejected
        sendProfileNotification({
            employee: completeEmployee,
            recipientEmployee: recipientForActivationEmail,
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
