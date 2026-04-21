import EmployeeDrivingLicense from "../../models/EmployeeDrivingLicense.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";

export const deleteDrivingLicenseDetails = async (req, res) => {
    const { id } = req.params;
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) return res.status(403).json({ message: "Only administrator can delete Driving License details." });

        const employee = await resolveEmployeeId(id);
        if (!employee) return res.status(404).json({ message: "Employee not found." });

        await EmployeeDrivingLicense.deleteOne({ employeeId: employee.employeeId });
        await triggerProfileReactivationIfNeeded({
            employeeId: employee.employeeId,
            actor: req.user,
            reason: "Driving License details deleted",
        });

        return res.status(200).json({ message: "Driving License details deleted successfully." });
    } catch (error) {
        console.error("Failed to delete Driving License details:", error);
        return res.status(500).json({ message: "Failed to delete Driving License details.", error: error.message });
    }
};
