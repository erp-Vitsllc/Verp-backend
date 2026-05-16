import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { PURGE_TYPES, purgeEmployeeOldDocuments } from "../../utils/purgeEmployeeOldDocuments.js";

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

        await EmployeeBasic.updateOne(
            { employeeId: employee.employeeId },
            { $set: { signature: null } }
        );
        await purgeEmployeeOldDocuments(employee.employeeId, {
            types: PURGE_TYPES.signature,
            purgeDeletedArchiveReason: true,
        });

        await triggerProfileReactivationIfNeeded({
            employeeId: employee.employeeId,
            actor: req.user,
            reason: "Signature card deleted",
        });

        return res.status(200).json({
            message: "Signature deleted successfully."
        });
    } catch (error) {
        console.error("Failed to delete signature:", error);
        return res.status(500).json({ message: "Failed to delete signature.", error: error.message });
    }
};
