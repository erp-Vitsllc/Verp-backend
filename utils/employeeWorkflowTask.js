import DashboardAction from "../models/DashboardAction.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import TaskManagerTask from "../models/TaskManagerTask.js";
import { personRequesterName } from "./vehicleServiceNotificationCopy.js";

/** Draft and approval rows that stay one workflow task for the employee who started them. */
export const EMPLOYEE_WORKFLOW_TYPES = new Set([
    "Inventory Bill Draft",
    "Fine",
    "Group Fine Request",
    "Loan",
    "Work Order LPO",
    "Work Order LPO Attachment",
    "Work Order LPO Approval",
]);

export function employeeWorkflowType(requestType) {
    return EMPLOYEE_WORKFLOW_TYPES.has(String(requestType || "").trim());
}

function personName(person) {
    return [person?.firstName, person?.lastName].filter(Boolean).join(" ").trim();
}

function clean(value) {
    return String(value || "").trim();
}

/** History row when the task moves from one employee to the next. */
export function assigneeHistoryEntry(previousName, nextName) {
    const from = clean(previousName);
    const to = clean(nextName);
    if (!to || from.toLowerCase() === to.toLowerCase()) return null;
    if (!from) {
        return {
            event: "Assigned",
            detail: `Assigned to ${to}.`,
            actorName: to,
            createdAt: new Date(),
        };
    }
    return {
        event: "Reassigned",
        detail: `Reassigned from ${from} to ${to}.`,
        actorName: from,
        createdAt: new Date(),
    };
}

export function pushTaskHistory(task, entry) {
    if (!task || !entry) return false;
    const history = task.history || [];
    const last = history[history.length - 1];
    if (last && last.event === entry.event && String(last.detail || "") === String(entry.detail || "")) return false;
    task.history = history;
    task.history.push(entry);
    return true;
}

export function createdHistoryEntry(requesterName, assigneeName) {
    const assignee = clean(assigneeName) || clean(requesterName) || "the employee";
    const actor = clean(requesterName) || clean(assigneeName) || "Employee";
    return {
        event: "Created",
        detail: `Created and assigned to ${assignee}.`,
        actorName: actor,
        createdAt: new Date(),
    };
}

/** Employee name for a user id or an employee id. Never "System". */
export async function requesterNameForActor(actorId) {
    if (!actorId) return "";
    const employee = await EmployeeBasic.findById(actorId).select("firstName lastName").lean();
    const fromEmployee = personName(employee);
    if (fromEmployee) return fromEmployee;
    const User = (await import("../models/User.js")).default;
    const user = await User.findById(actorId).select("name employeeId").lean();
    if (user?.employeeId) {
        const linked = await EmployeeBasic.findOne({ employeeId: user.employeeId })
            .select("firstName lastName")
            .lean();
        const linkedName = personName(linked);
        if (linkedName) return linkedName;
    }
    return personRequesterName(user?.name) || "";
}

/**
 * One workflow task for this dashboard row.
 * The requester stays the employee who started it.
 * A later assignee change is written on the task history.
 */
export async function ensureEmployeeWorkflowTask(action, assignee, requestedByName) {
    if (!action?._id || !action.assignedTo) return null;
    if (!employeeWorkflowType(action.requestType)) return null;

    const assigneeName = personName(assignee);
    const requester = personRequesterName(requestedByName)
        || personRequesterName(action.requestedByName)
        || assigneeName;
    const rows = await TaskManagerTask.find({ sourceDashboardActionId: action._id }).sort({ updatedAt: -1 });
    const pool = rows.filter((row) => String(row.status || "") !== "Cancelled");
    const open = pool.find((row) => !["Completed", "Rejected"].includes(String(row.status || "")));
    const keep = open || pool[0] || null;
    const extras = pool.filter((row) => keep && String(row._id) !== String(keep._id) && !["Completed", "Rejected"].includes(String(row.status || "")));
    if (extras.length) {
        await TaskManagerTask.updateMany(
            { _id: { $in: extras.map((row) => row._id) } },
            { $set: { status: "Cancelled" } },
        );
    }

    if (!keep) {
        return TaskManagerTask.create({
            sourceDashboardActionId: action._id,
            taskType: "Workflow Task",
            priority: "Medium",
            taskName: action.extra1 || action.requestType || "Task",
            description: action.extra2 || "",
            assignee: action.assignedTo,
            assigneeEmpId: action.assignedToEmpId || assignee?.employeeId || "",
            assigneeName,
            completionDate: action.requestedDate || new Date(),
            requestedByName: requester || assigneeName,
            status: "Pending",
            history: [createdHistoryEntry(requester || assigneeName, assigneeName)],
        });
    }

    const finished = ["Completed", "Rejected"].includes(String(keep.status || ""));
    if (finished) {
        keep.status = "Pending";
        pushTaskHistory(keep, {
            event: "Reopened",
            detail: assigneeName ? `The task is open again with ${assigneeName}.` : "The task is open again.",
            actorName: requester || assigneeName || "Employee",
            createdAt: new Date(),
        });
    }
    if (keep.taskType !== "Workflow Task") keep.taskType = "Workflow Task";
    if (!personRequesterName(keep.requestedByName) && (requester || assigneeName)) {
        keep.requestedByName = requester || assigneeName;
    }
    const previousName = clean(keep.assigneeName);
    const assigneeChanged = String(keep.assignee || "") !== String(action.assignedTo || "");
    if (assigneeChanged || finished) {
        keep.assignee = action.assignedTo;
        keep.assigneeEmpId = action.assignedToEmpId || assignee?.employeeId || keep.assigneeEmpId || "";
        if (assigneeName) keep.assigneeName = assigneeName;
        pushTaskHistory(keep, assigneeHistoryEntry(previousName, assigneeName || previousName));
    }
    if (action.extra1) keep.taskName = action.extra1;
    if (action.extra2) keep.description = action.extra2;
    await keep.save();
    return keep;
}

export async function finishEmployeeWorkflowTasks(requestId, requestType, {
    taskStatus = "Completed",
    event = "Completed",
    detail = "",
    actorName = "",
} = {}) {
    if (!requestId || !requestType) return;
    const actions = await DashboardAction.find({ requestId, requestType }).select("_id").lean();
    const ids = actions.map((row) => row._id).filter(Boolean);
    if (!ids.length) return;
    const tasks = await TaskManagerTask.find({
        sourceDashboardActionId: { $in: ids },
        status: { $nin: ["Completed", "Cancelled", "Rejected"] },
    });
    const actor = clean(actorName) || "Employee";
    for (const task of tasks) {
        task.status = taskStatus;
        pushTaskHistory(task, {
            event,
            detail: clean(detail) || (taskStatus === "Rejected" ? "The request was rejected." : "The request is completed."),
            actorName: actor,
            createdAt: new Date(),
        });
        await task.save();
    }
}
