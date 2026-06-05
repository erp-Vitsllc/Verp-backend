import Company from "../../models/Company.js";
import Fine from "../../models/Fine.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import { deleteEmployeeData, getCompleteEmployee } from "../../services/employeeService.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";
import { hasPermission } from "../../services/permissionService.js";

// Import employee sub-collections for snapshotting
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

export const deleteCompany = async (req, res) => {
    try {
        const { id } = req.params;

        // Check if company exists
        const company = await Company.findById(id).lean();
        if (!company) {
            return res.status(404).json({ message: "Company not found" });
        }

        const isActivated = company.activationStatus === "active";
        const isAdmin = await isReqUserAdmin(req.user);

        if (isActivated) {
            if (!isAdmin) {
                return res.status(403).json({ message: "Only administrator can delete activated companies." });
            }
        } else {
            const uid = req.user?.id || req.user?._id;
            const hasDelPerm = uid ? await hasPermission(uid, 'hrm_company_list', 'delete') : false;
            if (!isAdmin && !hasDelPerm) {
                return res.status(403).json({ message: "You do not have permission to delete this company." });
            }
        }

        // Get linked employees
        const employeesInCompany = await EmployeeBasic.find({ company: company._id })
            .select("employeeId")
            .lean();
        const employeeIds = employeesInCompany
            .map((employee) => employee.employeeId)
            .filter(Boolean);

        if (isActivated) {
            // Activated: Archive company and employees before hard deletion.
            const completeEmployees = await Promise.all(
                employeeIds.map(async (empId) => {
                    const employee = await getCompleteEmployee(empId);
                    if (!employee) return null;
                    const { password, ...employeeSnapshot } = employee;
                    const [
                        basic, contact, personal, passport, visa, emiratesId,
                        labourCard, medicalInsurance, drivingLicense, salary,
                        bank, education, experience, emergencyContact, training
                    ] = await Promise.all([
                        EmployeeBasic.findOne({ employeeId: empId }).lean(),
                        EmployeeContact.findOne({ employeeId: empId }).lean(),
                        EmployeePersonal.findOne({ employeeId: empId }).lean(),
                        EmployeePassport.findOne({ employeeId: empId }).lean(),
                        EmployeeVisa.findOne({ employeeId: empId }).lean(),
                        EmployeeEmiratesId.findOne({ employeeId: empId }).lean(),
                        EmployeeLabourCard.findOne({ employeeId: empId }).lean(),
                        EmployeeMedicalInsurance.findOne({ employeeId: empId }).lean(),
                        EmployeeDrivingLicense.findOne({ employeeId: empId }).lean(),
                        EmployeeSalary.findOne({ employeeId: empId }).lean(),
                        EmployeeBank.findOne({ employeeId: empId }).lean(),
                        EmployeeEducation.findOne({ employeeId: empId }).lean(),
                        EmployeeExperience.findOne({ employeeId: empId }).lean(),
                        EmployeeEmergencyContact.findOne({ employeeId: empId }).lean(),
                        EmployeeTraining.findOne({ employeeId: empId }).lean(),
                    ]);
                    return {
                        complete: employeeSnapshot,
                        collections: {
                            basic, contact, personal, passport, visa, emiratesId,
                            labourCard, medicalInsurance, drivingLicense, salary,
                            bank, education, experience, emergencyContact, training
                        }
                    };
                })
            );

            await awaitAdminDeletionArchive(req, {
                moduleName: "Company",
                recordId: company.companyId || String(company._id),
                details: `${company.name || "Company"} (${employeeIds.length} linked employees removed)`,
                deletedPayload: {
                    ...company,
                    employees: completeEmployees.filter(Boolean)
                },
                restoreDescriptor: { type: "company_whole" }
            });
        }

        // Cascade delete employees mapped to this company
        if (employeeIds.length > 0) {
            await Promise.all(employeeIds.map((employeeId) => deleteEmployeeData(employeeId)));
            await User.deleteMany({ employeeId: { $in: employeeIds } });
        }

        await Company.findByIdAndDelete(id);

        return res.status(200).json({
            message: "Company deleted successfully",
            deletedEmployees: employeeIds.length
        });
    } catch (error) {
        console.error("Error in deleteCompany:", error);
        return res.status(500).json({ message: error.message || "Failed to delete company" });
    }
};

