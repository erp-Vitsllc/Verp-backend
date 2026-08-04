import DashboardAction from "../models/DashboardAction.js";

const escapeRegExp = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildLooseLabelRegex = (label) => {
    const raw = String(label || "").trim();
    // Skip overly generic tokens that would wipe unrelated notifications.
    if (!raw || ["document", "documents", "card", "expiry", "work"].includes(raw.toLowerCase())) {
        return null;
    }
    const escaped = escapeRegExp(raw);
    if (!escaped) return null;
    // Match expiry titles, not-renew titles, and free-form card mentions in extras.
    return new RegExp(escaped, "i");
};

const labelMatchOrClauses = (labels = []) => {
    const clauses = [];
    for (const label of labels) {
        const re = buildLooseLabelRegex(label);
        if (!re) continue;
        clauses.push({ extra1: { $regex: re } });
        clauses.push({ extra2: { $regex: re } });
        clauses.push({ extra3: { $regex: re } });
    }
    return clauses;
};

/**
 * Remove pending employee-document expiry tasks for specific labels.
 * Called when admin deletes source cards/documents so bell/task list stays in sync.
 */
export const cleanupEmployeeExpiryNotificationsByLabels = async ({
    employeeObjectId,
    labels = [],
}) => {
    if (!employeeObjectId) return;
    const normalizedLabels = [...new Set((labels || []).map((x) => String(x || "").trim()).filter(Boolean))];
    if (normalizedLabels.length === 0) return;

    const orClauses = labelMatchOrClauses(normalizedLabels);
    if (!orClauses.length) return;

    await DashboardAction.deleteMany({
        requestId: employeeObjectId,
        requestType: { $in: ["Employee Document Expiry Reminder", "Document Expiry Reminder"] },
        status: { $in: ["Pending", "On Hold"] },
        $or: orClauses,
    });
};

/**
 * Remove Employee Document Not Renew tasks tied to the deleted card.
 */
export const cleanupEmployeeNotRenewNotificationsByLabels = async ({
    employeeObjectId,
    labels = [],
    kinds = [],
} = {}) => {
    if (!employeeObjectId) return;
    const normalizedLabels = [...new Set((labels || []).map((x) => String(x || "").trim()).filter(Boolean))];
    const normalizedKinds = [...new Set((kinds || []).map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))];

    const rows = await DashboardAction.find({
        requestId: employeeObjectId,
        requestType: "Employee Document Not Renew",
        status: { $in: ["Pending", "On Hold"] },
    })
        .select("_id extra1 extra2 extra3")
        .lean();

    if (!rows.length) return;

    const idsToDelete = [];
    for (const row of rows) {
        let meta = {};
        try {
            meta = typeof row.extra3 === "object" ? row.extra3 : JSON.parse(row.extra3 || "{}");
        } catch {
            meta = {};
        }
        const kind = String(meta?.kind || "").trim().toLowerCase();
        const hay = `${row.extra1 || ""} ${row.extra2 || ""} ${JSON.stringify(meta)}`.toLowerCase();
        const kindHit = normalizedKinds.some((k) => kind === k || kind.includes(k) || hay.includes(k));
        const labelHit = normalizedLabels.some((label) => hay.includes(String(label).toLowerCase()));
        if (kindHit || labelHit) idsToDelete.push(row._id);
    }

    if (idsToDelete.length) {
        await DashboardAction.deleteMany({ _id: { $in: idsToDelete } });
    }
};

/**
 * After admin deletes a profile card: drop related pending-reactivation queue rows and
 * withdraw Profile Activation notifications when nothing remains to approve.
 */
