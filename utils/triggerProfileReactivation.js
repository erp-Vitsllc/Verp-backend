import EmployeeBasic from "../models/EmployeeBasic.js";
import { hasEmployeeProfileEverBeenActivated } from "./employeeProfileStatusLock.js";

export const shouldQueueProfileChange = (employee = {}) => {
    if (String(employee?.profileStatus || "").toLowerCase() === "active") return false;
    if (String(employee?.profileApprovalStatus || "").toLowerCase() === "active") return false;
    return hasEmployeeProfileEverBeenActivated(employee);
};

/**
 * After a reactivation-eligible profile is edited, return approval status to draft.
 * profileStatus never demotes to inactive once activated. Submit to HR is manual.
 */
export const triggerProfileReactivationIfNeeded = async ({
    employeeId,
    actor = null,
    reason = "Profile data edited",
    changeEntry = null,
    trackDefaultChange = true,
}) => {
    const toSerializable = (value) => {
        if (value === undefined) return undefined;
        if (value === null) return null;
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (_error) {
            return value;
        }
    };
    if (!employeeId) return { triggered: false };

    const employee = await EmployeeBasic.findOne({ employeeId })
        .select("_id employeeId firstName lastName designation company profileStatus profileApprovalStatus profileWorkflow")
        .lean();
    if (!employee) return { triggered: false };

    // Applies only after profile activation lifecycle is started.
    if (!employee.company || !shouldQueueProfileChange(employee)) {
        return { triggered: false };
    }

    const cardLabel = String(reason || "Profile data edited").trim();
    const updateOps = { $set: {} };
    // First time after active: force reactivation state.
    // Also if user edits while already submitted, force back to draft for fresh HR review.
    const profileStatus = String(employee?.profileStatus || "").toLowerCase();
    const profileApprovalStatus = String(employee?.profileApprovalStatus || "").toLowerCase();
    if (profileStatus === "active" || profileApprovalStatus === "submitted") {
        // profileStatus stays active after first activation — only approval workflow resets.
        updateOps.$set.profileApprovalStatus = "draft";
        updateOps.$set.profileSubmittedTo = null;
    }

    if (changeEntry && typeof changeEntry === "object") {
        const normalizedEntry = {
            ...changeEntry,
            previousData: toSerializable(changeEntry.previousData),
            proposedData: toSerializable(changeEntry.proposedData),
        };
        updateOps.$push = {
            pendingReactivationChanges: {
                ...normalizedEntry,
                changedAt: changeEntry.changedAt || new Date(),
            },
        };
    } else if (trackDefaultChange && cardLabel) {
        updateOps.$push = {
            pendingReactivationChanges: {
                card: cardLabel,
                reason: cardLabel,
                changedAt: new Date(),
            },
        };
    }

    if (!updateOps.$set || Object.keys(updateOps.$set).length === 0) {
        delete updateOps.$set;
    }

    await EmployeeBasic.updateOne({ employeeId }, updateOps);

    return { triggered: true };
};
