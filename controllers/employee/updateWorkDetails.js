import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { triggerProfileReactivationIfNeeded, shouldQueueProfileChange } from "../../utils/triggerProfileReactivation.js";
import { markProfileActivationHoldResolvedForSection } from "../../utils/markProfileActivationHoldResolved.js";

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
            "company",
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

        // Auto-fill contractJoiningDate with dateOfJoining if not provided
        // This ensures contract joining date always has a value when DOJ is available
        if (!updatePayload.contractJoiningDate && !employee.contractJoiningDate) {
            const doj = updatePayload.dateOfJoining || employee.dateOfJoining;
            if (doj) {
                updatePayload.contractJoiningDate = doj;
            }
        }

        // 4. Probation workflow policy:
        // Do NOT auto-promote/revert status in this endpoint.
        // Status change to Permanent should happen through probation approval workflow.
        if ((updatePayload.status || employee.status) === 'Probation' && !updatePayload.probationPeriod && !employee.probationPeriod) {
            updatePayload.probationPeriod = 6;
        }

        const requiresApprovalQueue = shouldQueueProfileChange(employee);
        if (requiresApprovalQueue) {
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Work details updated",
                changeEntry: {
                    card: "Work Details",
                    reason: "Work details updated",
                    section: "workDetails",
                    changeType: "update",
                    targetIndex: null,
                    previousData: {
                        reportingAuthority: employee.reportingAuthority || null,
                        primaryReportee: employee.primaryReportee || null,
                        secondaryReportee: employee.secondaryReportee || null,
                        overtime: employee.overtime,
                        status: employee.status,
                        probationPeriod: employee.probationPeriod,
                        designation: employee.designation,
                        department: employee.department,
                        company: employee.company || null,
                        contractJoiningDate: employee.contractJoiningDate || null,
                        contractExpiryDate: employee.contractExpiryDate || null,
                        dateOfJoining: employee.dateOfJoining || null,
                        companyEmail: employee.companyEmail || "",
                        profileStatus: employee.profileStatus,
                        profileApprovalStatus: employee.profileApprovalStatus,
                    },
                    proposedData: updatePayload,
                },
            });
        } else {
            // 5. Update EmployeeBasic
            const updated = await EmployeeBasic.findOneAndUpdate(
                { employeeId },
                { $set: updatePayload },
                { new: true, runValidators: true }
            ).select("-password");

            if (!updated) {
                return res.status(404).json({ message: "Employee not found" });
            }

            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Work details updated",
            });

            // 6. Sync companyEmail to User model if updated
            if (updatePayload.companyEmail !== undefined) {
                // Find linked User by employeeId
                await User.findOneAndUpdate(
                    { employeeId: employeeId },
                    { $set: { companyEmail: updatePayload.companyEmail } }
                );
            }
        }

        try {
            await markProfileActivationHoldResolvedForSection(employeeId, "workDetails");
        } catch (_e) {
            /* ignore */
        }

        // Get updated employee data
        const completeEmployee = await getCompleteEmployee(employeeId);
        delete completeEmployee.password;

        // 7. Return success
        return res.status(200).json({
            message: requiresApprovalQueue
                ? "Work details change queued for HR activation approval."
                : "Work details updated",
            employee: completeEmployee
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};













