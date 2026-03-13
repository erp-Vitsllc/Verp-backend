// getDepartmentHOD.js
import EmployeeBasic from "../models/EmployeeBasic.js";
import Flowchart from "../models/Flowchart.js";

/**
 * Retrieves the HOD (Head of Department) from the Flowchart collection.
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

        // Look for active HOD in Flowchart collection
        const responsibility = await Flowchart.findOne({
            category: category,
            status: 'Active'
        }).populate('empObjectId', 'employeeId firstName lastName companyEmail email designation department profileStatus signature');

        if (responsibility) {
            if (responsibility.empObjectId) {
                return responsibility.empObjectId;
            }

            // Fallback: If empObjectId is missing, try to find the employee by employeeId
            const employee = await EmployeeBasic.findOne({
                employeeId: { $regex: new RegExp(`^${responsibility.employeeId.replace(/\s+/g, '\\s*')}$`, 'i') }
            }).select('employeeId firstName lastName companyEmail email designation department profileStatus signature');

            if (employee) {
                // Auto-repair the flowchart entry for next time
                responsibility.empObjectId = employee._id;
                await responsibility.save().catch(err => console.error('[getDepartmentHOD] Auto-repair failed:', err));
                return employee;
            }

            // Final Fallback: Return a partial object from Flowchart data
            // This allows the system to at least know who the person is even if record is missing
            return {
                _id: null,
                firstName: responsibility.employeeName?.split(' ')[0] || 'Unknown',
                lastName: responsibility.employeeName?.split(' ').slice(1).join(' ') || '',
                employeeId: responsibility.employeeId,
                designation: responsibility.designation,
                email: responsibility.email || responsibility.companyEmail,
                isFlowchartOnly: true
            };
        }

        return null;
    } catch (error) {
        console.error(`[getDepartmentHOD] Fatal:`, error);
        return null;
    }
};

/**
 * Checks if a specific user is assigned to a category in the Flowchart.
 * @param {Object} user The user object (usually from req.user)
 * @param {string} category The category to check (e.g., 'assetcontroller')
 * @returns {Promise<boolean>} True if the user is an active HOD for this category
 */
export const isUserInFlowchart = async (user, category) => {
    try {
        if (!user) return false;

        const query = {
            category: category.toLowerCase(),
            status: { $in: ['Active', 'Pending'] }, // Allow both Active and Pending
            $or: []
        };

        if (user.employeeObjectId) query.$or.push({ empObjectId: user.employeeObjectId });
        if (user.employeeId) query.$or.push({ employeeId: { $regex: new RegExp(`^${user.employeeId.replace(/\s+/g, '\\s*')}$`, 'i') } });

        if (query.$or.length === 0) return false;

        const exists = await Flowchart.exists(query);
        return !!exists;
    } catch (error) {
        console.error(`[isUserInFlowchart] Error:`, error);
        return false;
    }
};
