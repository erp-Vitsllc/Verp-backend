import EmployeeLabourCard from "../../models/EmployeeLabourCard.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { cleanupEmployeeExpiryNotificationsByLabels } from "../../utils/cleanupEmployeeExpiryNotifications.js";
import { PURGE_TYPES, purgeEmployeeOldDocuments } from "../../utils/purgeEmployeeOldDocuments.js";

export const deleteLabourCardDetails = async (req, res) => {
    const { id } = req.params;
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) return res.status(403).json({ message: "Only administrator can delete Labour Card details." });

        const employee = await resolveEmployeeId(id);
        if (!employee) return res.status(404).json({ message: "Employee not found." });

        const card = await EmployeeLabourCard.findOne({ employeeId: employee.employeeId }).lean();
        await awaitAdminDeletionArchive(req, {
            moduleName: "Employee Labour Card",
            recordId: employee.employeeId,
            details: `Labour Card for ${employee.employeeId}`,
            deletedPayload: { employeeId: employee.employeeId, labourCard: card },
        });
        await EmployeeLabourCard.deleteOne({ employeeId: employee.employeeId });
        await purgeEmployeeOldDocuments(employee.employeeId, {
            types: PURGE_TYPES.labourCard,
            purgeDeletedArchiveReason: true,
        });
        await cleanupEmployeeExpiryNotificationsByLabels({
            employeeObjectId: employee._id,
            labels: ["Labour Card"],
        });
        await triggerProfileReactivationIfNeeded({
            employeeId: employee.employeeId,
            actor: req.user,
            reason: "Labour Card details deleted",
        });

        return res.status(200).json({ message: "Labour Card details deleted successfully." });
    } catch (error) {
        console.error("Failed to delete Labour Card details:", error);
        return res.status(500).json({ message: "Failed to delete Labour Card details.", error: error.message });
    }
};
