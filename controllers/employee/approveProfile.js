import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";

export const approveProfile = async (req, res) => {
    const { id } = req.params;

    try {
        // Get employeeId from employee record
        const employee = await getCompleteEmployee(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;

        // Update EmployeeBasic
        const updated = await EmployeeBasic.findOneAndUpdate(
            { employeeId },
            {
                profileApprovalStatus: "active",
                profileStatus: "active",
                // WORKFLOW: Update to Active
                $set: {
                    "profileWorkflow.$[elem].status": "active",
                    "profileWorkflow.$[elem].actionedAt": new Date()
                }
            },
            {
                new: true,
                arrayFilters: [{ "elem.status": "submitted" }] // Update only the submitted entry
            }
        );

        if (!updated) {
            return res.status(404).json({ message: "Employee not found" });
        }

        // Get complete employee data for response
        const completeEmployee = await getCompleteEmployee(employeeId);
        delete completeEmployee.password;

        return res.status(200).json({
            message: "Employee profile marked as approved.",
            employee: completeEmployee
        });
    } catch (error) {
        console.error("Failed to approve profile:", error);
        return res.status(500).json({ message: error.message || "Failed to approve profile." });
    }
};


