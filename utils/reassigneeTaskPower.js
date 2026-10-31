import mongoose from "mongoose";
import DashboardAction from "../models/DashboardAction.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import TaskManagerTask from "../models/TaskManagerTask.js";

const CLOSED_TASK = new Set(["Completed", "Cancelled", "Rejected"]);

export function parseActionMeta(extra3) {
    if (!extra3) return {};
    if (typeof extra3 === "object") return extra3;
    try {
        const parsed = JSON.parse(String(extra3));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

export function publicActionMeta(extra3) {
    const meta = parseActionMeta(extra3);
    return {
        serviceRecordId: String(meta.serviceRecordId || meta.serviceId || ""),
        dispositionViewerRole: String(meta.dispositionViewerRole || ""),
        oilStage: String(meta.oilStage || meta.pendingStage || ""),
    };
}

/** Open task that was reassigned and has not been given back or released. */
export function isOpenReassignedTask(task) {
    if (!task) return false;
    if (CLOSED_TASK.has(String(task.status || ""))) return false;
    if (task.closeRequest?.reassignmentReleased) return false;
    const originalId = task.closeRequest?.originalAssigneeId;
    const originalName = String(task.closeRequest?.originalAssigneeName || "").trim();
    const historyReassigned = (task.history || []).some((item) => item?.event === "Reassigned");
    return Boolean(originalId || originalName || historyReassigned);
}

export function viewerIsTaskAssignee(task, viewer) {
    const assigneeId = String(task?.assignee || "");
    const ids = [viewer?.employeeObjectId, viewer?.userId, viewer?.id]
        .map((value) => String(value || "").trim())
        .filter(Boolean);
    if (assigneeId && ids.includes(assigneeId)) return true;
    const code = String(task?.assigneeEmpId || "").trim().toLowerCase();
    const viewerCode = String(viewer?.employeeId || "").trim().toLowerCase();
    return Boolean(code && viewerCode && code === viewerCode);
}

/**
 * serviceId must match the service on the dashboard row.
 * metaField/metaValue match one field inside extra3, such as dispositionViewerRole.
 */
export function actionMatchesFilters(action, { serviceId = "", requestType = "", metaField = "", metaValue = "" } = {}) {
    if (requestType && String(action?.requestType || "") !== String(requestType)) return false;
    const meta = parseActionMeta(action?.extra3);
    const wantedService = String(serviceId || "").trim();
    if (wantedService) {
        const sid = String(meta.serviceRecordId || meta.serviceId || "").trim();
        if (sid !== wantedService) return false;
    }
    const field = String(metaField || "").trim();
    const value = String(metaValue || "").trim().toLowerCase();
    if (field && value) {
        if (String(meta[field] || "").trim().toLowerCase() !== value) return false;
    }
    return true;
}

function objectIdList(values) {
    return [...new Set(
        (values || [])
            .map((value) => String(value || "").trim())
            .filter((id) => mongoose.Types.ObjectId.isValid(id)),
    )];
}

export async function resolvePowerViewer(reqUser) {
    if (!reqUser) return { employeeObjectId: "", userId: "", employeeId: "" };
    let employeeObjectId = reqUser.employeeObjectId ? String(reqUser.employeeObjectId) : "";
    const userId = String(reqUser.id || reqUser._id || "");
    if (!employeeObjectId && reqUser.actor === "employee" && mongoose.Types.ObjectId.isValid(userId)) {
        employeeObjectId = userId;
    }
    const employeeId = String(reqUser.employeeId || "").trim();
    if (!employeeObjectId && employeeId) {
        const emp = await EmployeeBasic.findOne({ employeeId }).select("_id").lean();
        if (emp?._id) employeeObjectId = String(emp._id);
    }
    return { employeeObjectId, userId, employeeId };
}

/**
 * Pending source tasks this person currently holds because someone reassigned them.
 * The power is only for those request ids, and only while the reassignment is still open.
 */
export async function findInheritedTaskActions(reqUser, requestIds = null, options = {}) {
    if (Array.isArray(requestIds) && requestIds.length === 0) return [];
    const viewer = await resolvePowerViewer(reqUser);
    const assigneeOr = [];
    if (mongoose.Types.ObjectId.isValid(viewer.employeeObjectId)) {
        assigneeOr.push({ assignee: viewer.employeeObjectId });
    }
    if (
        mongoose.Types.ObjectId.isValid(viewer.userId)
        && viewer.userId !== viewer.employeeObjectId
    ) {
        assigneeOr.push({ assignee: viewer.userId });
    }
    if (viewer.employeeId) assigneeOr.push({ assigneeEmpId: viewer.employeeId });
    if (!assigneeOr.length) return [];

    const tasks = await TaskManagerTask.find({
        status: { $nin: [...CLOSED_TASK] },
        "closeRequest.reassignmentReleased": { $ne: true },
        sourceDashboardActionId: { $ne: null },
        $or: assigneeOr,
    })
        .select("assignee assigneeEmpId status sourceDashboardActionId closeRequest.originalAssigneeId closeRequest.originalAssigneeName closeRequest.reassignmentReleased history.event")
        .lean();

    const openTasks = tasks.filter((task) => isOpenReassignedTask(task) && viewerIsTaskAssignee(task, viewer));
    const actionIds = objectIdList(openTasks.map((task) => task.sourceDashboardActionId));
    if (!actionIds.length) return [];

    const actions = await DashboardAction.find({
        _id: { $in: actionIds },
        status: "Pending",
    })
        .select("requestId requestType extra3")
        .lean();

    const wanted = Array.isArray(requestIds)
        ? new Set(objectIdList(requestIds))
        : null;

    return actions
        .filter((action) => actionMatchesFilters(action, options))
        .filter((action) => !wanted || wanted.has(String(action.requestId)))
        .map((action) => ({
            requestId: String(action.requestId),
            requestType: String(action.requestType || ""),
            meta: publicActionMeta(action.extra3),
        }));
}

export async function viewerInheritsRequestAction(reqUser, requestId, options = {}) {
    const id = String(requestId || "").trim();
    if (!mongoose.Types.ObjectId.isValid(id)) return false;
    const rows = await findInheritedTaskActions(reqUser, [id], options);
    return rows.some((row) => row.requestId === id);
}

export const getInheritedTaskAction = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ message: "Unauthorized" });
        const raw = req.query.requestId ?? req.query.requestIds ?? "";
        const list = Array.isArray(raw) ? raw : String(raw).split(",");
        const requestIds = list.map((value) => String(value || "").trim()).filter(Boolean);
        const matches = await findInheritedTaskActions(req.user, requestIds, {
            serviceId: req.query.serviceId || "",
            requestType: req.query.requestType || "",
            metaField: req.query.metaField || "",
            metaValue: req.query.metaValue || "",
        });
        return res.status(200).json({
            canAct: matches.length > 0,
            requestIds: [...new Set(matches.map((row) => row.requestId))],
            matches,
        });
    } catch (error) {
        console.error("Inherited task action error:", error);
        return res.status(500).json({ message: "Failed to check reassigned task access" });
    }
};
