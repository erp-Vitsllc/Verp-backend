import DashboardAction from "../models/DashboardAction.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import Flowchart from "../models/Flowchart.js";
import TaskManagerTask from "../models/TaskManagerTask.js";
import { isGeneralHubRequestType } from "./employeeHubRequestTypes.js";
import { personRequesterName } from "./vehicleServiceNotificationCopy.js";

/** Draft and approval rows that stay one workflow task for the employee who started them. */
export const EMPLOYEE_WORKFLOW_TYPES = new Set([
    "Inventory Bill Draft",
    "Fine",
    "Group Fine Request",
    "Loan",
    "Work Order Project",
    "Work Order Checklist",
    "Work Order LPO",
    "Work Order LPO Attachment",
    "Work Order LPO Approval",
    "Work Order Actual BOQ",
    "Work Order Actual BOQ Update",
    "Work Order MR",
    "Work Order MOM",
]);

export function employeeWorkflowType(requestType) {
    const type = String(requestType || "").trim();
    if (EMPLOYEE_WORKFLOW_TYPES.has(type)) return true;
    return /^Work Order MR \d+$/.test(type);
}

/** A work order step belongs on the Project Task board. */
export function isWorkOrderRequestType(requestType) {
    return String(requestType || "").trim().startsWith("Work Order ");
}

/** Work-order steps are Project tasks. Bills stay workflow tasks. */
export function workflowTaskType(requestType) {
    if (isWorkOrderRequestType(requestType)) return "Project Task";
    return "Workflow Task";
}

function personName(person) {
    return [person?.firstName, person?.lastName].filter(Boolean).join(" ").trim();
}

function clean(value) {
    return String(value || "").trim();
}

/** A workflow request that moves from one employee to the next on the same task. */
export function isAutomaticWorkflowHandoff(requestType) {
    const type = String(requestType || "").trim();
    if (!type || type === "Task Manager") return false;
    if (isGeneralHubRequestType(type)) return false;
    if (/expiry|not renew|card deleted|value missing|asset overdue|profile incomplete|payment reminder|fuel reminder|images missing|submit reminder/i.test(type)) return false;
    return true;
}

/**
 * History when one employee finishes and the same task is given to the next employee.
 * The first line names who completed their part. The second names who received it.
 */
export function handoffHistoryEntries(previousName, nextName) {
    const from = clean(previousName);
    const to = clean(nextName);
    if (!to || from.toLowerCase() === to.toLowerCase()) return [];
    const at = new Date();
    const entries = [];
    if (from) {
        entries.push({
            event: "Completed",
            detail: `Task completed by ${from}.`,
            actorName: from,
            createdAt: at,
        });
    }
    entries.push({
        event: "Assigned",
        detail: `Assigned automatically to ${to}.`,
        actorName: from || to,
        createdAt: at,
    });
    return entries;
}

export function pushHandoffHistory(task, previousName, nextName) {
    let pushed = false;
    for (const entry of handoffHistoryEntries(previousName, nextName)) {
        if (pushTaskHistory(task, entry)) pushed = true;
    }
    return pushed;
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

/** Names for user ids and employee ids. Skips System. */
export async function requesterNamesByActorIds(ids = []) {
    const wanted = [...new Set((ids || []).map((id) => String(id?._id || id || "")).filter((id) => /^[a-f\d]{24}$/i.test(id)))];
    const names = new Map();
    if (!wanted.length) return names;
    const employees = await EmployeeBasic.find({ _id: { $in: wanted } }).select("firstName lastName").lean();
    for (const employee of employees) {
        const name = personName(employee);
        if (name) names.set(String(employee._id), name);
    }
    const missing = wanted.filter((id) => !names.has(id));
    if (!missing.length) return names;
    const User = (await import("../models/User.js")).default;
    const users = await User.find({ _id: { $in: missing } }).select("name employeeId").lean();
    const codes = [...new Set(users.map((user) => String(user.employeeId || "").trim()).filter(Boolean))];
    const linked = codes.length
        ? await EmployeeBasic.find({ employeeId: { $in: codes } }).select("employeeId firstName lastName").lean()
        : [];
    const byCode = new Map(linked.map((employee) => [String(employee.employeeId), personName(employee)]));
    for (const user of users) {
        const name = byCode.get(String(user.employeeId || "")) || personRequesterName(user?.name) || "";
        if (name) names.set(String(user._id), name);
    }
    return names;
}

/**
 * One workflow task for this dashboard row.
 * The requester stays the employee who started it.
 * A later assignee change is written on the task history.
 */
export async function ensureEmployeeWorkflowTask(action, assignee, requestedByName, options = {}) {
    if (!action?._id || !action.assignedTo) return null;
    const forceWorkflow = Boolean(options?.forceWorkflow);
    if (!forceWorkflow && !employeeWorkflowType(action.requestType)) return null;

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

    const taskType = forceWorkflow ? "Workflow Task" : workflowTaskType(action.requestType);
    if (!keep) {
        return TaskManagerTask.create({
            sourceDashboardActionId: action._id,
            taskType,
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
    if (keep.taskType !== taskType) keep.taskType = taskType;
    if (options.lockRequester && requester) {
        if (keep.requestedByName !== requester) keep.requestedByName = requester;
    } else if (!personRequesterName(keep.requestedByName) && (requester || assigneeName)) {
        keep.requestedByName = requester || assigneeName;
    }
    const previousName = clean(keep.assigneeName);
    const assigneeChanged = String(keep.assignee || "") !== String(action.assignedTo || "");
    if (assigneeChanged || finished) {
        keep.assignee = action.assignedTo;
        keep.assigneeEmpId = action.assignedToEmpId || assignee?.employeeId || keep.assigneeEmpId || "";
        if (assigneeName) keep.assigneeName = assigneeName;
        pushHandoffHistory(keep, previousName, assigneeName || previousName);
    }
    if (action.extra1) keep.taskName = action.extra1;
    if (action.extra2) keep.description = action.extra2;
    await keep.save();
    return keep;
}

export async function finishWorkflowTasksForActions(actionIds, {
    taskStatus = "Completed",
    event = "Completed",
    detail = "",
    actorName = "",
} = {}) {
    const ids = (Array.isArray(actionIds) ? actionIds : []).filter(Boolean);
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

/** The active flowchart project coordinator, used as the requester on every project task. */
export async function activeProjectCoordinator() {
    const row = await Flowchart.findOne({ category: "projectcoordinator", status: "Active" })
        .sort({ updatedAt: -1 })
        .select("empObjectId employeeId employeeName")
        .lean();
    if (!row) return null;
    const id = String(row.empObjectId || "").trim();
    let employee = null;
    if (/^[a-f\d]{24}$/i.test(id)) {
        employee = await EmployeeBasic.findById(id)
            .select("firstName lastName profilePicture employeeId designation companyEmail workEmail phone")
            .lean();
    }
    if (!employee && row.employeeId) {
        employee = await EmployeeBasic.findOne({ employeeId: row.employeeId })
            .select("firstName lastName profilePicture employeeId designation companyEmail workEmail phone")
            .lean();
    }
    const name = personName(employee) || String(row.employeeName || "").trim();
    if (!name) return null;
    return { name, photo: employee?.profilePicture || "", employee };
}
