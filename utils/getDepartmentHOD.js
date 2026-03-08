// getDepartmentHOD.js
import EmployeeBasic from "../models/EmployeeBasic.js";
import Company from "../models/Company.js";

/**
 * Retrieves the HOD (Head of Department) from the primary ERP Main Flowchart (EST-001) ONLY.
 * @param {string} departmentType The department type ('hr', 'accounts', 'finance', 'assetcontroller').
 * @returns {Promise<Object|null>} The HOD employee object or null if not found.
 */
export const getDepartmentHOD = async (departmentType) => {
    try {
        const type = departmentType.toLowerCase();
        let category = type;
        if (type === 'hr' || type === 'human resource' || type === 'human resources') {
            category = 'hr';
        } else if (type === 'finance' || type === 'accounts' || type === 'accounting') {
            category = 'accounts';
        }

        // ERP MAIN FLOWCHART: Always take from the master company EST-001.
        // This ensures one universal management structure for all assets and employees.
        const mainCompany = await Company.findOne({ companyId: "EST-001" });

        if (mainCompany) {
            const responsibility = mainCompany.responsibilities?.find(r =>
                r.category && r.category.toLowerCase() === category && r.status === 'Active'
            );
            if (responsibility && responsibility.empObjectId) {
                return await EmployeeBasic.findById(responsibility.empObjectId)
                    .select('employeeId firstName lastName companyEmail email designation department profileStatus signature');
            }
        }

        return null;
    } catch (error) {
        console.error(`[getDepartmentHOD] Fatal:`, error);
        return null;
    }
};
