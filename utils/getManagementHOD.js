import EmployeeBasic from "../models/EmployeeBasic.js";
import Company from "../models/Company.js"; // Import at top level

/**
 * Retrieves the CEO (Management HOD) for final approval.
 * Priority: Company Responsibilities > Department/Designation Search.
 * @param {string} identifier Optional: The companyId (String ID) or employee's ObjectId/String ID to find their company.
 * @returns {Promise<Object|null>} The CEO employee object or null if not found.
 */
export const getManagementHOD = async (identifier = null) => {
    try {
        let targetCompanyId = null;

        // 1. Resolve Company ID (Similar to getDepartmentHOD)
        if (identifier) {
            const directCompany = await Company.findOne({ companyId: identifier });
            if (directCompany) {
                targetCompanyId = directCompany._id;
            } else {
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
                }
            }
        }

        // Strict Mode: No company context = No Management HOD found
        if (!targetCompanyId) {
            return null;
        }

        // 2. Try Company Responsibilities First
        if (targetCompanyId) {
            const company = await Company.findById(targetCompanyId);
            if (company) {
                // Check for 'management' or 'ceo' category in responsibilities
                const responsibility = company.responsibilities?.find(r =>
                    r.category && (r.category.toLowerCase() === 'management' || r.category.toLowerCase() === 'ceo')
                );

                if (responsibility && responsibility.empObjectId) {
                    const delegatedEmp = await EmployeeBasic.findById(responsibility.empObjectId)
                        .select('employeeId firstName lastName companyEmail email designation department profileStatus');

                    if (delegatedEmp) {
                        console.log(`[getManagementHOD] Found delegated CEO from Company Responsibilities: ${delegatedEmp.firstName}`);
                        return delegatedEmp;
                    }
                } else if (responsibility && responsibility.employeeId) {
                    const delegatedEmp = await EmployeeBasic.findOne({ employeeId: responsibility.employeeId })
                        .select('employeeId firstName lastName companyEmail email designation department profileStatus');
                    if (delegatedEmp) {
                        console.log(`[getManagementHOD] Found delegated CEO from Company Responsibilities (ID): ${delegatedEmp.firstName}`);
                        return delegatedEmp;
                    }
                }
            }
        }

        console.warn('[getManagementHOD] No CEO found via Company Responsibilities.');
        return null;

    } catch (error) {
        console.error('[getManagementHOD] Error finding CEO:', error);
        return null;
    }
};
