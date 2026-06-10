import EmployeeEmiratesId from "../../models/EmployeeEmiratesId.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import { denyEmployeeCardDeleteUnlessAllowed } from "../../utils/employeeCardDeleteAccess.js";
import { disposeEmployeeProfileAttachment } from "../../utils/profileAttachmentDisposition.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { cleanupEmployeeExpiryNotificationsByLabels } from "../../utils/cleanupEmployeeExpiryNotifications.js";
import { PURGE_TYPES, purgeEmployeeOldDocuments } from "../../utils/purgeEmployeeOldDocuments.js";

export const deleteEmiratesIdDetails = async (req, res) => {
    const { id } = req.params;
    try {
        const employee = await resolveEmployeeId(id);
        if (!employee) return res.status(404).json({ message: "Employee not found." });

        const employeeBasic = await EmployeeBasic.findOne({ employeeId: employee.employeeId })
            .select("profileStatus profileApprovalStatus")
            .lean();
        const denied = await denyEmployeeCardDeleteUnlessAllowed(req, employeeBasic, "Emirates ID details");
        if (denied) return res.status(denied.status).json(denied.body);

        const card = await EmployeeEmiratesId.findOne({ employeeId: employee.employeeId }).lean();
        if (card?.emiratesId?.document) {
            await disposeEmployeeProfileAttachment(req, {
                employeeBasic,
                attachment: card.emiratesId.document,
                archive: {
                    moduleName: "Employee Emirates ID",
                    recordId: employee.employeeId,
                    details: `Emirates ID for ${employee.employeeId}`,
                    deletedPayload: { employeeId: employee.employeeId, emiratesId: card },
                },
            });
        }

        await EmployeeEmiratesId.deleteOne({ employeeId: employee.employeeId });
        await purgeEmployeeOldDocuments(employee.employeeId, {
            types: PURGE_TYPES.emirates,
            purgeDeletedArchiveReason: true,
        });
        await cleanupEmployeeExpiryNotificationsByLabels({
            employeeObjectId: employee._id,
            labels: ["Emirates ID"],
        });
        await triggerProfileReactivationIfNeeded({
            employeeId: employee.employeeId,
            actor: req.user,
            reason: "Emirates ID details deleted",
        });

        return res.status(200).json({ message: "Emirates ID details deleted successfully." });
    } catch (error) {
        console.error("Failed to delete Emirates ID details:", error);
        return res.status(500).json({ message: "Failed to delete Emirates ID details.", error: error.message });
    }
};
