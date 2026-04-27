import EmployeeMedicalInsurance from "../../models/EmployeeMedicalInsurance.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";

export const deleteMedicalInsuranceDetails = async (req, res) => {
    const { id } = req.params;
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) return res.status(403).json({ message: "Only administrator can delete Medical Insurance details." });

        const employee = await resolveEmployeeId(id);
        if (!employee) return res.status(404).json({ message: "Employee not found." });

        await EmployeeMedicalInsurance.deleteOne({ employeeId: employee.employeeId });

        return res.status(200).json({ message: "Medical Insurance details deleted successfully." });
    } catch (error) {
        console.error("Failed to delete Medical Insurance details:", error);
        return res.status(500).json({ message: "Failed to delete Medical Insurance details.", error: error.message });
    }
};
