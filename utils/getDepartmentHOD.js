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
            const idStr = String(identifier);
            if (idStr.match(/^[0-9a-fA-F]{24}$/)) {
                // Could be Company _id or Employee _id
                const directComp = await Company.findById(identifier).select('_id');
                if (directComp) {
                    targetCompanyId = directComp._id;
                } else {
                    const emp = await EmployeeBasic.findById(identifier).select('company');
                    if (emp && emp.company) targetCompanyId = emp.company;
                }
            } else {
                // Try companyId (e.g. EST-001)
                const comp = await Company.findOne({ companyId: identifier }).select('_id');
                if (comp) {
                    targetCompanyId = comp._id;
                } else {
                    const emp = await EmployeeBasic.findOne({ employeeId: identifier }).select('company');
                    if (emp && emp.company) targetCompanyId = emp.company;
                }
            }
        }

        // 2. Try Specific Company first
        if (targetCompanyId) {
            const company = await Company.findById(targetCompanyId);
            if (company) {
                const responsibility = company.responsibilities?.find(r =>
                    r.category && r.category.toLowerCase() === category && r.status === 'Active'
                );
                if (responsibility && responsibility.empObjectId) {
                    const delegatedEmp = await EmployeeBasic.findById(responsibility.empObjectId)
                        .select('employeeId firstName lastName companyEmail email designation department profileStatus signature');
                    if (delegatedEmp) return delegatedEmp;
                }
            }
        }

        // 3. Centralized Fallback:
        // If not found in specific company, find the first active responsibility of this category anywhere.
        // The user says "entire erp npt depends omn a or any company"
        const allCompanies = await Company.find({ 'responsibilities.category': category, 'responsibilities.status': 'Active' });
        for (const comp of allCompanies) {
            const responsibility = comp.responsibilities.find(r => r.category.toLowerCase() === category && r.status === 'Active');
            if (responsibility && responsibility.empObjectId) {
                const delegatedEmp = await EmployeeBasic.findById(responsibility.empObjectId)
                    .select('employeeId firstName lastName companyEmail email designation department profileStatus signature');
                if (delegatedEmp) return delegatedEmp;
            }
        }

        console.warn(`[getDepartmentHOD] No responsibility defined for ${category} anywhere in the system.`);
        return null;

    } catch (error) {
        console.error(`[getDepartmentHOD] Error finding HOD for ${departmentType}:`, error);
        return null;
    }
};

