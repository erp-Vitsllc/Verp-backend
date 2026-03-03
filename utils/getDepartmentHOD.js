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

        // 2. Try Specific Company first
        if (targetCompanyId) {
            const company = await Company.findById(targetCompanyId);
            if (company) {
                const responsibility = company.responsibilities?.find(r => r.category && r.category.toLowerCase() === category);
                if (responsibility && responsibility.empObjectId) {
                    const delegatedEmp = await EmployeeBasic.findById(responsibility.empObjectId)
                        .select('employeeId firstName lastName companyEmail email designation department profileStatus');
                    if (delegatedEmp) return delegatedEmp;
                }
            }
        }

        // 3. Centralized Fallback: If not found in target company, look in ANY company
        // This handles cases where HR/Accounts are "same for all" but defined in a main company
        const anyCompanyWithCategory = await Company.findOne({
            "responsibilities.category": { $regex: new RegExp(`^${category}$`, 'i') }
        });

        if (anyCompanyWithCategory) {
            const responsibility = anyCompanyWithCategory.responsibilities.find(r => r.category && r.category.toLowerCase() === category);
            if (responsibility && responsibility.empObjectId) {
                const delegatedEmp = await EmployeeBasic.findById(responsibility.empObjectId)
                    .select('employeeId firstName lastName companyEmail email designation department profileStatus');
                if (delegatedEmp) {
                    console.log(`[getDepartmentHOD] Using Centralized ${category} HOD from company ${anyCompanyWithCategory.name}`);
                    return delegatedEmp;
                }
            }
        }

        console.warn(`[getDepartmentHOD] No responsibility defined for ${category} anywhere.`);
        return null;

    } catch (error) {
        console.error(`[getDepartmentHOD] Error finding HOD for ${departmentType}:`, error);
        return null;
    }
};

