// getDepartmentHOD.js
import EmployeeBasic from "../models/EmployeeBasic.js";
import Company from "../models/Company.js"; // Import at top level

/**
 * Retrieves the HOD (Head of Department) from Company Responsibilities ONLY.
 * @param {string} departmentType The department type ('hr', 'accounts', 'finance').
 * @param {string} identifier  Optional: The companyId (String ID) or employee's ObjectId/String ID to find their company.
 * @returns {Promise<Object|null>} The HOD employee object or null if not found.
 */
export const getDepartmentHOD = async (departmentType, identifier = null) => {
    try {
        const type = departmentType.toLowerCase();
        let category = type;
        if (type === 'hr' || type === 'human resource' || type === 'human resources') {
            category = 'hr';
        } else if (type === 'finance' || type === 'accounts' || type === 'accounting') {
            category = 'accounts';
        }

        let targetCompanyId = null;

        // 1. Resolve Company ID
        if (identifier) {
            // Check if identifier is a Company ID format (e.g. EST-...) 
            // OR checks if it's an employee ID (String or ObjectId)

            // Try as Company ID first
            const directCompany = await Company.findOne({ companyId: identifier });
            if (directCompany) {
                targetCompanyId = directCompany._id;
            } else {
                // Try as Employee
                // Can be ObjectId or String ID
                let empQuery = {};
                const idStr = String(identifier);

                if (idStr.match(/^[0-9a-fA-F]{24}$/)) {
                    empQuery = { _id: identifier };
                } else {
                    empQuery = { employeeId: identifier };
                }

                const emp = await EmployeeBasic.findOne(empQuery).select('company');
                if (emp && emp.company) {
                    targetCompanyId = emp.company;
                } else if (emp && !emp.company) {
                    console.warn(`[getDepartmentHOD] Employee ${identifier} belongs to NO company. Strict check failed.`);
                    return null; // "no company no request allowed"
                }
            }
        }

        // If no identifier provided, fallbacks? User implies strictness. 
        // But for backward compat or if called without ID in some legacy path, 
        // we might defaulting to finding *any* company? 
        // User request: "check the emp have no comopany no request allowed". 
        // So we strictly need a company context.

        // If no identifier provided or no company linked, return null (Strict Mode)
        if (!targetCompanyId) {
            return null;
        }

        // 2. Fetch Company Responsibilities
        const company = await Company.findById(targetCompanyId);
        if (!company) return null;

        // 3. Find Responsibility
        // Responsibilities array: { category: 'hr', empObjectId: ... }
        const responsibility = company.responsibilities?.find(r => r.category && r.category.toLowerCase() === category);

        if (responsibility && responsibility.empObjectId) {
            const delegatedEmp = await EmployeeBasic.findById(responsibility.empObjectId)
                .select('employeeId firstName lastName companyEmail email designation department profileStatus');

            if (delegatedEmp) {
                return delegatedEmp;
            }
        }

        // If we fall through here, it means company exists but no responsibility is set for this category.
        // User said: "if no responsibilities show the unknown in red color" -> Returning null achieves this (handled by frontend).
        // User also said: "not checking the designation" -> So we DO NOT search by role anymore.

        console.warn(`[getDepartmentHOD] No responsibility defined for ${category} in company ${company.name} (${company.companyId})`);
        return null;

    } catch (error) {
        console.error(`[getDepartmentHOD] Error finding HOD for ${departmentType}:`, error);
        return null;
    }
};
