import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import { getCompleteEmployee } from "../../services/employeeService.js";

export const updateWorkDetails = async (req, res) => {
    try {
        const { id } = req.params;

        // 1. Define allowed fields for work details
        const allowedFields = [
            "reportingAuthority",
            "primaryReportee",
            "secondaryReportee",
            "overtime",
            "status",
            "probationPeriod",
            "designation",
            "department",
            "contractJoiningDate",
            "contractExpiryDate",
            "dateOfJoining",
            "companyEmail",
            "profileStatus",
            "profileApprovalStatus"
        ];

        // 2. Build updatePayload
        const updatePayload = {};

        allowedFields.forEach(field => {
            if (req.body[field] !== undefined) {
                // Handle null/empty strings for reportee fields
                if ((field === 'primaryReportee' || field === 'secondaryReportee' || field === 'reportingAuthority') && (req.body[field] === '' || req.body[field] === null)) {
                    updatePayload[field] = null;
                } else {
                    updatePayload[field] = req.body[field];
                }
            }
        });

        // 3. If nothing to update
        if (Object.keys(updatePayload).length === 0) {
            return res.status(400).json({ message: "Nothing to update" });
        }

        // Get employeeId from employee record
        const employee = await getCompleteEmployee(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;

        // 4. Handle probation period logic (Strict enforcement based on dates)
        if (updatePayload.status === 'Probation' || updatePayload.status === 'Permanent' || (!updatePayload.status && (employee.status === 'Probation' || employee.status === 'Permanent'))) {
            const currentStatus = updatePayload.status || employee.status;

            // Priority: contractJoiningDate > dateOfJoining
            const refJoiningDate = updatePayload.contractJoiningDate || employee.contractJoiningDate || updatePayload.dateOfJoining || employee.dateOfJoining;
            const refExpiryDate = updatePayload.contractExpiryDate || employee.contractExpiryDate;

            // Check if status should be automatically changed
            let criteriaMetForPermanent = false;
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            // Check 1: Probation period from joining date has ended
            const probationMonths = updatePayload.probationPeriod || employee.probationPeriod || 6;
            if (refJoiningDate) {
                const joiningDate = new Date(refJoiningDate);
                const probationEndDate = new Date(joiningDate);
                probationEndDate.setMonth(probationEndDate.getMonth() + probationMonths);
                probationEndDate.setHours(0, 0, 0, 0);

                if (probationEndDate <= today) {
                    criteriaMetForPermanent = true;
                }
            }

            // Check 2: 6 months after contract's expiry (user requirement)
            if (!criteriaMetForPermanent && refExpiryDate) {
                const expiryDate = new Date(refExpiryDate);
                const sixMonthsAfterExpiry = new Date(expiryDate);
                sixMonthsAfterExpiry.setMonth(sixMonthsAfterExpiry.getMonth() + 6);
                sixMonthsAfterExpiry.setHours(0, 0, 0, 0);

                if (sixMonthsAfterExpiry <= today) {
                    criteriaMetForPermanent = true;
                }
            }

            // If it should be Permanent but isn't
            if (criteriaMetForPermanent && currentStatus === 'Probation') {
                updatePayload.status = 'Permanent';
                updatePayload.probationPeriod = null;
                // MANDATORY RESET: Reset profile for re-approval upon becoming Permanent
                updatePayload.profileStatus = 'inactive';
                updatePayload.profileApprovalStatus = 'draft';
                console.log(`[UpdateWorkDetails] Auto-promoting ${employeeId} to Permanent`);
            }
            // If it should be Probation but is Permanent (Reversion)
            else if (!criteriaMetForPermanent && currentStatus === 'Permanent') {
                updatePayload.status = 'Probation';
                updatePayload.probationPeriod = 6;
                console.log(`[UpdateWorkDetails] Auto-reverting ${employeeId} to Probation`);
            }
            // Ensure probation period is set if Probation
            else if (!criteriaMetForPermanent && currentStatus === 'Probation' && !updatePayload.probationPeriod && !employee.probationPeriod) {
                updatePayload.probationPeriod = 6;
            }
        }

        // 5. Update EmployeeBasic
        const updated = await EmployeeBasic.findOneAndUpdate(
            { employeeId },
            { $set: updatePayload },
            { new: true, runValidators: true }
        ).select("-password");

        if (!updated) {
            return res.status(404).json({ message: "Employee not found" });
        }

        // Get updated employee data
        const completeEmployee = await getCompleteEmployee(employeeId);
        delete completeEmployee.password;

        // 6. Sync companyEmail to User model if updated
        if (updatePayload.companyEmail !== undefined) {
            // Find linked User by employeeId
            await User.findOneAndUpdate(
                { employeeId: employeeId },
                { $set: { companyEmail: updatePayload.companyEmail } }
            );
        }

        // 7. Return success
        return res.status(200).json({
            message: "Work details updated",
            employee: completeEmployee
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};













