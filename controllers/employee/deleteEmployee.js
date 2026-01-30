import { deleteEmployeeData, getCompleteEmployee } from "../../services/employeeService.js";
import User from "../../models/User.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";

// Delete employee
export const deleteEmployee = async (req, res) => {
    try {
        const { id } = req.params;

        // Get employeeId from employee record
        const employee = await getCompleteEmployee(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;
        const mongoId = employee._id;

        // Dependency Checks
        const [
            linkedUser,
            reportees,
            fineRecords,
            rewardRecords,
            loanRecords
        ] = await Promise.all([
            User.findOne({ $or: [{ employeeId: employeeId }, { email: employee.email }] }),
            EmployeeBasic.countDocuments({
                $or: [
                    { reportingAuthority: mongoId },
                    { primaryReportee: mongoId },
                    { secondaryReportee: mongoId }
                ]
            }),
            import("../../models/Fine.js").then(m => m.default.countDocuments({
                $or: [{ employeeId: employeeId }, { employeeId: mongoId }]
            })),
            import("../../models/Reward.js").then(m => m.default.countDocuments({
                $or: [{ employeeId: employeeId }, { employeeId: mongoId }]
            })),
            import("../../models/Loan.js").then(m => m.default.countDocuments({
                $or: [{ employeeId: employeeId }, { employeeId: mongoId }]
            }))
        ]);

        if (linkedUser) {
            return res.status(400).json({
                message: "Cannot delete employee. This profile is linked to an active user account. Delete the user account first."
            });
        }

        if (reportees > 0) {
            return res.status(400).json({
                message: `Cannot delete employee. This employee is assigned as a manager or reportee for ${reportees} other employees. Reassign these relationships before deleting.`
            });
        }

        const totalFinancialRecords = fineRecords + rewardRecords + loanRecords;
        if (totalFinancialRecords > 0) {
            return res.status(400).json({
                message: `Cannot delete employee. This profile has ${totalFinancialRecords} associated financial records (Fines, Rewards, or Loans). Delete or archive these records first.`
            });
        }

        // Delete from all collections
        await deleteEmployeeData(employeeId);

        return res.status(200).json({
            message: "Employee deleted successfully",
        });
    } catch (error) {
        console.error('Error deleting employee:', error);
        return res.status(500).json({ message: error.message || 'Internal server error' });
    }
};



