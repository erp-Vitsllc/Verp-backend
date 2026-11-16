import DashboardAction from "../models/DashboardAction.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import { syncDashboardAction } from "./syncDashboard.js";
import { resolvePortalActorId } from "./resolvePortalActorId.js";

async function resolveDashboardAssigneeId(actor) {
    const raw = resolvePortalActorId(actor);
    if (!raw) return null;
    const sid = String(raw);
    if (/^[0-9a-fA-F]{24}$/.test(sid)) {
        const direct = await EmployeeBasic.findById(sid).select("_id").lean();
        if (direct?._id) return direct._id;
        const User = (await import("../models/User.js")).default;
        const user = await User.findById(sid).select("employeeId").lean();
        if (user?.employeeId) {
            const linked = await EmployeeBasic.findOne({ employeeId: user.employeeId }).select("_id").lean();
            if (linked?._id) return linked._id;
        }
    }
    const code = String(actor?.employeeId || "").trim();
    if (code) {
        const byCode = await EmployeeBasic.findOne({ employeeId: code }).select("_id").lean();
        if (byCode?._id) return byCode._id;
    }
    return null;
}

export const PROFILE_HR_SUBMIT_REMINDER_TYPE = "Profile HR Submit Reminder";

export const PROFILE_HR_SUBMIT_REMINDER_MESSAGE =
    "You edited but HR approval not added. Send for HR approval for updation.";

/**
 * Bell row for the employee who saved a company or employee profile card
 * that is waiting to be sent for HR approval. HR edits do not call this.
 * Each editor keeps their own row.
 */
export async function notifyProfileHrSubmitReminder({
    requestId,
    actor = null,
    entityKind = "employee",
    subject = null,
    cardLabel = "",
} = {}) {
    try {
        const assignedTo = await resolveDashboardAssigneeId(actor);
        if (!requestId || !assignedTo) return { sent: false, reason: "MISSING_ACTOR" };

        const kind = entityKind === "company" ? "company" : "employee";
        const name = `${subject?.firstName || ""} ${subject?.lastName || ""}`.trim()
            || subject?.name
            || subject?.employeeId
            || (kind === "company" ? "Company" : "Employee");
        const card = String(cardLabel || "").trim();

        await syncDashboardAction({
            requestId,
            requestType: PROFILE_HR_SUBMIT_REMINDER_TYPE,
            assignedTo: String(assignedTo),
            status: "Pending",
            subjectEmployee: subject
                ? {
                    employeeId: subject.employeeId || subject.companyId || "",
                    firstName: subject.firstName || subject.name || name,
                    lastName: subject.lastName || "",
                    designation: subject.designation || "",
                }
                : { employeeId: "", firstName: name, lastName: "" },
            requestedByName: actor?.name || name,
            extra1: PROFILE_HR_SUBMIT_REMINDER_MESSAGE,
            extra2: card ? `${card} · ${name}` : name,
            extra3: JSON.stringify({
                entityKind: kind,
                kind: "awaiting-hr-submit",
                cardLabel: card,
                employeeId: subject?.employeeId || "",
                companyMongoId: kind === "company" ? String(requestId) : "",
            }),
        });
        return { sent: true };
    } catch (err) {
        console.warn("[notifyProfileHrSubmitReminder]", err?.message || err);
        return { sent: false, reason: "ERROR" };
    }
}

/** Drop the "send for HR approval" reminder after submit, approve, or reject. */
export async function clearProfileHrSubmitReminders(requestId, actor = null) {
    try {
        if (!requestId) return;
        const filter = {
            requestId,
            requestType: PROFILE_HR_SUBMIT_REMINDER_TYPE,
            status: "Pending",
        };
        if (actor) {
            const assignedTo = await resolveDashboardAssigneeId(actor);
            if (!assignedTo) return;
            filter.assignedTo = assignedTo;
        }
        await DashboardAction.updateMany(filter, {
            $set: {
                status: "Dismissed",
                actionedDate: new Date(),
                comment: "HR approval was sent or the queued edit was closed.",
            },
        });
    } catch (err) {
        console.warn("[clearProfileHrSubmitReminders]", err?.message || err);
    }
}
