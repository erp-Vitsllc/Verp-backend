import EmployeeBasic from "../../models/EmployeeBasic.js";

// Get next sequential Employee ID
export const getNextEmployeeId = async (req, res) => {
    try {
        // Find the employee with the "largest" employeeId string that matches the pattern 'VEGA - '
        // Since string sorting might not be perfect for 'VEGA - 10' vs 'VEGA - 2', we need to be careful.
        // However, standard regex query to extract numbers is cleaner.

        // We fetch all employeeIds to find the max. 
        // For a huge DB, aggregation is better.

        // Fetch all IDs matching the patterns (with or without spaces) to find the truly largest numeric value
        // Matches: VEGA-HR-123, VEGA -HR- 123, VEGA - 123, VEGA-123
        const employees = await EmployeeBasic.find({
            employeeId: { $regex: /^VEGA.*?\d+$/ }
        }).select('employeeId').lean();

        let maxIdNumber = 0;

        employees.forEach(emp => {
            // Extract the number from the end of the string
            const match = emp.employeeId.match(/\d+$/);
            if (match) {
                const num = parseInt(match[0], 10);
                if (!isNaN(num) && num > maxIdNumber) {
                    maxIdNumber = num;
                }
            }
        });

        const nextIdNumber = maxIdNumber + 1;

        const nextId = `VEGA -HR- ${String(nextIdNumber).padStart(5, '0')}`;

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
