import EmployeeBasic from "../models/EmployeeBasic.js";

/**
 * Checks if an employee has passed their probation period and updates their status if necessary.
 * @param {Object} employee - Employee object (should include status, contractJoiningDate, probationPeriod)
 * @returns {Promise<Object>} The updated (or original) employee object
 */
export const checkAndUpdateProbationStatus = async (employee) => {
    const probationStart = employee?.contractJoiningDate;
    if (!employee || employee.status !== "Probation" || !probationStart) {
        return employee;
    }

    const joinDate = new Date(probationStart);
    joinDate.setHours(0, 0, 0, 0);
    const probationPeriod = (employee.probationPeriod !== undefined && employee.probationPeriod !== null) ? employee.probationPeriod : 6;

    const probationEndDate = new Date(joinDate);
    probationEndDate.setMonth(joinDate.getMonth() + probationPeriod);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    probationEndDate.setHours(0, 0, 0, 0);

    if (today >= probationEndDate) {
        try {
            // Update in database
            const updatedEmployee = await EmployeeBasic.findByIdAndUpdate(
                employee._id,
                {
                    $set: {
                        status: "Permanent",
                        probationPeriod: null
                    }
                },
                { new: true }
            );

            console.log(`[Auto-Update] Employee ${employee.employeeId} status changed from Probation to Permanent.`);
            return updatedEmployee ? updatedEmployee.toObject() : employee;
        } catch (error) {
            console.error(`[Auto-Update] Failed to update probation status for ${employee.employeeId}:`, error);
        }
    }

    return employee;
};
