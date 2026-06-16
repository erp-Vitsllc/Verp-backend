import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { skipLiveProfileWritesPendingHrAsync, queueOrTriggerProfileChange } from "../../utils/pushPendingReactivationChange.js";
import { markProfileActivationHoldResolvedForSection } from "../../utils/markProfileActivationHoldResolved.js";
import {
    validateEmployeeWorkDetailsPayload,
    WORK_STATUS_DIRECT_EDIT_BLOCKED,
} from "../../utils/employeeWorkDetailsValidation.js";
import { isUserAdministrator } from "../../services/permissionService.js";
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
        ];

        // 2. Filter request body to only include allowed fields
        const updatePayload = {};
        Object.keys(req.body).forEach((key) => {
            if (allowedFields.includes(key)) {
                updatePayload[key] = req.body[key];
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

        const isSystemAdmin = req.user?.id ? await isUserAdministrator(req.user.id) : false;
        const isPortalAdmin =
            req.user?.role === "Admin" ||
            req.user?.role === "ROOT" ||
            req.user?.isAdmin === true ||
            isSystemAdmin;

        if (updatePayload.status !== undefined) {
            const currentStatus = employee.status;
            const nextStatus = updatePayload.status;

            if (!isPortalAdmin) {
                if (nextStatus !== currentStatus && WORK_STATUS_DIRECT_EDIT_BLOCKED.includes(nextStatus)) {
                    return res.status(400).json({
                        message: `Work status "${nextStatus}" cannot be set from work details. Use the dedicated workflow.`,
                    });
                }

                if (
                    ["Notice", "Left User"].includes(currentStatus) &&
                    nextStatus !== currentStatus
                ) {
                    return res.status(400).json({
                        message: "Work status cannot be changed from work details while the employee is on notice or marked as Left User.",
                    });
                }
            }

            if (currentStatus === "Left User" && nextStatus !== "Left User" && nextStatus !== "Probation") {
                return res.status(400).json({
                    message: "A Left User employee can only be changed to Probation status.",
                });
            }

            if (currentStatus === "Left User" && nextStatus === "Probation") {
                const todayStr = new Date().toISOString().split('T')[0];
                updatePayload.dateOfJoining = todayStr;
                updatePayload.contractJoiningDate = todayStr;
                const reqProbation = updatePayload.probationPeriod !== undefined && updatePayload.probationPeriod !== null
                    ? Number(updatePayload.probationPeriod)
                    : 6;
                updatePayload.probationPeriod = !Number.isNaN(reqProbation) && reqProbation >= 0 && reqProbation <= 6
                    ? reqProbation
                    : 6;
            }
        }

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

        const skipLive = employee.status === "Left User" ? false : await skipLiveProfileWritesPendingHrAsync(req, employee);

        const adminStatusChanged =
            isPortalAdmin &&
            updatePayload.status !== undefined &&
            updatePayload.status !== employee.status;

        const queuePayload = { ...updatePayload };
        const liveAdminStatusPatch = {};

        // Admins expect work status (Probation/Permanent) to apply immediately even when
        // other work-detail fields are queued for HR on active/submitted profiles.
        if (skipLive && adminStatusChanged) {
            liveAdminStatusPatch.status = updatePayload.status;
            if (updatePayload.probationPeriod !== undefined) {
                liveAdminStatusPatch.probationPeriod = updatePayload.probationPeriod;
            }
            delete queuePayload.status;
            delete queuePayload.probationPeriod;
        }

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
            proposedData: skipLive ? queuePayload : updatePayload,
        };

        let statusAppliedLiveByAdmin = false;

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
            if (Object.keys(liveAdminStatusPatch).length > 0) {
                const statusUpdated = await EmployeeBasic.findOneAndUpdate(
                    { employeeId },
                    { $set: liveAdminStatusPatch },
                    { new: true, runValidators: true },
                ).select("-password");

                if (!statusUpdated) {
                    return res.status(404).json({ message: "Employee not found" });
                }
                statusAppliedLiveByAdmin = true;
            }

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
        let message = "Work details updated";
        if (skipLive) {
            message = statusAppliedLiveByAdmin
                ? "Work status updated. Other work detail changes are queued for HR activation approval."
                : "Work details change queued for HR activation approval.";
        }

        return res.status(200).json({
            message,
            employee: completeEmployee,
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};













