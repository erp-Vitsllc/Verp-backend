import EmployeeTraining from "../../models/EmployeeTraining.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";

export const deleteTraining = async (req, res) => {
    const { id, trainingId } = req.params;

    if (!trainingId) {
        return res.status(400).json({ message: "Training ID is required" });
    }

    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can delete training records." });
        }

        // Get employeeId from employee record
        const employee = await getCompleteEmployee(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;


        const trainingRecord = await EmployeeTraining.findOne({ employeeId });

        if (!trainingRecord) {
            return res.status(404).json({ message: "Training record not found" });
        }

        const training = trainingRecord.trainingDetails.id(trainingId);

        if (!training) {
            return res.status(404).json({ message: "Training record not found" });
        }

            training.deleteOne();
            await trainingRecord.save();
        
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.status(200).json({
            message: "Training record deleted successfully",
            trainingDetails: trainingRecord?.trainingDetails || completeEmployee?.trainingDetails,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};








