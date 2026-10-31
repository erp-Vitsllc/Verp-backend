import DashboardAction from "../models/DashboardAction.js";
import TaskManagerTask from "../models/TaskManagerTask.js";
import { listDeletedNoticeKeys, noticeKeysForRecord } from "./deletedTaskNotice.js";
import { isGeneralHubRequestType } from "./employeeHubRequestTypes.js";
import { evaluateSourceTaskCompletion } from "./sourceTaskCompletion.js";
import { activityTaskKey } from "./taskDuplicateKey.js";
import {
    canonicalTaskType,
    closeReassignmentNotices,
    isObjectId,
    syncManualTaskNotification,
} from "./taskManagerModule.js";

const OPEN_TASK = new Set(["Pending", "In Progress"]);
const OPEN_NOTICE = new Set(["Pending", "On Hold"]);
const CLOSED_TASK = new Set(["Completed", "Cancelled", "Rejected"]);
const QUIET_LIMIT = 60;
const SCAN_LIMIT = 40;

let vehicleCursor = 0;
let quietCursor = 0;
let restCursor = 0;
let tail = Promise.resolve();
let lastFinished = 0;

function systemRequestType(requestType, extra2 = "") {
    if (
        String(requestType || "").trim() === "Salary Enrollment"
        && String(extra2 || "").trim().toLowerCase() === "pending for enrollment"
    ) {
        return true;
    }
    return /expiry|not renew|card deleted|value missing|asset overdue|profile incomplete|payment reminder|fuel reminder/i.test(
        String(requestType || ""),
    );
}

function plainClose(task) {
    const saved = task?.closeRequest;
    if (!saved) return {};
    return typeof saved.toObject === "function" ? saved.toObject() : { ...saved };
}

function wasReopened(task) {
    const saved = plainClose(task);
    return Boolean(saved.reopenedAt) && !saved.closedAt;
}

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

/** System and workflow only. Salary Certificate, Early Salary, and Assets stay general. */
export function categoryForAutoComplete(task, action) {
    if (action && isGeneralHubRequestType(action.requestType)) return "General Task";
    if (action && String(action.requestType || "") !== "Task Manager") {
        if (systemRequestType(action.requestType, action.extra2)) return "System Task";
        const stored = canonicalTaskType(task?.taskType || "");
        if (stored === "System Task") return "System Task";
        return "Workflow Task";
    }
    return canonicalTaskType(task?.taskType || "");
}

/**
 * A system or workflow task becomes Completed when its record is finished,
 * or when no employee still has that work notification.
 * A deleted, rejected, cancelled, or reopened task is left as it is.
 * A record that is still pending stays pending, even if its bell was cleared.
 */
export function shouldAutoCompleteSystemWorkflowTask({
    category = "",
    status = "",
    actionStatus = "",
    deleted = false,
    reopened = false,
    sourceApplies = false,
    sourcePending = false,
    sourceFinished = false,
    workNoticePending = false,
    ownBellPending = false,
    hadNotice = false,
} = {}) {
    if (category !== "System Task" && category !== "Workflow Task") return false;
    if (deleted || reopened) return false;
    if (CLOSED_TASK.has(String(status || ""))) return false;
    if (actionStatus === "Rejected" || actionStatus === "Cancelled") return false;
    if (sourceApplies && sourcePending && !sourceFinished) return false;
    if (sourceFinished) return true;
    if (workNoticePending || ownBellPending || OPEN_NOTICE.has(String(actionStatus || ""))) return false;
    return Boolean(hadNotice);
}

function stageBeforeClose(task) {
    const saved = plainClose(task);
    const stage = saved.stageBeforeClose;
    if (stage && (stage.assigneeId || String(stage.assigneeName || "").trim())) return stage;
    return {
        status: String(task?.status || "Pending"),
        assigneeId: task?.assignee || null,
        assigneeEmpId: task?.assigneeEmpId || "",
        assigneeName: task?.assigneeName || "",
        completionRequestedAt: saved.completionRequestedAt || null,
        completionRequestedById: saved.completionRequestedById || null,
        completionRequestedByName: saved.completionRequestedByName || "",
        completionNote: saved.completionNote || "",
        reassignmentReleased: Boolean(saved.reassignmentReleased),
        reviewPending: Boolean(saved.reviewPending),
        reviewReturned: Boolean(saved.reviewReturned),
        returnAssigneeId: saved.returnAssigneeId || null,
        returnAssigneeEmpId: saved.returnAssigneeEmpId || "",
        returnAssigneeName: saved.returnAssigneeName || "",
    };
}

