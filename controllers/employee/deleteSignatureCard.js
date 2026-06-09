import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";
import { denyEmployeeCardDeleteUnlessAllowed } from "../../utils/employeeCardDeleteAccess.js";
import { isActiveEmployeeProfile } from "../../utils/profileFileChangeHrNotify.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { PURGE_TYPES, purgeEmployeeOldDocuments } from "../../utils/purgeEmployeeOldDocuments.js";

export const deleteSignatureCard = async (req, res) => {
    const { id } = req.params;
    try {
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found." });
        }

        const sigEmployee = await EmployeeBasic.findOne({ employeeId: employee.employeeId })
            .select("employeeId signature profileStatus profileApprovalStatus")
            .lean();
        const denied = await denyEmployeeCardDeleteUnlessAllowed(req, sigEmployee, "signature");
        if (denied) return res.status(denied.status).json(denied.body);

        if (sigEmployee?.signature && isActiveEmployeeProfile(sigEmployee)) {
            await awaitAdminDeletionArchive(req, {
                moduleName: "Employee Signature",
                recordId: employee.employeeId,
                details: `Digital signature for ${employee.employeeId}`,
                deletedPayload: { employeeId: employee.employeeId, signature: sigEmployee.signature },
            });
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
