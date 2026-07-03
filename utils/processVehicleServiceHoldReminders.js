import AssetItem from "../models/AssetItem.js";
import { syncDashboardAction } from "./syncDashboard.js";
import { sendVehicleServiceWorkflowEmail } from "./sendVehicleServiceWorkflowEmail.js";
import { getDepartmentHOD } from "./getDepartmentHOD.js";
import { isTireChangeWorkflow, tireChangeDetailsPath, notifyTireChangeStakeholder } from "./tireChangeWorkflow.js";

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

const isDue = (remindAt) => {
    if (!remindAt) return false;
    const t = new Date(remindAt).getTime();
    if (Number.isNaN(t)) return false;
    return t <= Date.now();
};

/**
 * Hold reminders + pending-accounts nudges for vehicle service workflows.
 * Tire change: every 2 days → Admin Officer. Other services: legacy assignee reminder.
 */
export async function processVehicleServiceHoldReminders() {
    try {
        const assets = await AssetItem.find({
            "activeServiceWorkflow.stage": "pending_accounts",
        }).populate("assignedTo", "firstName lastName employeeId");

        for (const asset of assets) {
            const wf = asset?.activeServiceWorkflow || {};
            const serviceSub = wf.serviceRecordId ? asset.services?.id?.(wf.serviceRecordId) : null;
            const isTire = isTireChangeWorkflow(wf, serviceSub);
            const hold = wf.accountsHold || {};
            const detailsPath = tireChangeDetailsPath(asset._id, wf.serviceRecordId);

            if (isTire) {
                const remindAt = hold.remindAt
                    ? new Date(hold.remindAt)
                    : wf.accountsReminderAt
                      ? new Date(wf.accountsReminderAt)
                      : null;
                if (!isDue(remindAt)) continue;

                const adminOfficer = await getDepartmentHOD("admincontroller");
                if (!adminOfficer?._id) continue;

                const holdUntil = hold.holdUntilDate ? new Date(hold.holdUntilDate) : null;
                const extra2 = hold?.reason
                    ? `Accounts hold reminder: ${hold.reason}`
                    : "Accounts has not approved garage details yet";

                await notifyTireChangeStakeholder({
                    asset,
                    serviceRecordId: wf.serviceRecordId,
                    recipient: adminOfficer,
                    requestedByName: "Accounts",
                    extra2,
                    stageLabel: "Tire change — accounts follow-up",
                    actionLabel: "Tire change accounts reminder",
                    detailLine: holdUntil
                        ? `Accounts placed this tire change on hold until ${holdUntil.toLocaleDateString()}. Reason: ${hold.reason || "No reason provided"}.`
                        : "Accounts has not approved the garage details yet. Please follow up or update garage information if needed.",
                });

                if (hold?.holdUntilDate) {
                    wf.accountsHold.reminderSentAt = new Date();
                    wf.accountsHold.remindAt = new Date(Date.now() + TWO_DAYS_MS);
                } else {
                    wf.accountsReminderAt = new Date(Date.now() + TWO_DAYS_MS);
                }
                asset.activeServiceWorkflow = wf;
                asset.markModified("activeServiceWorkflow");
                await asset.save();
                continue;
            }

            if (!hold?.holdUntilDate || hold.reminderSentAt || !asset.assignedTo?._id) continue;

            const holdUntil = new Date(hold.holdUntilDate);
            if (Number.isNaN(holdUntil.getTime())) continue;

            const remindAt = hold.remindAt ? new Date(hold.remindAt) : new Date(holdUntil.getTime() - 24 * 60 * 60 * 1000);
            if (!isDue(remindAt)) continue;

            const legacyPath = `/HRM/Asset/Vehicle/service-requests/details/${asset._id}/${wf.serviceRecordId}`;

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
                    detailsPath: legacyPath,
                }),
            });

            await sendVehicleServiceWorkflowEmail({
                recipient: asset.assignedTo,
                asset,
                stageLabel: "Service hold reminder",
                actionLabel: "Vehicle service — hold follow-up",
                detailLine: `Hold follow-up is due on ${holdUntil.toLocaleDateString()}. Reason: ${hold.reason || "No reason provided"}.`,
                linkPath: legacyPath,
            });

            asset.activeServiceWorkflow.accountsHold.reminderSentAt = new Date();
            asset.markModified("activeServiceWorkflow");
            await asset.save();
        }
    } catch (e) {
        console.error("[processVehicleServiceHoldReminders] failed:", e);
    }
}
