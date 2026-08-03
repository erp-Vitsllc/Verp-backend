/**
 * Active profile with an empty activation queue: fully withdraw the HR submission
 * (not just hide UI) — reset approval status, close dashboard tasks, clear hold metadata.
 */
export async function withdrawEmployeeActivationSubmissionIfQueueEmpty(doc, { actionedBy = null } = {}) {
    if (!doc) return false;

    const queue = Array.isArray(doc.pendingReactivationChanges) ? doc.pendingReactivationChanges : [];
    if (queue.length > 0) return false;

    const profileStatus = String(doc.profileStatus || "inactive").toLowerCase();
    if (profileStatus !== "active") return false;

    const approvalStatus = String(doc.profileApprovalStatus || "draft").toLowerCase();
    const wasSubmitted = approvalStatus === "submitted";
    const hasHold = Boolean(
        Array.isArray(doc.profileActivationHold?.unapprovedEntryIds) &&
            doc.profileActivationHold.unapprovedEntryIds.length > 0,
    );
    const hasSubmissionMetadata = Boolean(
        doc.profileSubmittedTo || doc.profileActivationSubmittedBy || doc.profileActivationDraftEditor,
    );

    if (!wasSubmitted && !hasHold && !hasSubmissionMetadata) {
        return false;
    }

    doc.profileApprovalStatus = "active";
    doc.profileSubmittedTo = undefined;
    doc.profileActivationSubmittedBy = undefined;
    doc.profileActivationDraftEditor = undefined;
    doc.profileActivationHold = undefined;
    doc.pendingReactivationChanges = [];
    doc.markModified("pendingReactivationChanges");
    doc.markModified("profileActivationHold");

    if (Array.isArray(doc.profileWorkflow)) {
        let workflowTouched = false;
        for (const step of doc.profileWorkflow) {
            if (String(step?.status || "").toLowerCase() === "submitted") {
                step.status = "rejected";
                step.actionedAt = new Date();
                step.comment = "Activation request withdrawn — pending queue empty.";
                workflowTouched = true;
            }
        }
        if (workflowTouched) {
            doc.markModified("profileWorkflow");
        }
    }

    await doc.save();

    try {
        const DashboardAction = (await import("../models/DashboardAction.js")).default;
        // Delete open HR/submitter Pending/On Hold rows — do not leave Rejected ghosts in the inbox.
        await DashboardAction.deleteMany({
            requestId: doc._id,
            requestType: "Profile Activation",
            status: { $in: ["Pending", "On Hold"] },
        });
    } catch (err) {
        console.error("[withdrawEmployeeActivationSubmissionIfQueueEmpty] dashboard:", err);
    }

    try {
        const { closeLeftUserDashboardTasks } = await import("./employeeLeftUserWorkflow.js");
        await closeLeftUserDashboardTasks({
            employeeMongoId: doc._id,
            status: "Rejected",
            actionedBy: actionedBy || null,
            comment: "Withdrawn — activation queue empty.",
        });
    } catch (err) {
        console.error("[withdrawEmployeeActivationSubmissionIfQueueEmpty] left user:", err);
    }

    return true;
}

/** @deprecated Use withdrawEmployeeActivationSubmissionIfQueueEmpty */
export function reconcileEmployeeActivationAfterEmptyQueue(doc) {
    if (!doc) return false;
    const queue = Array.isArray(doc.pendingReactivationChanges) ? doc.pendingReactivationChanges : [];
    if (queue.length > 0) return false;
    const profileStatus = String(doc.profileStatus || "inactive").toLowerCase();
    if (profileStatus !== "active") return false;
    const approvalStatus = String(doc.profileApprovalStatus || "draft").toLowerCase();
    if (approvalStatus !== "submitted") return false;
    doc.profileApprovalStatus = "active";
    doc.profileSubmittedTo = undefined;
    doc.profileActivationDraftEditor = undefined;
    if (doc.profileActivationHold) {
        doc.profileActivationHold = undefined;
        doc.markModified?.("profileActivationHold");
    }
    return true;
}
