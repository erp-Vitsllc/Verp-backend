import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { isRequestUserDesignatedFlowchartHr } from "../../utils/isDesignatedFlowchartHr.js";
import { clearProfileHrSubmitReminders } from "../../utils/notifyProfileHrSubmitReminder.js";

const isLeftUserChange = (entry) =>
    String(entry?.section || "").toLowerCase() === "workdetails" &&
    String(entry?.proposedData?.status || "").trim() === "Left User";

/**
 * Non-HR editor drops queued profile edits before they are sent to HR.
 * Live cards are already the approved values, so the queue is removed and nothing new is kept.
 */
export const cancelEmployeePendingEdits = async (req, res) => {
    try {
        const { id } = req.params;
        if (await isRequestUserDesignatedFlowchartHr(req)) {
            return res.status(403).json({
                message: "HR applies profile edits directly. There is no queued submit to cancel.",
            });
        }

        const employee = await getCompleteEmployee(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found." });
        }

        const approval = String(employee.profileApprovalStatus || "").toLowerCase();
        if (approval === "submitted") {
            return res.status(400).json({
                message: "These edits are already with HR. Cancel submit is available before you send them.",
            });
        }

        const basicDoc = await EmployeeBasic.findOne({ employeeId: employee.employeeId });
        if (!basicDoc) {
            return res.status(404).json({ message: "Employee not found." });
        }

        const pending = Array.isArray(basicDoc.pendingReactivationChanges)
            ? basicDoc.pendingReactivationChanges
            : [];
        const kept = pending.filter((entry) => isLeftUserChange(entry));
        const dropped = pending.length - kept.length;
        if (dropped === 0) {
            return res.status(400).json({ message: "There are no pending edits to cancel." });
        }

        basicDoc.pendingReactivationChanges = kept;
        basicDoc.markModified("pendingReactivationChanges");
        basicDoc.profileActivationDraftEditor = undefined;
        await basicDoc.save();

        await clearProfileHrSubmitReminders(basicDoc._id);

        const fresh = await getCompleteEmployee(employee.employeeId);
        if (fresh) delete fresh.password;

        return res.status(200).json({
            message: "Pending edits cancelled. The profile stays on the current approved data.",
            employee: fresh,
        });
    } catch (error) {
        console.error("cancelEmployeePendingEdits:", error);
        return res.status(500).json({
            message: error.message || "Failed to cancel pending edits.",
        });
    }
};
