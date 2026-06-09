import EmployeeLabourCard from "../../models/EmployeeLabourCard.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";
import { denyEmployeeCardDeleteUnlessAllowed } from "../../utils/employeeCardDeleteAccess.js";
import { isActiveEmployeeProfile } from "../../utils/profileFileChangeHrNotify.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { cleanupEmployeeExpiryNotificationsByLabels } from "../../utils/cleanupEmployeeExpiryNotifications.js";
import { PURGE_TYPES, purgeEmployeeOldDocuments } from "../../utils/purgeEmployeeOldDocuments.js";

export const deleteLabourCardDetails = async (req, res) => {
    const { id } = req.params;
    try {
        const employee = await resolveEmployeeId(id);
        if (!employee) return res.status(404).json({ message: "Employee not found." });

        const employeeBasic = await EmployeeBasic.findOne({ employeeId: employee.employeeId })
            .select("profileStatus profileApprovalStatus")
            .lean();
        const denied = await denyEmployeeCardDeleteUnlessAllowed(req, employeeBasic, "Labour Card details");
        if (denied) return res.status(denied.status).json(denied.body);

        const card = await EmployeeLabourCard.findOne({ employeeId: employee.employeeId }).lean();
        if (isActiveEmployeeProfile(employeeBasic)) await awaitAdminDeletionArchive(req, {
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
