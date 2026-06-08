import EmployeeDrivingLicense from "../../models/EmployeeDrivingLicense.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";
import { cleanupEmployeeExpiryNotificationsByLabels } from "../../utils/cleanupEmployeeExpiryNotifications.js";
import { PURGE_TYPES, purgeEmployeeOldDocuments } from "../../utils/purgeEmployeeOldDocuments.js";

export const deleteDrivingLicenseDetails = async (req, res) => {
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
                message: "Only administrator can delete Driving License details on an active profile.",
            });
        }

        const card = await EmployeeDrivingLicense.findOne({ employeeId: employee.employeeId }).lean();
        if (isProfileActive) {
            await awaitAdminDeletionArchive(req, {
                moduleName: "Employee Driving License",
                recordId: employee.employeeId,
                details: `Driving license for ${employee.employeeId}`,
                deletedPayload: { employeeId: employee.employeeId, drivingLicense: card },
            });
        }

        await EmployeeDrivingLicense.deleteOne({ employeeId: employee.employeeId });
        await purgeEmployeeOldDocuments(employee.employeeId, {
            types: PURGE_TYPES.driving,
            purgeDeletedArchiveReason: true,
        });
        await cleanupEmployeeExpiryNotificationsByLabels({
            employeeObjectId: employee._id,
            labels: ["Driving License"],
        });

        return res.status(200).json({ message: "Driving License details deleted successfully." });
    } catch (error) {
        console.error("Failed to delete Driving License details:", error);
        return res.status(500).json({ message: "Failed to delete Driving License details.", error: error.message });
    }
};
