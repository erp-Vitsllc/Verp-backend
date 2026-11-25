import EmployeeBasic from "../models/EmployeeBasic.js";
import TaskManagerTask from "../models/TaskManagerTask.js";
import { pushHandoffHistory } from "./employeeWorkflowTask.js";

/** Each leave or attendance request keeps one dashboard row and one task. */
export const LEAVE_ATTENDANCE_TASK_TYPES = new Set([
    "Employee Leave Request",
    "Attendance Leave Request",
    "Attendance Change Request",
    "Hour Approval Request",
    "Flexible OT Request",
    "Attendance Off Day Work",
]);

export function isLeaveAttendanceTaskType(requestType) {
    return LEAVE_ATTENDANCE_TASK_TYPES.has(String(requestType || "").trim());
}

function personName(person) {
    return [person?.firstName, person?.lastName].filter(Boolean).join(" ").trim();
}

/** Move a leave or attendance task to the employee who now holds the request. */
export function applyAssigneeFollow(task, { assigneeId, assigneeEmpId = "", assigneeName = "" } = {}) {
    const nextId = String(assigneeId || "").trim();
    if (!task || !nextId || String(task.assignee || "") === nextId) return false;
    const previousName = String(task.assigneeName || "").trim();
    const nextName = String(assigneeName || "").trim();
    task.assignee = assigneeId;
    task.assigneeEmpId = assigneeEmpId || task.assigneeEmpId || "";
    if (nextName) task.assigneeName = nextName;
    const close = task.closeRequest?.toObject ? task.closeRequest.toObject() : { ...(task.closeRequest || {}) };
    task.closeRequest = {
        ...close,
        originalAssigneeId: null,
        originalAssigneeEmpId: "",
        originalAssigneeName: "",
        reassignmentReleased: false,
        returnAssigneeId: null,
        returnAssigneeEmpId: "",
        returnAssigneeName: "",
    };
    task.markModified?.("closeRequest");
    pushHandoffHistory(task, previousName, nextName);
    return true;
}

function taskStatusForDecision(status) {
    const value = String(status || "");
    if (value === "Rejected") return "Rejected";
    if (value === "Dismissed") return "Cancelled";
    return "Completed";
}

/**
 * One open task for this dashboard row.
 * A finished task is opened again when the same request is still waiting.
 * Extra open copies are closed.
 */
export async function ensureOwnRequestTask(action, assignee = null) {
    if (!action?._id || !action.assignedTo) return null;
    if (!isLeaveAttendanceTaskType(action.requestType)) return null;
    if (!["Pending", "On Hold"].includes(String(action.status || "Pending"))) return null;

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
    let name = personName(assignee);
    if (keep) {
        const assigneeChanged = String(keep.assignee || "") !== String(action.assignedTo);
        const finished = ["Completed", "Rejected"].includes(String(keep.status || ""));
        if (assigneeChanged && !name) {
            const person = await EmployeeBasic.findById(action.assignedTo)
                .select("firstName lastName employeeId")
                .lean();
            name = personName(person);
            if (!assignee?.employeeId && person?.employeeId) {
                keep.assigneeEmpId = person.employeeId;
            }
        }
        if (assigneeChanged) {
            applyAssigneeFollow(keep, {
                assigneeId: action.assignedTo,
                assigneeEmpId: action.assignedToEmpId || assignee?.employeeId || keep.assigneeEmpId || "",
                assigneeName: name,
            });
        }
        if (assigneeChanged || finished) {
            keep.status = "Pending";
            await keep.save();
        }
        return keep;
    }

    return TaskManagerTask.create({
        sourceDashboardActionId: action._id,
        taskType: "Workflow Task",
        priority: "Medium",
        taskName: action.requestType || "Task",
        description: action.extra2 || action.extra1 || "",
        assignee: action.assignedTo,
        assigneeEmpId: action.assignedToEmpId || assignee?.employeeId || "",
        assigneeName: name,
        completionDate: action.requestedDate || new Date(),
        requestedByName: action.requestedByName || "",
        status: "Pending",
    });
}

/** Pending leave and attendance rows that do not yet have their own task. */
export async function attachMissingRequestTasks(actions = []) {
    const list = (actions || []).filter((action) => action?._id && isLeaveAttendanceTaskType(action.requestType));
    if (!list.length) return;
    const ids = list.map((action) => action._id);
    const tasks = await TaskManagerTask.find({
        sourceDashboardActionId: { $in: ids },
        status: { $nin: ["Cancelled"] },
    })
        .select("sourceDashboardActionId status")
        .lean();
    const bySource = new Map();
    for (const task of tasks) {
        const key = String(task.sourceDashboardActionId);
        const current = bySource.get(key);
        if (!current || ["Completed", "Rejected"].includes(String(current.status || ""))) {
            bySource.set(key, task);
        }
    }
    for (const action of list) {
        const linked = bySource.get(String(action._id));
        const needsTask = !linked || ["Completed", "Rejected"].includes(String(linked.status || ""));
        if (needsTask) await ensureOwnRequestTask(action);
    }
}

/** Close the dashboard row and its task when a leave or attendance request is decided. */
export async function closeLeaveAttendanceRequest({
    requestId,
    requestType,
    status = "Approved",
    actorId = null,
} = {}) {
    if (!requestId || !isLeaveAttendanceTaskType(requestType)) return;
    const { syncDashboardAction } = await import("./syncDashboard.js");
    await syncDashboardAction({
        requestId,
        requestType,
        status,
        actionedBy: actorId || null,
    });
}

export async function completeOwnRequestTasks(actionIds = [], status = "Approved") {
    const ids = (actionIds || []).filter(Boolean);
    if (!ids.length) return;
    await TaskManagerTask.updateMany(
        {
            sourceDashboardActionId: { $in: ids },
            status: { $nin: ["Completed", "Cancelled", "Rejected"] },
        },
        { $set: { status: taskStatusForDecision(status) } },
    );
}
