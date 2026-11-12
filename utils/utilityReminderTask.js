import DashboardAction from "../models/DashboardAction.js";
import TaskManagerTask from "../models/TaskManagerTask.js";

export const UTILITY_PAYMENT_REMINDER = "Utility Bill Payment Reminder";

function readMeta(extra3) {
    if (!extra3) return {};
    if (typeof extra3 === "object") return extra3;
    try {
        const parsed = JSON.parse(String(extra3));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

/** One bell for the utility type and month, not one bell per SIM or account. */
export function isUtilityTypePaymentNotice(action) {
    if (String(action?.requestType || "") !== UTILITY_PAYMENT_REMINDER) return false;
    const meta = readMeta(action?.extra3);
    if (meta.utilityTypeNotice) return true;
    return String(meta.entryId || "").startsWith("utility-type:");
}

function accountsStoredAsSubject(action) {
    const subject = String(action?.subjectEmployeeId || "").trim().toLowerCase();
    const code = String(action?.assignedToEmpId || "").trim().toLowerCase();
    return Boolean(subject && code && subject === code);
}

function closeSnapshot(task) {
    const saved = task?.closeRequest;
    if (!saved) return {};
    return typeof saved.toObject === "function" ? saved.toObject() : { ...saved };
}

/** A paid close must not keep an unpaid month off the Pending list. */
function reopenUnpaidUtilityTask(task) {
    const saved = closeSnapshot(task);
    task.closeRequest = {
        ...saved,
        closedAt: null,
        reviewPending: false,
        assigneeCleared: false,
        reopenedAt: null,
    };
    task.markModified?.("closeRequest");
}

/**
 * One open System Task for this utility payment bell.
 * A finished task is opened again while the same month is still unpaid.
 */
export async function ensureUtilityReminderTask(action) {
    if (!action?._id || !action.assignedTo) return null;
    if (!isUtilityTypePaymentNotice(action)) return null;
    if (!["Pending", "On Hold"].includes(String(action.status || "Pending"))) return null;

    const taskName = String(action.extra2 || action.extra1 || "Utility bill payment").trim() || "Utility bill payment";
    const description = String(action.extra1 || "").trim();
    const assigneeName = String(action.subjectName || "").trim();
    const rows = await TaskManagerTask.find({ sourceDashboardActionId: action._id }).sort({ updatedAt: -1 });
    const pool = rows.filter((row) => String(row.status || "") !== "Cancelled");
    const [keep, ...extra] = pool;
    const extraOpen = extra.filter((row) => !["Completed", "Rejected"].includes(String(row.status || "")));
    if (extraOpen.length) {
        await TaskManagerTask.updateMany(
            { _id: { $in: extraOpen.map((row) => row._id) } },
            { $set: { status: "Cancelled" } },
        );
    }
    if (keep) {
        const assigneeChanged = String(keep.assignee || "") !== String(action.assignedTo);
        const finished = ["Completed", "Rejected"].includes(String(keep.status || ""));
        const nameChanged = String(keep.taskName || "") !== taskName;
        const closedStamp = Boolean(closeSnapshot(keep).closedAt) || Boolean(closeSnapshot(keep).assigneeCleared);
        if (assigneeChanged || finished || nameChanged || closedStamp || keep.taskType !== "System Task" || keep.priority !== "High") {
            keep.assignee = action.assignedTo;
            keep.assigneeEmpId = action.assignedToEmpId || keep.assigneeEmpId || "";
            if (assigneeName) keep.assigneeName = assigneeName;
            keep.taskType = "System Task";
            keep.priority = "High";
            keep.taskName = taskName;
            keep.description = description;
            keep.status = "Pending";
            if (finished || closedStamp) reopenUnpaidUtilityTask(keep);
            await keep.save();
        }
        return keep;
    }

    return TaskManagerTask.create({
        sourceDashboardActionId: action._id,
        taskType: "System Task",
        priority: "High",
        taskName,
        description,
        assignee: action.assignedTo,
        assigneeEmpId: action.assignedToEmpId || "",
        assigneeName,
        completionDate: action.requestedDate || new Date(),
        requestedByName: action.requestedByName || "System",
        status: "Pending",
    });
}

/** Pending utility-type bells that do not yet have an open task, including notices already on the bell. */
export async function ensurePendingUtilityReminderTasks() {
    const actions = await DashboardAction.find({
        requestType: UTILITY_PAYMENT_REMINDER,
        status: { $in: ["Pending", "On Hold"] },
    })
        .select("assignedTo assignedToEmpId requestType status subjectEmployeeId subjectName extra1 extra2 extra3 requestedDate requestedByName")
        .lean();
    const notices = (actions || []).filter(isUtilityTypePaymentNotice);
    if (!notices.length) return;

    const unsetIds = notices.filter(accountsStoredAsSubject).map((action) => action._id);
    if (unsetIds.length) {
        await DashboardAction.updateMany(
            { _id: { $in: unsetIds } },
            { $unset: { subjectEmployeeId: "" } },
        );
    }
    for (const action of notices) {
        try {
            await ensureUtilityReminderTask(action);
        } catch (error) {
            console.error("Utility reminder task:", error?.message || error);
        }
    }
}

export async function completeUtilityReminderTasks(actionIds = []) {
    const ids = (actionIds || []).filter(Boolean);
    if (!ids.length) return;
    await TaskManagerTask.updateMany(
        {
            sourceDashboardActionId: { $in: ids },
            status: { $nin: ["Completed", "Cancelled", "Rejected"] },
        },
        { $set: { status: "Completed" } },
    );
}
