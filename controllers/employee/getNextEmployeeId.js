import EmployeeBasic from "../../models/EmployeeBasic.js";

// Get next sequential Employee ID
export const getNextEmployeeId = async (req, res) => {
    try {
        // Find the employee with the "largest" employeeId string that matches the pattern 'VEGA - '
        // Since string sorting might not be perfect for 'VEGA - 10' vs 'VEGA - 2', we need to be careful.
        // However, standard regex query to extract numbers is cleaner.

        // We fetch all employeeIds to find the max. 
        // For a huge DB, aggregation is better.

        const lastEmployee = await EmployeeBasic.findOne({
            employeeId: { $regex: /^VEGA\s-\s\d+$/ }
        }).sort({ employeeId: -1 }).select('employeeId');

        let nextIdNumber = 1;

        if (lastEmployee && lastEmployee.employeeId) {
            const parts = lastEmployee.employeeId.split('-');
            if (parts.length === 2) {
                const numberPart = parseInt(parts[1].trim(), 10);
                if (!isNaN(numberPart)) {
                    nextIdNumber = numberPart + 1;
                }
            }
        } else {
            // Fallback: check if there are ANY employees to determine if we should start at 1
            // If there are employees but none match 'VEGA - ', start at 1.
        }

        const nextId = `VEGA - ${String(nextIdNumber).padStart(5, '0')}`;

        return res.status(200).json({
            nextEmployeeId: nextId
        });

    } catch (error) {
        console.error('Error generating next employee ID:', error);
        return res.status(500).json({
            message: 'Failed to generate employee ID',
            error: error.message
        });
    }
};
