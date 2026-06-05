import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import { saveEmployeeData, resolveEmployeeId } from "../../services/employeeService.js";
import { validateEmployeeAddBody, assertActiveCompany } from "../../utils/employeeAddValidation.js";

// Calculate age from date of birth
const calculateAge = (dateOfBirth) => {
    if (!dateOfBirth) return null;
    const birthDate = new Date(dateOfBirth);
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
        age--;
    }
    return age;
};

// Update employee
export const updateEmployee = async (req, res) => {
    try {
        const { id } = req.params;

        // Resolve employee
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;

        // Validate request body
        const validation = validateEmployeeAddBody(req.body);
        if (validation.errors.length > 0) {
            return res.status(400).json({
                message: validation.errors[0],
                errors: validation.errors,
            });
        }

        const companyError = await assertActiveCompany(req.body.company);
        if (companyError) {
            return res.status(400).json({ message: companyError });
        }

        // Check if employeeId has changed, if so verify uniqueness
        const newEmployeeId = validation.normalized.employeeId;
        if (newEmployeeId !== employeeId) {
            const existingEmployeeId = await EmployeeBasic.findOne({ employeeId: newEmployeeId });
            if (existingEmployeeId) {
                return res.status(400).json({ message: "Employee ID already exists" });
            }
        }

        // Check if email has changed, if so verify uniqueness
        const newEmail = validation.normalized.email;
        const currentBasic = await EmployeeBasic.findOne({ employeeId });
        if (newEmail && newEmail !== currentBasic?.email) {
            const existingEmail = await EmployeeBasic.findOne({ email: newEmail });
            if (existingEmail) {
                return res.status(400).json({ message: "Email already exists" });
            }
        }

        // Calculate age
        const age = calculateAge(req.body.dateOfBirth);

        // Sanitize status / normalize
        const allowedStatuses = ['Probation', 'Permanent', 'Temporary', 'Notice'];
        let normalizedStatus = allowedStatuses.includes(req.body.status) ? req.body.status : 'Probation';

        // Prepare data for saveEmployeeData
        const updatePayload = {
            ...req.body,
            employeeId: newEmployeeId,
            age,
            status: normalizedStatus,
        };

        // Update the employee data
        const updatedEmployee = await saveEmployeeData(employeeId, updatePayload);

        return res.status(200).json({
            message: "Employee updated successfully",
            employee: updatedEmployee,
        });

    } catch (error) {
        console.error('Error updating employee:', error);
        return res.status(500).json({ message: error.message });
    }
};
