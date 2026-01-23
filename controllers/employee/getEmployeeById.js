import { getCompleteEmployee, saveEmployeeData } from "../../services/employeeService.js";
import Fine from "../../models/Fine.js";
import Reward from "../../models/Reward.js";
import Loan from "../../models/Loan.js";

// Get single employee by ID
export const getEmployeeById = async (req, res) => {
    try {
        const { id } = req.params;

        // Validate ID parameter
        if (!id || id.trim() === '') {
            return res.status(400).json({ message: "Employee ID is required" });
        }

        console.log(`[getEmployeeById] Fetching employee with ID: ${id}`);
        const employee = await getCompleteEmployee(id);

        if (!employee) {
            console.log(`[getEmployeeById] Employee not found: ${id}`);
            return res.status(404).json({ message: "Employee not found" });
        }

        // Remove password from response
        if (employee.password) {
            delete employee.password;
        }

        // Check for Visa Expiry and Auto-Inactivate
        if (employee.profileStatus === 'active' && employee.visaDetails) {
            const today = new Date();
            today.setHours(0, 0, 0, 0); // Compare dates without time

            let isExpired = false;
            const visaTypes = ['visit', 'employment', 'spouse'];

            for (const type of visaTypes) {
                const visa = employee.visaDetails[type];
                if (visa && visa.expiryDate) {
                    const expiryDate = new Date(visa.expiryDate);
                    if (expiryDate <= today) {
                        isExpired = true;
                        break;
                    }
                }
            }

            if (isExpired) {
                console.log(`[getEmployeeById] Active employee ${id} has expired visa. Auto-setting to inactive.`);
                try {
                    await saveEmployeeData(id, { profileStatus: 'inactive' });
                    employee.profileStatus = 'inactive'; // Update local object for response
                } catch (updateError) {
                    console.error('[getEmployeeById] Failed to auto-inactivate employee:', updateError);
                }
            }
        }

        // Fetch Fines and Rewards
        try {
            const fines = await Fine.find({
                "assignedEmployees.employeeId": employee.employeeId,
                fineStatus: { $in: ["Approved", "Active", "Completed"] }
            }).sort({ createdAt: -1 }).lean();

            const rewards = await Reward.find({
                employeeId: employee.employeeId
            }).sort({ createdAt: -1 }).lean();

            const loans = await Loan.find({
                employeeId: employee.employeeId,
                status: "Approved"
            }).sort({ createdAt: -1 }).lean();

            employee.fines = fines || [];
            employee.rewards = rewards || [];
            employee.loans = loans || [];
            employee.loanAmount = 0; // Placeholder for future Loan module logic if needed
        } catch (err) {
            console.error('[getEmployeeById] Error fetching fines/rewards:', err);
            employee.fines = [];
            employee.rewards = [];
            employee.loanAmount = 0;
        }

        console.log(`[getEmployeeById] Successfully fetched employee: ${employee.employeeId || id}`);

        // Calculate approximate response size for logging
        const responseSize = JSON.stringify(employee).length;
        console.log(`[getEmployeeById] Response size: ${(responseSize / 1024).toFixed(2)} KB`);

        // Set response headers for better handling
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Length', responseSize);

        return res.status(200).json({
            message: "Employee fetched successfully",
            employee,
        });
    } catch (error) {
        console.error('[getEmployeeById] Error:', error);
        console.error('[getEmployeeById] Stack:', error.stack);
        return res.status(500).json({
            message: error.message || "Internal server error while fetching employee",
            error: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};



