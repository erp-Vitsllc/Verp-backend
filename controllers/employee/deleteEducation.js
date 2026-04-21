import EmployeeEducation from "../../models/EmployeeEducation.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";

export const deleteEducation = async (req, res) => {
    const { id, educationId } = req.params;

    if (!educationId) {
        return res.status(400).json({ message: "Education ID is required" });
    }

    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can delete education records." });
        }

        // Get employeeId from employee record
        const employee = await getCompleteEmployee(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;

        const educationRecord = await EmployeeEducation.findOne({ employeeId });

        if (!educationRecord) {
            return res.status(404).json({ message: "Education record not found" });
        }

        const education = educationRecord.educationDetails.id(educationId);

        if (!education) {
            return res.status(404).json({ message: "Education record not found" });
        }

        education.deleteOne();
        await educationRecord.save();
        await triggerProfileReactivationIfNeeded({
            employeeId,
            actor: req.user,
            reason: "Education record deleted",
        });
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.status(200).json({
            message: "Education record deleted successfully",
            educationDetails: educationRecord.educationDetails,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};













