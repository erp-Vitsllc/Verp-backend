import EmployeeTraining from "../../models/EmployeeTraining.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee, resolveEmployeeId } from "../../services/employeeService.js";


export const addTraining = async (req, res) => {
    const { id } = req.params;
    const { trainingName, trainingDetails, provider, trainingDate, trainingCost, trainingCertificate } = req.body;

    // Validate required fields and types
    if (typeof trainingName !== 'string' || !trainingName.trim() ||
        typeof provider !== 'string' || !provider.trim() ||
        !trainingDate) {
        return res.status(400).json({
            message: "Training Name and Provider must be valid strings, and Training Date is required"
        });
    }

    // Validate date
    const parsedTrainingDate = new Date(trainingDate);
    if (isNaN(parsedTrainingDate.getTime())) {
        return res.status(400).json({ message: "Invalid training date provided" });
    }

    try {
        // Get employeeId from employee record using optimized resolver
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;


        const trainingData = {
            trainingName: trainingName.trim(),
            trainingDetails: trainingDetails ? trainingDetails.trim() : undefined,
            provider: provider.trim(),
            trainingDate: parsedTrainingDate,
            trainingCost: trainingCost !== undefined && trainingCost !== null && trainingCost !== '' ? Number(trainingCost) : undefined,
            trainingCertificate: trainingCertificate && trainingCertificate.data ? {
                data: trainingCertificate.data,
                name: trainingCertificate.name || '',
                mimeType: trainingCertificate.mimeType || 'application/pdf'
            } : undefined
        };

        let updated = null;
            // Update or create training record
            updated = await EmployeeTraining.findOneAndUpdate(
                { employeeId },
                {
                    $push: {
                        trainingDetails: trainingData
                    }
                },
                { upsert: true, new: true, runValidators: true }
            );

            if (!updated) {
                return res.status(404).json({ message: "Employee not found" });
            }
        
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.status(200).json({
            message: "Training details added successfully",
            trainingDetails: updated?.trainingDetails || completeEmployee?.trainingDetails,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};








