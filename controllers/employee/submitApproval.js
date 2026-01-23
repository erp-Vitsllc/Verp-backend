import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";

export const submitApproval = async (req, res) => {
    const { id } = req.params;

    try {
        // Get employee basic record
        const employeeBasic = await getCompleteEmployee(id);
        if (!employeeBasic) {
            return res.status(404).json({ message: "Employee not found" });
        }

        // Strictly check for Primary Reportee
        if (!employeeBasic.primaryReportee) {
            return res.status(400).json({ message: "Please assign a primary reportee before submitting for approval." });
        }

        const employeeId = employeeBasic.employeeId;

        // Update EmployeeBasic
        const updated = await EmployeeBasic.findOneAndUpdate(
            { employeeId },
            {
                profileApprovalStatus: "submitted",
                profileSubmittedTo: employeeBasic.primaryReportee, // SNAPSHOT: Lock to current manager
                // WORKFLOW: Initial Submitted Step
                profileWorkflow: [{
                    role: 'Manager',
                    assignedTo: employeeBasic.primaryReportee,
                    status: 'submitted',
                    assignedAt: new Date()
                }]
            },
            { new: true }
        ).populate("primaryReportee", "firstName lastName email workEmail")
            .populate("reportingAuthority", "firstName lastName email workEmail");

        if (!updated) {
            return res.status(404).json({ message: "Employee not found" });
        }

        // Get complete employee data for response
        const completeEmployee = await getCompleteEmployee(employeeId);
        delete completeEmployee.password;

        return res.status(200).json({
            message: "Profile submitted for approval.",
            employee: completeEmployee
        });
    } catch (error) {
        console.error("Failed to submit profile for approval:", error);
        return res.status(500).json({ message: error.message || "Failed to submit profile." });
    }
};