function groupKey(action, task, category) {
    if (!action) return task?._id ? `task:${task._id}` : "";
    const key = activityTaskKey(action, { system: category === "System Task" });
    return key || `action:${action._id}`;
}

function deletedAction(action, deletedKeys) {
    if (!action || !deletedKeys?.size) return false;
    return noticeKeysForRecord(action).some((key) => deletedKeys.has(key));
}

function takeRotated(list, cursor, limit) {
    if (!list.length || limit <= 0) return { rows: [], cursor };
    const start = cursor % list.length;
    const count = Math.min(limit, list.length);
    const rows = [];
    for (let index = 0; index < count; index += 1) rows.push(list[(start + index) % list.length]);
    return { rows, cursor: (start + count) % list.length };
}

function pickGroups(groups, scoped) {
    if (scoped || groups.length <= QUIET_LIMIT + SCAN_LIMIT) return groups;
    const vehicles = [];
    const quiet = [];
    const rest = [];
    for (const group of groups) {
        const type = String(group.actions[0]?.requestType || group.pending[0]?.requestType || "");
        if (type === "Vehicle Service Request") vehicles.push(group);
        else if (group.tasks.length && group.pending.length === 0) quiet.push(group);
        else rest.push(group);
    }
    const vehiclePick = takeRotated(vehicles, vehicleCursor, SCAN_LIMIT);
    const quietPick = takeRotated(quiet, quietCursor, QUIET_LIMIT);
    const restPick = takeRotated(rest, restCursor, SCAN_LIMIT);
    vehicleCursor = vehiclePick.cursor;
    quietCursor = quietPick.cursor;
    restCursor = restPick.cursor;
    return [...vehiclePick.rows, ...quietPick.rows, ...restPick.rows];
}

async function loadWorkRows(requestIds) {
    const ids = [...new Set((requestIds || []).map((id) => String(id || "")).filter(isObjectId))];
    if (!ids.length) return [];
    return DashboardAction.find({
        requestId: { $in: ids },
        requestType: { $ne: "Task Manager" },
        status: { $in: [...OPEN_NOTICE] },
    })
        .select("requestId requestType status extra1 extra2 extra3 subjectEmployeeId subjectName assignedTo assignedToEmpId requestedByName")
        .lean();
}

async function persistCompleted(task) {
    if (!task?._id || !OPEN_TASK.has(String(task.status || ""))) return false;
    const now = new Date();
    const saved = plainClose(task);
    const closeRequest = {
        ...saved,
        closedAt: saved.closedAt || now,
        reviewPending: false,
        completesAt: null,
        stageBeforeClose: stageBeforeClose(task),
    };
    const history = {
        event: "Completed",
        detail: "The related work is finished. The status is Completed.",
        actorName: "Task Manager",
        createdAt: now,
    };
    if (typeof task.save === "function") {
        task.status = "Completed";
        task.closeRequest = closeRequest;
        task.history = task.history || [];
        task.history.push(history);
        task.markModified?.("closeRequest");
        await task.save();
        return true;
    }
    const updated = await TaskManagerTask.updateOne(
        { _id: task._id, status: { $in: [...OPEN_TASK] } },
        { $set: { status: "Completed", closeRequest }, $push: { history } },
    );
    if (!updated.modifiedCount && !updated.nModified) return false;
    task.status = "Completed";
    task.closeRequest = closeRequest;
    return true;
}

function rememberApproved(row) {
    if (!row || row.status === "Rejected" || row.status === "Cancelled") return;
    row.status = "Approved";
    if (!row.actionedDate) row.actionedDate = new Date();
}

async function dismissWorkRows(rows, mirrors) {
    const ids = (rows || []).map((row) => row?._id).filter(Boolean);
    if (!ids.length) return;
    await DashboardAction.updateMany(
        { _id: { $in: ids }, status: { $in: [...OPEN_NOTICE] } },
        { $set: { status: "Approved", actionedDate: new Date() } },
    );
    for (const row of rows || []) {
        rememberApproved(row);
        const mirror = mirrors?.get(String(row?._id || ""));
        if (mirror && mirror !== row) rememberApproved(mirror);
    }
}

async function dismissTaskBars(task) {
    if (!task?._id) return;
    try {
        await closeReassignmentNotices(task);
    } catch (error) {
        console.error("Clear reassignment notices:", error?.message || error);
    }
    const id = String(task._id);
    const or = [{ requestId: task._id }];
    if (isObjectId(id)) {
        or.push({ extra3: new RegExp(`"taskManagerId"\\s*:\\s*"${id}"`) });
        or.push({ extra3: new RegExp(`"taskKey"\\s*:\\s*"(?:manual-)?${id}"`) });
    }
    await DashboardAction.updateMany(
        { requestType: "Task Manager", status: { $in: [...OPEN_NOTICE] }, $or: or },
        { $set: { status: "Dismissed", actionedDate: new Date() } },
    );
    if (!task.sourceDashboardActionId && task.status === "Completed") {
        try {
            await syncManualTaskNotification(task);
        } catch (error) {
            console.error("Clear manual task notification:", error?.message || error);
        }
    }
}

