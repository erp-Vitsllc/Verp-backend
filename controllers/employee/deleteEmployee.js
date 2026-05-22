import { deleteEmployeeData, getCompleteEmployee } from "../../services/employeeService.js";
import User from "../../models/User.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import EmployeeContact from "../../models/EmployeeContact.js";
import EmployeePersonal from "../../models/EmployeePersonal.js";
import EmployeePassport from "../../models/EmployeePassport.js";
import EmployeeVisa from "../../models/EmployeeVisa.js";
import EmployeeEmiratesId from "../../models/EmployeeEmiratesId.js";
import EmployeeLabourCard from "../../models/EmployeeLabourCard.js";
import EmployeeMedicalInsurance from "../../models/EmployeeMedicalInsurance.js";
import EmployeeDrivingLicense from "../../models/EmployeeDrivingLicense.js";
import EmployeeSalary from "../../models/EmployeeSalary.js";
import EmployeeBank from "../../models/EmployeeBank.js";
import EmployeeEducation from "../../models/EmployeeEducation.js";
import EmployeeExperience from "../../models/EmployeeExperience.js";
import EmployeeEmergencyContact from "../../models/EmployeeEmergencyContact.js";
import EmployeeTraining from "../../models/EmployeeTraining.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";

// Delete employee
export const deleteEmployee = async (req, res) => {
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can delete employees." });
        }

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

        const { password, ...employeeSnapshot } = employee;
        const [
            basic,
            contact,
            personal,
            passport,
            visa,
            emiratesId,
            labourCard,
            medicalInsurance,
            drivingLicense,
            salary,
            bank,
            education,
            experience,
            emergencyContact,
            training,
        ] = await Promise.all([
            EmployeeBasic.findOne({ employeeId }).lean(),
            EmployeeContact.findOne({ employeeId }).lean(),
            EmployeePersonal.findOne({ employeeId }).lean(),
            EmployeePassport.findOne({ employeeId }).lean(),
            EmployeeVisa.findOne({ employeeId }).lean(),
            EmployeeEmiratesId.findOne({ employeeId }).lean(),
            EmployeeLabourCard.findOne({ employeeId }).lean(),
            EmployeeMedicalInsurance.findOne({ employeeId }).lean(),
            EmployeeDrivingLicense.findOne({ employeeId }).lean(),
            EmployeeSalary.findOne({ employeeId }).lean(),
            EmployeeBank.findOne({ employeeId }).lean(),
            EmployeeEducation.findOne({ employeeId }).lean(),
            EmployeeExperience.findOne({ employeeId }).lean(),
            EmployeeEmergencyContact.findOne({ employeeId }).lean(),
            EmployeeTraining.findOne({ employeeId }).lean(),
        ]);
        // Archive + copy attachments before Mongo rows are removed (async email ran too late before).
        await awaitAdminDeletionArchive(req, {
            moduleName: "Employee",
            recordId: employeeId,
            details: `${employee.firstName || ""} ${employee.lastName || ""}`.trim() || employeeId,
            deletedPayload: {
                complete: employeeSnapshot,
                collections: {
                    basic,
                    contact,
                    personal,
                    passport,
                    visa,
                    emiratesId,
                    labourCard,
                    medicalInsurance,
                    drivingLicense,
                    salary,
                    bank,
                    education,
                    experience,
                    emergencyContact,
                    training,
                },
            },
        });

        await deleteEmployeeData(employeeId);

        return res.status(200).json({
            message: "Employee deleted successfully",
        });
    } catch (error) {
        console.error('Error deleting employee:', error);
        return res.status(500).json({ message: error.message || 'Internal server error' });
    }
};



