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
                const responsibility = company.responsibilities?.find(r =>
                    r.category && (r.category.toLowerCase() === 'management' || r.category.toLowerCase() === 'ceo')
                );

                if (responsibility && responsibility.empObjectId) {
                    const delegatedEmp = await EmployeeBasic.findById(responsibility.empObjectId)
                        .select('employeeId firstName lastName companyEmail email designation department profileStatus');
                    if (delegatedEmp) return delegatedEmp;
                }
            }
        }

        // 3. Centralized Fallback: If not found in target, look in ANY company
        const anyCompanyWithMgmt = await Company.findOne({
            "responsibilities.category": { $regex: /^(management|ceo)$/i }
        });

        if (anyCompanyWithMgmt) {
            const responsibility = anyCompanyWithMgmt.responsibilities.find(r =>
                r.category && (r.category.toLowerCase() === 'management' || r.category.toLowerCase() === 'ceo')
            );
            if (responsibility && responsibility.empObjectId) {
                const delegatedEmp = await EmployeeBasic.findById(responsibility.empObjectId)
                    .select('employeeId firstName lastName companyEmail email designation department profileStatus');
                if (delegatedEmp) {
                    console.log(`[getManagementHOD] Using Centralized Management from company ${anyCompanyWithMgmt.name}`);
                    return delegatedEmp;
                }
            }
        }

        console.warn('[getManagementHOD] No CEO found anywhere.');
        return null;

    } catch (error) {
        console.error('[getManagementHOD] Error finding CEO:', error);
        return null;
    }
};