/** After a person completes a system or workflow task, take it off every notification bar. */
export async function releaseCompletedTaskFromNotificationBars(task, action = null) {
    if (!task || task.status !== "Completed") return;
    const category = categoryForAutoComplete(task, action);
    if (category !== "System Task" && category !== "Workflow Task") return;
    let source = action && String(action.requestType || "") !== "Task Manager" ? action : null;
    if (!source && isObjectId(task.sourceDashboardActionId)) {
        source = await DashboardAction.findById(task.sourceDashboardActionId)
            .select("requestId requestType status extra1 extra2 extra3 subjectEmployeeId subjectName assignedTo assignedToEmpId requestedByName")
            .lean();
    }
    if (source && !deletedAction(source, new Set(await listDeletedNoticeKeys()))) {
        const pending = await loadWorkRows([source.requestId]);
        const categoryKey = categoryForAutoComplete(task, source);
        const key = groupKey(source, task, categoryKey);
        const matches = pending.filter((row) => groupKey(row, task, categoryKey) === key);
        if (OPEN_NOTICE.has(String(source.status || "")) && !matches.some((row) => String(row._id) === String(source._id))) {
            matches.push(source);
        }
        await dismissWorkRows(matches);
    }
    await dismissTaskBars(task);
}

async function loadScope(options) {
    if (options.requestId) {
        const filter = { requestId: options.requestId };
        if (options.requestType) filter.requestType = options.requestType;
        const actions = await DashboardAction.find(filter)
            .select("requestId requestType status extra1 extra2 extra3 subjectEmployeeId subjectName assignedTo assignedToEmpId requestedByName actionedDate")
            .lean();
        const ids = actions.map((action) => action._id).filter(Boolean);
        const tasks = ids.length
            ? await TaskManagerTask.find({
                sourceDashboardActionId: { $in: ids },
                status: { $in: [...OPEN_TASK] },
            })
            : [];
        return { actions, tasks, scoped: true };
    }

    const tasks = Array.isArray(options.tasks)
        ? options.tasks
        : await TaskManagerTask.find({
            taskType: { $in: ["System Task", "Workflow Task", "Work Flow Task"] },
            status: { $in: [...OPEN_TASK] },
        })
            .select("taskType status assignee assigneeEmpId assigneeName sourceDashboardActionId closeRequest")
            .limit(250);

    if (Array.isArray(options.actions)) {
        return { actions: options.actions, tasks, scoped: false };
    }

    const sourceIds = tasks.map((task) => task.sourceDashboardActionId).filter((id) => isObjectId(id));
    const sources = sourceIds.length
        ? await DashboardAction.find({ _id: { $in: sourceIds } })
            .select("requestId requestType status extra1 extra2 extra3 subjectEmployeeId subjectName assignedTo assignedToEmpId requestedByName actionedDate")
            .lean()
        : [];
    const pending = await DashboardAction.find({
        status: { $in: [...OPEN_NOTICE] },
        requestType: { $ne: "Task Manager" },
    })
        .select("requestId requestType status extra1 extra2 extra3 subjectEmployeeId subjectName assignedTo assignedToEmpId requestedByName actionedDate")
        .limit(400)
        .lean();
    const seen = new Set(sources.map((action) => String(action._id)));
    const actions = [...sources];
    for (const row of pending) {
        if (!seen.has(String(row._id))) actions.push(row);
    }
    return { actions, tasks, scoped: false };
}

