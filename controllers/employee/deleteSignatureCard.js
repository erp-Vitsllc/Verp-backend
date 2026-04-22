import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { triggerProfileReactivationIfNeeded, shouldQueueProfileChange } from "../../utils/triggerProfileReactivation.js";

export const deleteSignatureCard = async (req, res) => {
    const { id } = req.params;
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can delete signature." });
        }

        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found." });
        }

        const employeeDoc = await EmployeeBasic.findOne({ employeeId: employee.employeeId }).select("signature profileStatus profileWorkflow").lean();
        const requiresApprovalQueue = shouldQueueProfileChange(employeeDoc);
        if (requiresApprovalQueue) {
            await triggerProfileReactivationIfNeeded({
                employeeId: employee.employeeId,
                actor: req.user,
                reason: "Signature card deleted",
                changeEntry: {
                    card: "Digital Signature",
                    reason: "Signature card deleted",
                    section: "signature",
                    changeType: "delete",
                    targetIndex: null,
                    previousData: employeeDoc?.signature || null,
                    proposedData: null,
                },
            });
        } else {
            await EmployeeBasic.updateOne(
                { employeeId: employee.employeeId },
                { $set: { signature: null } }
            );

            await triggerProfileReactivationIfNeeded({
                employeeId: employee.employeeId,
                actor: req.user,
                reason: "Signature card deleted",
            });
        }

        return res.status(200).json({
            message: requiresApprovalQueue
                ? "Signature deletion queued for HR activation approval."
                : "Signature deleted successfully."
        });
    } catch (error) {
        console.error("Failed to delete signature:", error);
        return res.status(500).json({ message: "Failed to delete signature.", error: error.message });
    }
};
