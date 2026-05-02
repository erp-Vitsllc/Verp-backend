import DashboardAction from "../models/DashboardAction.js";

const escapeRegExp = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildExtra1Regex = (label) => {
    const escaped = escapeRegExp(label || "");
    return new RegExp(
        `^Expiry follow-up required:\\s*${escaped}(?:\\s*\\(Exp:\\s*[^)]+\\))?\\s*$`,
        "i"
    );
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

    await DashboardAction.deleteMany({
        requestId: employeeObjectId,
        requestType: { $in: ["Employee Document Expiry Reminder", "Document Expiry Reminder"] },
        status: "Pending",
        $or: normalizedLabels.map((label) => ({ extra1: { $regex: buildExtra1Regex(label) } })),
    });
};

