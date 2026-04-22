import EmployeeBasic from "../models/EmployeeBasic.js";

export const shouldQueueProfileChange = (employee = {}) => {
    const profileStatus = String(employee?.profileStatus || "").toLowerCase();
    if (profileStatus === "active") return true;
    const workflow = Array.isArray(employee?.profileWorkflow) ? employee.profileWorkflow : [];
    const hasEverBeenActive = workflow.some((step) => String(step?.status || "").toLowerCase() === "active");
    return hasEverBeenActive;
};

/**
 * After an active profile is edited, mark it inactive and return approval status to draft.
 * No auto-submission to HR; submission is manual via "Submit for Approval".
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
        updateOps.$set.profileStatus = "inactive";
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