export const cleanupEmployeeActivationNotificationsAfterCardDelete = async ({
    employeeObjectId,
    cardLabels = [],
    actionedBy = null,
} = {}) => {
    if (!employeeObjectId) return;
    try {
        const EmployeeBasic = (await import("../models/EmployeeBasic.js")).default;
        const { withdrawEmployeeActivationSubmissionIfQueueEmpty } = await import(
            "./reconcileEmployeeActivationAfterEmptyQueue.js"
        );

        const doc = await EmployeeBasic.findById(employeeObjectId);
        if (!doc) return;

        const labels = new Set(
            (cardLabels || [])
                .map((x) => String(x || "").trim().toLowerCase())
                .filter(Boolean),
        );
        if (labels.size && Array.isArray(doc.pendingReactivationChanges)) {
            const before = doc.pendingReactivationChanges.length;
            doc.pendingReactivationChanges = doc.pendingReactivationChanges.filter((entry) => {
                const card = String(entry?.card || "").trim().toLowerCase();
                const reason = String(entry?.reason || "").trim().toLowerCase();
                const proposed = JSON.stringify(entry?.proposedData || {}).toLowerCase();
                for (const label of labels) {
                    if (card.includes(label) || reason.includes(label) || proposed.includes(label)) {
                        return false;
                    }
                }
                return true;
            });
            if (doc.pendingReactivationChanges.length !== before) {
                doc.markModified("pendingReactivationChanges");
                await doc.save();
            }
        }

        const withdrawn = await withdrawEmployeeActivationSubmissionIfQueueEmpty(doc, { actionedBy });
        if (!withdrawn && labels.size) {
            // Still submitted with other cards — drop only activation dashboard rows that
            // clearly reference the deleted card in extras (rare single-card activation notes).
            const orClauses = labelMatchOrClauses([...labels]);
            if (orClauses.length) {
                await DashboardAction.deleteMany({
                    requestId: employeeObjectId,
                    requestType: "Profile Activation",
                    status: { $in: ["Pending", "On Hold"] },
                    $or: orClauses,
                });
            }
        }
    } catch (err) {
        console.error("[cleanupEmployeeActivationNotificationsAfterCardDelete]", err);
    }
};

/**
 * Drop pending not-renew request rows on the employee when their source card is deleted.
 */
const clearEmployeePendingNotRenewRequestsByKinds = async ({
    employeeObjectId,
    kinds = [],
    labels = [],
} = {}) => {
    if (!employeeObjectId) return;
    const normalizedKinds = [...new Set((kinds || []).map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))];
    const normalizedLabels = [...new Set((labels || []).map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))];
    if (!normalizedKinds.length && !normalizedLabels.length) return;

    try {
        const EmployeeBasic = (await import("../models/EmployeeBasic.js")).default;
        const doc = await EmployeeBasic.findById(employeeObjectId);
        if (!doc || !Array.isArray(doc.pendingNotRenewRequests) || !doc.pendingNotRenewRequests.length) return;

        const before = doc.pendingNotRenewRequests.length;
        doc.pendingNotRenewRequests = doc.pendingNotRenewRequests.filter((entry) => {
            const kind = String(entry?.kind || "").trim().toLowerCase();
            const label = String(entry?.label || "").trim().toLowerCase();
            const kindHit = normalizedKinds.some((k) => kind === k || kind.includes(k));
            const labelHit = normalizedLabels.some((l) => label.includes(l) || l.includes(label));
            return !(kindHit || labelHit);
        });
        if (doc.pendingNotRenewRequests.length !== before) {
            doc.markModified("pendingNotRenewRequests");
            await doc.save();
        }
    } catch (err) {
        console.error("[clearEmployeePendingNotRenewRequestsByKinds]", err);
    }
};

/**
 * One-shot cleanup after admin deletes an employee card/document:
 * expiry reminders + not-renew tasks + activation queue/notifications, then reconcile.
 */
export const cleanupAllNotificationsForEmployeeCardDelete = async ({
    employeeObjectId,
    labels = [],
    cardLabels = [],
    notRenewKinds = [],
    actionedBy = null,
} = {}) => {
    if (!employeeObjectId) return;

    const allLabels = [...new Set([...(labels || []), ...(cardLabels || [])].map((x) => String(x || "").trim()).filter(Boolean))];

    await cleanupEmployeeExpiryNotificationsByLabels({
        employeeObjectId,
        labels: allLabels,
    });
    await clearEmployeePendingNotRenewRequestsByKinds({
        employeeObjectId,
        kinds: notRenewKinds,
        labels: allLabels,
    });
    await cleanupEmployeeNotRenewNotificationsByLabels({
        employeeObjectId,
        labels: allLabels,
        kinds: notRenewKinds,
    });
    await cleanupEmployeeActivationNotificationsAfterCardDelete({
        employeeObjectId,
        cardLabels: allLabels,
        actionedBy,
    });

    try {
        const { reconcileEmployeeDocumentExpiryDashboard } = await import(
            "./processDocumentExpiryReminders.js"
        );
        await reconcileEmployeeDocumentExpiryDashboard(employeeObjectId);
    } catch (err) {
        console.error("[cleanupAllNotificationsForEmployeeCardDelete] reconcile expiry:", err);
    }
};
