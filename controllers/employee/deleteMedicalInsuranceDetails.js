import EmployeeMedicalInsurance from "../../models/EmployeeMedicalInsurance.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";
import { cleanupEmployeeExpiryNotificationsByLabels } from "../../utils/cleanupEmployeeExpiryNotifications.js";
import { PURGE_TYPES, purgeEmployeeOldDocuments } from "../../utils/purgeEmployeeOldDocuments.js";

export const deleteMedicalInsuranceDetails = async (req, res) => {
    const { id } = req.params;
    try {
        const employee = await resolveEmployeeId(id);
        if (!employee) return res.status(404).json({ message: "Employee not found." });

        const employeeBasic = await EmployeeBasic.findOne({ employeeId: employee.employeeId })
            .select("profileStatus")
            .lean();
        const isProfileActive = String(employeeBasic?.profileStatus || "").toLowerCase() === "active";
        const isAdmin = await isReqUserAdmin(req.user);

        if (isProfileActive && !isAdmin) {
            return res.status(403).json({
                message: "Only administrator can delete Medical Insurance details on an active profile.",
            });
        }

        const card = await EmployeeMedicalInsurance.findOne({ employeeId: employee.employeeId }).lean();
        if (isProfileActive) {
            await awaitAdminDeletionArchive(req, {
                moduleName: "Employee Medical Insurance",
                recordId: employee.employeeId,
                details: `Medical insurance for ${employee.employeeId}`,
                deletedPayload: { employeeId: employee.employeeId, medicalInsurance: card },
            });
        }

        await EmployeeMedicalInsurance.deleteOne({ employeeId: employee.employeeId });
        await purgeEmployeeOldDocuments(employee.employeeId, {
            types: PURGE_TYPES.medical,
            purgeDeletedArchiveReason: true,
        });
        await cleanupEmployeeExpiryNotificationsByLabels({
            employeeObjectId: employee._id,
            labels: ["Medical Insurance"],
        });

        return res.status(200).json({ message: "Medical Insurance details deleted successfully." });
    } catch (error) {
        console.error("Failed to delete Medical Insurance details:", error);
        return res.status(500).json({ message: "Failed to delete Medical Insurance details.", error: error.message });
    }
};
