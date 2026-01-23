import EmployeeBasic from "../models/EmployeeBasic.js";

/**
 * Retrieves the HOD (Head of Department) for a specific department.
 * @param {string} departmentName The name of the department (regex search).
 * @param {string[]} designations Optional specific designations to look for.
 * @returns {Promise<Object|null>} The HOD employee object or null if not found.
 */
export const getDepartmentHOD = async (departmentType, designations = []) => {
    try {
        let deptRegex;
        const type = departmentType.toLowerCase();
        if (type === 'hr' || type === 'human resource' || type === 'human resources') {
            deptRegex = /human resource|hr/i;
        } else if (type === 'finance' || type === 'accounts' || type === 'accounting') {
            deptRegex = /finance|accounts|accounting/i;
        } else {
            deptRegex = new RegExp(departmentType, 'i');
        }

        // Find match: prioritize active, but accept anything if no active found
        let query = {
            department: { $regex: deptRegex }
        };

        if (designations.length > 0) {
            query.designation = { $in: designations.map(d => new RegExp(`^${d}$`, 'i')) };
        }

        // Try to find active first
        let hod = await EmployeeBasic.findOne({ ...query, profileStatus: /active/i })
            .select('employeeId firstName lastName companyEmail email designation department');

        // Fallback to any match if no active one found
        if (!hod) {
            hod = await EmployeeBasic.findOne(query)
                .select('employeeId firstName lastName companyEmail email designation department');
        }

        if (!hod) {
            console.warn(`[getDepartmentHOD] No employee found for ${departmentType} (${deptRegex}).`);
            return null;
        }

        return hod;
    } catch (error) {
        console.error(`[getDepartmentHOD] Error finding HOD for ${departmentType}:`, error);
        return null;
    }
};
