import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { skipLiveProfileWritesPendingHr, queueOrTriggerProfileChange } from "../../utils/pushPendingReactivationChange.js";
import { markProfileActivationHoldResolvedForSection } from "../../utils/markProfileActivationHoldResolved.js";
import { validateEmployeeWorkDetailsPayload } from "../../utils/employeeWorkDetailsValidation.js";
import { resolveEmployeeProfileStatusWrite } from "../../utils/employeeProfileStatusLock.js";

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
            "enablePortalAccess",
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

        if (updatePayload.profileStatus !== undefined) {
            updatePayload.profileStatus = resolveEmployeeProfileStatusWrite(
                employee,
                updatePayload.profileStatus,
            );
        }

        const validation = await validateEmployeeWorkDetailsPayload(
            { ...employee, ...updatePayload },
            { employee, employeeId },
        );
        if (!validation.ok) {
            return res.status(400).json({ message: validation.message });
        }

        if (updatePayload.companyEmail !== undefined) {
            updatePayload.companyEmail = String(updatePayload.companyEmail || "")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();
        }

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

        const skipLive = skipLiveProfileWritesPendingHr(employee, req.user);

        const workChangeEntry = {
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
        };

        if (!skipLive) {
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
                changeEntry: null,
                trackDefaultChange: true,
            });

            if (updatePayload.companyEmail !== undefined) {
                await User.findOneAndUpdate(
                    { employeeId: employeeId },
                    { $set: { companyEmail: updatePayload.companyEmail } }
                );
            }
        } else {
            await queueOrTriggerProfileChange({
                employeeId,
                actor: req.user,
                reason: "Work details updated",
                employeeBasic: employee,
                changeEntry: workChangeEntry,
            });
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
            message: skipLive
                ? "Work details change queued for HR activation approval."
                : "Work details updated",
            employee: completeEmployee
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};