async function execute(options) {
    const { actions, tasks, scoped } = await loadScope(options);
    const openTasks = (tasks || []).filter((task) => OPEN_TASK.has(String(task.status || "")));
    const actionById = new Map((actions || []).map((action) => [String(action._id), action]));
    const deletedKeys = new Set(await listDeletedNoticeKeys());
    const groups = new Map();

    const add = (action, task) => {
        const category = categoryForAutoComplete(task, action);
        if (category !== "System Task" && category !== "Workflow Task") return;
        const key = groupKey(action, task, category);
        if (!key) return;
        const group = groups.get(key) || { key, category, actions: [], tasks: [], pending: [] };
        if (action && !group.actions.some((row) => String(row._id) === String(action._id))) group.actions.push(action);
        if (task && !group.tasks.some((row) => String(row._id) === String(task._id))) group.tasks.push(task);
        groups.set(key, group);
    };

    for (const task of openTasks) {
        const action = actionById.get(String(task.sourceDashboardActionId || "")) || null;
        add(action, task);
    }
    for (const action of actions || []) {
        if (String(action?.requestType || "") === "Task Manager") continue;
        if (!OPEN_NOTICE.has(String(action?.status || ""))) continue;
        add(action, null);
    }

    const requestIds = [];
    for (const group of groups.values()) {
        for (const action of group.actions) requestIds.push(action.requestId);
    }
    const pendingRows = await loadWorkRows(requestIds);
    for (const row of pendingRows) {
        const category = categoryForAutoComplete(null, row);
        const key = groupKey(row, null, category);
        const group = groups.get(key);
        if (!group) continue;
        if (!group.pending.some((item) => String(item._id) === String(row._id))) group.pending.push(row);
    }
    for (const group of groups.values()) {
        for (const action of group.actions) {
            if (!OPEN_NOTICE.has(String(action.status || ""))) continue;
            if (!group.pending.some((item) => String(item._id) === String(action._id))) group.pending.push(action);
        }
    }

    const manualTasks = [...groups.values()].flatMap((group) => (
        group.actions.length ? [] : group.tasks
    ));
    const manualIds = manualTasks.map((task) => task._id).filter(Boolean);
    const bells = manualIds.length
        ? await DashboardAction.find({
            requestType: "Task Manager",
            requestId: { $in: manualIds },
        }).select("requestId status extra3").lean()
        : [];
    const bellsByTask = new Map();
    for (const bell of bells) {
        const id = String(bell.requestId || "");
        const list = bellsByTask.get(id) || [];
        list.push(bell);
        bellsByTask.set(id, list);
    }

    const chosen = pickGroups([...groups.values()], scoped);
    let completed = 0;
    for (const group of chosen) {
        try {
            if (group.actions.some((action) => deletedAction(action, deletedKeys))) continue;
            if (group.tasks.some((task) => wasReopened(task))) continue;
            if (group.actions.some((action) => action.status === "Rejected" || action.status === "Cancelled") && !group.pending.length) {
                continue;
            }
            const sample = group.pending[0] || group.actions[0] || null;
            const sampleTask = group.tasks[0] || null;
            const gate = sample
                ? await evaluateSourceTaskCompletion(
                    { task: sampleTask, action: sample },
                    { category: group.category, action: sample },
                )
                : { applies: false, pending: false, status: "" };
            const sourceFinished = Boolean(
                gate.applies && !gate.pending && (gate.status === "Completed" || gate.status === "Closed"),
            );
            const task = sampleTask;
            const ownBells = task ? (bellsByTask.get(String(task._id)) || []) : [];
            const ownWorkBells = ownBells.filter((bell) => !readMeta(bell.extra3).reassignedNotice);
            const decision = shouldAutoCompleteSystemWorkflowTask({
                category: group.category,
                status: task?.status || "Pending",
                actionStatus: sample?.status || "",
                deleted: false,
                reopened: false,
                sourceApplies: Boolean(gate.applies),
                sourcePending: Boolean(gate.applies && gate.pending),
                sourceFinished,
                workNoticePending: group.pending.length > 0,
                ownBellPending: ownWorkBells.some((bell) => OPEN_NOTICE.has(String(bell.status || ""))),
                hadNotice: Boolean(sample) || ownBells.length > 0,
            });
            if (!decision) continue;
            let finishedTasks = 0;
            for (const openTask of group.tasks) {
                if (CLOSED_TASK.has(String(openTask.status || "")) || wasReopened(openTask)) continue;
                const saved = await persistCompleted(openTask);
                if (!saved) continue;
                finishedTasks += 1;
                completed += 1;
                await dismissTaskBars(openTask);
            }
            if (sourceFinished && (finishedTasks > 0 || !group.tasks.length)) {
                await dismissWorkRows(group.pending, actionById);
            }
        } catch (error) {
            console.error("Complete system or workflow task:", error?.message || error);
        }
    }
    return { completed };
}

/** Mark finished system and workflow tasks Completed, and clear them from every notification bar. */
export function completeFinishedSystemWorkflowTasks(options = {}) {
    const job = tail.then(async () => {
        if (!options.force && Date.now() - lastFinished < 4000) return { skipped: true, completed: 0 };
        try {
            return await execute(options);
        } catch (error) {
            console.error("Complete finished system and workflow tasks:", error?.message || error);
            return { completed: 0 };
        } finally {
            lastFinished = Date.now();
        }
    });
    tail = job.then(() => {}, () => {});
    return job;
}
