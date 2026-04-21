import EmployeeBasic from "../models/EmployeeBasic.js";
import Flowchart from "../models/Flowchart.js";

/**
 * Retrieves the CEO (Management HOD) for final approval from Flowchart database.
 * All companies now share the same flowchart, so we use the global Flowchart collection.
 * @param {string} identifier Optional: Ignored - kept for backward compatibility. Flowchart is global.
 * @returns {Promise<Object|null>} The Management HOD employee object or null if not found.
 */
export const getManagementHOD = async (identifier = null) => {
    try {
        // Look for active Management HOD in Flowchart collection
        // All companies share the same flowchart now
        const responsibility = await Flowchart.findOne({
            category: 'management',
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
                await responsibility.save().catch(err => console.error('[getManagementHOD] Auto-repair failed:', err));
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
                email: responsibility.companyEmail || null,
                isFlowchartOnly: true
            };
        }

        console.warn('[getManagementHOD] No Management HOD defined in Flowchart.');
        return null;

    } catch (error) {
        console.error('[getManagementHOD] Error finding Management HOD:', error);
        return null;
    }
};

