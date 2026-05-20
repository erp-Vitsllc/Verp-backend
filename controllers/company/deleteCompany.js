import Company from "../../models/Company.js";
import Fine from "../../models/Fine.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import { deleteEmployeeData } from "../../services/employeeService.js";
import {
    isReqUserAdmin,
    scheduleManagementAdminDeletionEmail,
} from "../../utils/sendAdminDeletionNotificationEmails.js";

export const deleteCompany = async (req, res) => {
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can delete companies." });
        }

        const { id } = req.params;

        // Check if company exists
        const company = await Company.findById(id).lean();
        if (!company) {
            return res.status(404).json({ message: "Company not found" });
        }

        // Check for dependencies
        // Check if any fines are responsible for this company
        // Fines store responsibleFor: 'Company' but they don't explicitly store the company ObjectId 
        // because the current schema assumes a single-company setup mostly.
        // However, if we have multiple companies, we should check.
        // For now, since Fine doesn't have a company link, we'll just check if there are any files/records 
        // that might be affected.

        // Let's check if any Fines exist that mention this company name (if we want to be thorough)
        const fineCount = await Fine.countDocuments({
            $or: [
                { responsibleFor: 'Company' },
                { responsibleFor: 'Employee & Company' }
            ]
        });

        // NOTE: In a more complex multi-tenant system, we'd check for employees, departments, etc.
        // linked to this specific company ID.

        // Cascade delete employees mapped to this company so stale employee records
        // do not remain after company removal.
        const employeesInCompany = await EmployeeBasic.find({ company: company._id })
            .select("employeeId")
            .lean();
        const employeeIds = employeesInCompany
            .map((employee) => employee.employeeId)
            .filter(Boolean);

        if (employeeIds.length > 0) {
            await Promise.all(employeeIds.map((employeeId) => deleteEmployeeData(employeeId)));

            // Remove linked user accounts for deleted employees to avoid orphaned logins.
            await User.deleteMany({ employeeId: { $in: employeeIds } });
        }

        scheduleManagementAdminDeletionEmail(req, {
            moduleName: "Company",
            recordId: company.companyId || String(company._id),
            details: `${company.name || "Company"} (${employeeIds.length} linked employees removed)`,
            deletedPayload: company,
        });

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
