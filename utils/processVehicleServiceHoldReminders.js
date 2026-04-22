import AssetItem from "../models/AssetItem.js";
import { syncDashboardAction } from "./syncDashboard.js";
import { sendVehicleServiceWorkflowEmail } from "./sendVehicleServiceWorkflowEmail.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const isDue = (remindAt) => {
    if (!remindAt) return false;
    const t = new Date(remindAt).getTime();
    if (Number.isNaN(t)) return false;
    return t <= Date.now();
};

const holdReminderPath = (assetId, serviceRecordId) => {
    if (!assetId || !serviceRecordId) return null;
    return `/HRM/Asset/Vehicle/service-requests/details/${assetId}/${serviceRecordId}`;
};

/**
 * Send deferred reminder/task for Accounts hold (1 day before hold-until date).
 * This runs periodically from backend index.js.
 */
export async function processVehicleServiceHoldReminders() {
    try {
        const assets = await AssetItem.find({
            "activeServiceWorkflow.stage": "pending_accounts",
            "activeServiceWorkflow.accountsHold.holdUntilDate": { $ne: null },
            "activeServiceWorkflow.accountsHold.reminderSentAt": null,
        }).populate("assignedTo", "firstName lastName employeeId");

        for (const asset of assets) {
            const wf = asset?.activeServiceWorkflow || {};
            const hold = wf.accountsHold || {};
            if (!asset.assignedTo?._id) continue;

            const holdUntil = hold.holdUntilDate ? new Date(hold.holdUntilDate) : null;
            if (!holdUntil || Number.isNaN(holdUntil.getTime())) continue;

            const remindAt = hold.remindAt ? new Date(hold.remindAt) : new Date(holdUntil.getTime() - DAY_MS);
            if (!isDue(remindAt)) continue;

            const detailsPath = holdReminderPath(asset._id, wf.serviceRecordId);

            await syncDashboardAction({
                requestId: asset._id,
                requestType: "Vehicle Service Request",
                status: "Pending",
                assignedTo: asset.assignedTo._id,
                subjectEmployee: asset.assignedTo,
                requestedByName: "Accounts",
                extra1: `${asset.assetId} — ${wf.serviceTypeLabel || "Service"}`,
                extra2: `Hold reminder: ${hold.reason || "No reason"} (until ${holdUntil.toLocaleDateString()})`,
                extra3: JSON.stringify({
                    vehicleId: String(asset._id),
                    serviceRecordId: wf.serviceRecordId ? String(wf.serviceRecordId) : "",
                    detailsPath: detailsPath || "",
                }),
            });

            await sendVehicleServiceWorkflowEmail({
                recipient: asset.assignedTo,
                asset,
                stageLabel: "Service hold reminder",
                actionLabel: "Vehicle service — hold follow-up",
                detailLine: `Hold follow-up is due on ${holdUntil.toLocaleDateString()}. Reason: ${hold.reason || "No reason provided"}.`,
                linkPath: detailsPath,
            });

            asset.activeServiceWorkflow.accountsHold.reminderSentAt = new Date();
            asset.markModified("activeServiceWorkflow");
            await asset.save();
        }
    } catch (e) {
        console.error("[processVehicleServiceHoldReminders] failed:", e);
    }
}
