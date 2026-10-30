import DashboardAction from "../models/DashboardAction.js";
import EmployeeHubRequest from "../models/EmployeeHubRequest.js";
import TaskManagerTask from "../models/TaskManagerTask.js";
import { isGeneralHubRequestType } from "./employeeHubRequestTypes.js";
import { isObjectId } from "./taskManagerModule.js";

const OPEN_ACTION = new Set(["Pending", "On Hold", ""]);

export function generalHubClosures(actions, decisionByRequestId) {
    const approved = [];
    const rejected = [];
    for (const action of actions || []) {
        if (!isGeneralHubRequestType(action?.requestType)) continue;
        const status = String(action?.status || "Pending");
        if (!OPEN_ACTION.has(status)) continue;
        const decision = decisionByRequestId.get(String(action?.requestId || ""));
        if (decision === "Approved") approved.push(action);
        else if (decision === "Rejected") rejected.push(action);
    }
    return { approved, rejected };
}

function closeSnapshot(task) {
    const saved = task?.closeRequest?.toObject ? task.closeRequest.toObject() : (task?.closeRequest || {});
    return { ...saved };
}

function stageWasSaved(stage) {
    return Boolean(stage && (stage.assigneeId || String(stage.assigneeName || "").trim()));
}

/** The open stage, kept so a requester can reopen to the same assignee and status. */
export function stageBeforeHubClose(task) {
    const saved = closeSnapshot(task);
    if (stageWasSaved(saved.stageBeforeClose)) return saved.stageBeforeClose;
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

async function closeLinkedHubTasks(actionIds, decision) {
    if (!actionIds.length) return;
    const tasks = await TaskManagerTask.find({
        sourceDashboardActionId: { $in: actionIds },
        status: { $nin: ["Completed", "Cancelled", "Rejected"] },
    });
    const now = new Date();
    await Promise.all(tasks.map(async (task) => {
        if (decision === "Rejected") {
            task.status = "Rejected";
        } else {
            const stage = stageBeforeHubClose(task);
            const saved = closeSnapshot(task);
            task.status = "Completed";
            task.closeRequest = {
                ...saved,
                closedAt: saved.closedAt || now,
                reviewPending: false,
                completesAt: null,
                stageBeforeClose: stage,
            };
            task.markModified("closeRequest");
        }
        await task.save();
    }));
}

async function persistHubClosures({ approved, rejected }) {
    const now = new Date();
    const jobs = [];
    if (approved.length) {
        const actionIds = approved.map((action) => action._id).filter(Boolean);
        for (const action of approved) {
            action.status = "Approved";
            if (!action.actionedDate) action.actionedDate = now;
        }
        if (actionIds.length) {
            jobs.push(DashboardAction.updateMany(
                { _id: { $in: actionIds }, status: { $in: ["Pending", "On Hold"] } },
                { $set: { status: "Approved", actionedDate: now } },
            ));
            jobs.push(closeLinkedHubTasks(actionIds, "Approved"));
        }
    }
    if (rejected.length) {
        const actionIds = rejected.map((action) => action._id).filter(Boolean);
        for (const action of rejected) {
            action.status = "Rejected";
            if (!action.actionedDate) action.actionedDate = now;
        }
        if (actionIds.length) {
            jobs.push(DashboardAction.updateMany(
                { _id: { $in: actionIds }, status: { $in: ["Pending", "On Hold"] } },
                { $set: { status: "Rejected", actionedDate: now } },
            ));
            jobs.push(closeLinkedHubTasks(actionIds, "Rejected"));
        }
    }
    if (jobs.length) await Promise.all(jobs);
}

/** An approved or rejected Salary Certificate, Early Salary, or Assets request closes its task. */
export async function alignDecidedGeneralHubTasks(actions = []) {
    const open = (actions || []).filter((action) => (
        isGeneralHubRequestType(action?.requestType)
        && OPEN_ACTION.has(String(action?.status || "Pending"))
        && isObjectId(action?.requestId)
    ));
    if (!open.length) return { approved: [], rejected: [] };
    const ids = [...new Set(open.map((action) => String(action.requestId)))];
    const rows = await EmployeeHubRequest.find({
        _id: { $in: ids },
        status: { $in: ["Approved", "Rejected"] },
    }).select("status").lean();
    const decisionByRequestId = new Map(rows.map((row) => [String(row._id), row.status]));
    const plan = generalHubClosures(open, decisionByRequestId);
    await persistHubClosures(plan);
    return plan;
}

export function applyHubDecisionToTask(task, decision) {
    if (!task) return;
    const status = String(task.status || "");
    if (["Completed", "Cancelled", "Rejected"].includes(status)) return;
    if (decision === "Approved") task.status = "Completed";
    else if (decision === "Rejected") task.status = "Rejected";
}

/** Close the task row after the reportee approves or rejects, including a reassigned copy. */
export async function finishGeneralHubTask(requestId, requestType, decision) {
    if (!isGeneralHubRequestType(requestType) || !isObjectId(requestId)) return;
    if (decision !== "Approved" && decision !== "Rejected") return;
    const actions = await DashboardAction.find({
        requestId,
        requestType,
        status: { $in: ["Pending", "On Hold"] },
    }).select("_id requestId requestType status actionedDate");
    const plan = generalHubClosures(actions, new Map([[String(requestId), decision]]));
    await persistHubClosures(plan);
    const linked = await DashboardAction.find({ requestId, requestType }).select("_id").lean();
    const ids = linked.map((action) => action._id);
    if (!ids.length) return;
    await closeLinkedHubTasks(ids, decision);
}
