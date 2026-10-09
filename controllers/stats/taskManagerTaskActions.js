import DashboardAction from "../../models/DashboardAction.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import TaskManagerTask from "../../models/TaskManagerTask.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import { emailFrontendUrl } from "../../utils/resolveFrontendBaseUrl.js";
import { findEmailsForTask } from "../../utils/emailDispatch.js";
import {
    displayStatus,
    taskCategory as categoryFromRequestType,
    viewerMaySeeAllNotifications,
} from "./getTaskManagerNotifications.js";
import {
    accessPathFor,
    canonicalTaskType,
    contactCard,
    displayTaskType,
    isObjectId,
    loadPeopleDetails,
    moduleForRequestType,
    moduleForText,
    peopleIndex,
    personName,
    resolveTaskViewer,
    sendTaskActivityEmail,
    sendTaskReassignedEmail,
    syncManualTaskNotification,
    viewerCanReassign,
} from "../../utils/taskManagerModule.js";

const DUBAI_DATE = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});

function dubaiDateKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!value || Number.isNaN(date.getTime())) return "";
    return DUBAI_DATE.format(date);
}

function detailDisplayStatus(task, action, manual) {
    if (manual && task) {
        if (task.status === "Completed" || task.status === "Cancelled" || task.status === "In Progress") {
            return task.status;
        }
        const dueKey = dubaiDateKey(task.completionDate);
        const todayKey = dubaiDateKey(new Date());
        if (dueKey && dueKey <= todayKey) return "Pending Due";
        return "Pending";
    }
    return displayStatus(
        action?.status,
        action?.requestType,
        dubaiDateKey(action?.requestedDate || action?.createdAt),
        dubaiDateKey(new Date()),
    );
}

const PRIORITIES = new Set(["High", "Medium", "Low"]);
const STATUSES = new Set(["Pending", "In Progress", "Completed", "Cancelled"]);

function parseCompletionDate(value) {
    const text = String(value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const date = new Date(`${text}T12:00:00+04:00`);
    return Number.isNaN(date.getTime()) ? null : date;
}

function historyEntry(event, detail, actorName) {
    return { event, detail, actorName, createdAt: new Date() };
}

const RELATED_LABELS = {
    leave: "Leave Management",
    attendance: "Attendance",
    fine: "Fine Management",
    loan: "Loan and Advance",
    salary: "Salary",
    reward: "Reward",
    vehicle: "Vehicle",
    utility: "Utility Bills",
    tools: "Tools Asset",
    payment: "Payments",
    company: "Company",
    employees: "Employees",
    general: "Task Manager",
};

function relatedLabel(moduleName, fallback) {
    return RELATED_LABELS[moduleName] || fallback || "Task Manager";
}

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function sanitizeComment(value) {
    return String(value || "")
        .replace(/<(?!\/?(b|strong|i|em|br)\b)[^>]*>/gi, "")
        .replace(/javascript:/gi, "")
        .trim();
}

function plainText(value) {
    return String(value || "")
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, "")
        .trim();
}

async function authorRoleFor(viewer) {
    if (!isObjectId(viewer?.employeeObjectId)) return "";
    const emp = await EmployeeBasic.findById(viewer.employeeObjectId).select("designation").lean();
    return emp?.designation || "";
}

async function notifyParties(task, { notifyKind, subject, html }) {
    const settings = task?.notifications || {};
    const enabled = notifyKind === "comment" ? settings.comment !== false : settings.workUpdate !== false;
    const result = {
        emailSent: false,
        assigneeNotified: false,
        requesterNotified: false,
        assigneeName: task?.assigneeName || "",
        requesterName: task?.requestedByName || "",
    };
    if (!enabled) return result;
    const assignee = isObjectId(task?.assignee) ? await findAssignee(String(task.assignee)) : null;
    const requester = await findEmployeeByName(task?.requestedByName);
    if (!result.assigneeName) result.assigneeName = personName(assignee);
    if (!result.requesterName) result.requesterName = personName(requester);
    const assigneeEmail = assignee?.companyEmail || assignee?.workEmail || "";
    const requesterEmail = requester?.companyEmail || requester?.workEmail || "";
    const to = [...new Set([assigneeEmail, requesterEmail].map((item) => String(item || "").trim()).filter(Boolean))];
    if (!to.length) return result;
    try {
        const sent = await sendTaskActivityEmail({
            to,
            subject,
            html,
            recordId: String(task?.sourceDashboardActionId || task?._id || ""),
            emailType: notifyKind === "comment" ? "Task comment" : "Task update",
        });
        result.emailSent = Boolean(sent.sent);
        if (result.emailSent) {
            result.assigneeNotified = Boolean(assigneeEmail);
            result.requesterNotified = Boolean(requesterEmail);
        }
    } catch (error) {
        console.error("Task activity email failed:", error);
    }
    return result;
}

async function pushWorkUpdate(task, entry, preparedMail = null) {
    const mail = preparedMail || await notifyParties(task, {
        notifyKind: "workUpdate",
        subject: `Task Updated: ${task.taskName || "Task"}`,
        html: `
            <p>The following task has been updated:</p>
            <p><strong>Task Name:</strong> ${escapeHtml(task.taskName)}</p>
            <p><strong>Update By:</strong> ${escapeHtml(entry.authorName)}</p>
            <p><strong>Update Details:</strong> ${escapeHtml(entry.text)}</p>
            <p><strong>Current Status:</strong> ${escapeHtml(task.status || "Pending")}</p>
        `,
    });
    task.updates = task.updates || [];
    task.updates.push({ ...entry, ...mail, createdAt: new Date() });
}

async function notifyWorkUpdateAudience(task, { text, authorName, mentionIds, accessPath }) {
    const settings = task?.notifications || {};
    const result = {
        emailSent: false,
        assigneeNotified: false,
        requesterNotified: false,
        assigneeName: task?.assigneeName || "",
        requesterName: task?.requestedByName || "",
    };
    if (settings.workUpdate === false) return result;
    const ids = [...new Set((Array.isArray(mentionIds) ? mentionIds : []).map((id) => String(id || "")).filter(isObjectId))];
    let people = [];
    if (ids.length) {
        people = await EmployeeBasic.find({ _id: { $in: ids }, status: { $ne: "Left User" } })
            .select("firstName lastName companyEmail workEmail")
            .lean();
    } else if (isObjectId(task?.assignee)) {
        const assignee = await findAssignee(String(task.assignee));
        if (assignee) people = [assignee];
    }
    const to = [...new Set(people.map((person) => person.companyEmail || person.workEmail).map((item) => String(item || "").trim()).filter(Boolean))];
    if (!to.length) return result;
    const taskKey = task?.sourceDashboardActionId ? String(task.sourceDashboardActionId) : `manual-${task?._id || ""}`;
    const taskLink = `${emailFrontendUrl()}/task-manager/${encodeURIComponent(taskKey)}`;
    const sectionLink = accessPath ? `${emailFrontendUrl()}${accessPath.startsWith("/") ? accessPath : `/${accessPath}`}` : "";
    try {
        const sent = await sendTaskActivityEmail({
            to,
            subject: `Task Updated: ${task.taskName || "Task"}`,
            recordId: String(task?.sourceDashboardActionId || task?._id || ""),
            emailType: "Work update",
            html: `
                <p>${escapeHtml(authorName || "Someone")} added a work update.</p>
                <p><strong>${escapeHtml(task.taskName || "Task")}</strong></p>
                <p>${escapeHtml(text)}</p>
                <p><a href="${escapeHtml(taskLink)}">Open the task</a></p>
                ${sectionLink ? `<p><a href="${escapeHtml(sectionLink)}">Open the related page</a></p>` : ""}
            `,
        });
        result.emailSent = Boolean(sent.sent);
        result.assigneeNotified = Boolean(result.emailSent && !ids.length);
    } catch (error) {
        console.error("Task work update email failed:", error);
    }
    return result;
}

async function denyUnlessViewer(req, res) {
    if (await viewerMaySeeAllNotifications(req)) return true;
    res.status(403).json({ message: "Access denied. HRM view permission is required." });
    return false;
}

async function loadTarget(taskKey) {
    const raw = decodeURIComponent(String(taskKey || ""));
    const manualId = raw.startsWith("manual-") ? raw.slice("manual-".length) : "";
    if (manualId && isObjectId(manualId)) {
        const task = await TaskManagerTask.findById(manualId);
        return task ? { kind: "manual", task, action: null } : null;
    }
    if (!isObjectId(raw)) return null;
    const action = await DashboardAction.findById(raw);
    if (action?.requestType === "Task Manager" && action.requestId) {
        const task = await TaskManagerTask.findById(action.requestId);
        if (task && !task.sourceDashboardActionId) return { kind: "manual", task, action };
    }
    const overlay = await TaskManagerTask.findOne({ sourceDashboardActionId: raw });
    if (action) return { kind: "dashboard", task: overlay, action };
    const task = await TaskManagerTask.findById(raw);
    return task ? { kind: "manual", task, action: null } : null;
}

function viewerIsCurrentAssignee(viewer, current) {
    const assigneeId = String(current?.assigneeId || "");
    if (assigneeId && viewer?.employeeObjectId && assigneeId === String(viewer.employeeObjectId)) return true;
    if (assigneeId && viewer?.userId && assigneeId === String(viewer.userId)) return true;
    const code = String(current?.assigneeEmpId || "").trim().toLowerCase();
    return Boolean(code && viewer?.employeeId && code === String(viewer.employeeId).trim().toLowerCase());
}

async function nameOfAssignee(current, fallback = "") {
    const person = isObjectId(current?.assigneeId) ? await findAssignee(current.assigneeId) : null;
    return personName(person) || String(fallback || "").trim();
}

function requesterWithAssigner(baseName, assignerName) {
    const assigner = String(assignerName || "").trim();
    const base = String(baseName || "").trim().replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (!assigner) return base;
    if (!base || base.toLowerCase() === assigner.toLowerCase()) return assigner;
    return `${base} (${assigner})`;
}

function assigneeOf(target) {
    if (target.kind === "manual") {
        return {
            assigneeId: String(target.task.assignee || ""),
            assigneeEmpId: target.task.assigneeEmpId || "",
        };
    }
    const overlay = target.task;
    return {
        assigneeId: String(overlay?.assignee || target.action.assignedTo || ""),
        assigneeEmpId: overlay?.assigneeEmpId || target.action.assignedToEmpId || "",
    };
}

async function buildDetail(target, viewer) {
    const manual = target.kind === "manual";
    const task = target.task;
    const action = target.action;
    const assigneeId = manual ? task.assignee : task?.assignee || action.assignedTo;
    const assigneeCode = manual ? task.assigneeEmpId : task?.assigneeEmpId || action.assignedToEmpId;
    const people = await loadPeopleDetails([assigneeId], [assigneeCode]);
    const { byId, byCode } = peopleIndex(people);
    const assigneeEmp = byId.get(String(assigneeId || "")) || byCode.get(String(assigneeCode || "")) || null;
    const requesterName = String(task?.requestedByName || action?.requestedByName || "").trim() || "System";
    const requester = await findEmployeeByName(requesterName);
    const destination = manual
        ? moduleForText(task.taskName, task.description, task.taskType)
        : moduleForRequestType(action.requestType, `${action.extra1 || ""} ${action.extra2 || ""}`);
    const cardAssignee = contactCard(assigneeEmp);
        if (!cardAssignee.name) cardAssignee.name = task?.assigneeName || "Unassigned";
    const cardRequester = contactCard(requester);
    if (!cardRequester.name) cardRequester.name = requesterName;

    const { assigneeId: currentAssigneeId, assigneeEmpId } = assigneeOf(target);
    const workflowLocked = !manual && action?.requestType !== "Task Manager";
    const taskTitle = String(task?.taskName || action?.extra1 || "").trim();
    const focusMatch = taskTitle.match(/expiry follow-up required:\s*(.+?)(?:\s*\(exp:|$)/i);
    const broadRecord = /expiry|reminder/i.test(String(action?.requestType || ""));
    const emails = await findEmailsForTask({
        ids: [action?._id, action?.requestId, task?._id, task?.sourceDashboardActionId],
        prefixes: broadRecord ? [action?.requestId] : [],
        focus: focusMatch ? focusMatch[1].trim() : "",
    });

    return {
        actionId: manual ? `manual-${task._id}` : String(action._id),
        manual,
        workflowLocked,
        canReassign: viewerCanReassign(viewer, currentAssigneeId, assigneeEmpId),
        canDelete: Boolean(
            viewer?.superUser
            || (manual && (
                task?.requestedByUserId
                    ? viewer?.userId && String(task.requestedByUserId) === String(viewer.userId)
                    : (
                        String(task?.requestedByName || "").trim()
                        && String(task.requestedByName).trim().toLowerCase() === String(viewer?.name || "").trim().toLowerCase()
                    )
            )),
        ),
        accessPath: accessPathFor(
            destination,
            manual ? "" : action?.requestId,
            manual ? "" : action?.subjectEmployeeId,
        ),
        taskName: (task?.taskName || action?.extra1 || "Task").trim(),
        description: task?.description || (manual ? "" : action?.extra2 || ""),
        taskCategory: manual
            ? (displayTaskType(task?.taskType) || "General Task")
            : categoryFromRequestType(action?.requestType, action?.extra2 || ""),
        displayStatus: detailDisplayStatus(task, action, manual),
        requestType: manual ? displayTaskType(task.taskType) : action.requestType,
        priority: (manual
            ? (displayTaskType(task?.taskType) || "General Task")
            : categoryFromRequestType(action?.requestType, action?.extra2 || "")) === "System Task"
            ? "High"
            : (task?.priority || "Medium"),
        status: task?.status || action?.status || "Pending",
        requestDate: manual ? task.createdAt : action.requestedDate || action.createdAt,
        completionDate: task?.completionDate || action?.actionedDate || null,
        updatedAt: task?.updatedAt || action?.updatedAt || null,
        assigneeId: cardAssignee.id || String(currentAssigneeId || ""),
        assigneeName: cardAssignee.name,
        assigneeEmpId: cardAssignee.employeeId || assigneeEmpId || "",
        assigneeRole: cardAssignee.role,
        assigneeEmail: cardAssignee.email,
        assigneePhone: cardAssignee.phone,
        assigneePhoto: cardAssignee.photo,
        requesterName: cardRequester.name,
        requesterRole: cardRequester.role,
        requesterEmail: cardRequester.email,
        requesterPhone: cardRequester.phone,
        requesterPhoto: cardRequester.photo,
        attachments: task?.attachments || [],
        comments: [...(task?.comments || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
        updates: [...(task?.updates || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
        history: task?.history || [],
        emails,
        reminders: task?.reminders || { dueDate: true, overdue: false },
        notifications: {
            workUpdate: task?.notifications?.workUpdate !== false,
            comment: task?.notifications?.comment !== false,
        },
        department: requester?.department || assigneeEmp?.department || "",
        relatedTo: relatedLabel(destination.module, destination.label),
        lastUpdatedBy: [...(task?.history || [])].reverse().find((item) => item?.actorName)?.actorName || cardAssignee.name || "",
        module: destination.module,
        moduleLabel: destination.label,
        modulePath: destination.path,
    };
}

async function findEmployeeByName(fullName) {
    const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length || parts.join(" ").toLowerCase() === "system") return null;
    const firstName = parts[0];
    const lastName = parts.slice(1).join(" ");
    const query = lastName
        ? { firstName: new RegExp(`^${firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"), lastName: new RegExp(`^${lastName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }
        : { firstName: new RegExp(`^${firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") };
    const named = await EmployeeBasic.findOne(query)
        .select("firstName lastName employeeId designation companyEmail workEmail profilePicture primaryReportee status")
        .lean();
    if (!named) return null;
    const [detailed] = await loadPeopleDetails([named._id], [named.employeeId]);
    return detailed || named;
}

async function findAssignee(assigneeId) {
    if (!isObjectId(assigneeId)) return null;
    return EmployeeBasic.findOne({ _id: assigneeId, status: { $ne: "Left User" } })
        .select("firstName lastName employeeId designation companyEmail workEmail profilePicture primaryReportee status")
        .lean();
}

export const getTaskManagerTask = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        const target = await loadTarget(req.params.taskKey);
        if (!target) return res.status(404).json({ message: "Task not found." });
        const viewer = await resolveTaskViewer(req);
        return res.status(200).json({ task: await buildDetail(target, viewer) });
    } catch (error) {
        console.error("Task detail error:", error);
        return res.status(500).json({ message: "Failed to load task details" });
    }
};

export const updateTaskManagerTask = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        const target = await loadTarget(req.params.taskKey);
        if (!target) return res.status(404).json({ message: "Task not found." });

        const taskType = canonicalTaskType(req.body?.taskType);
        const priority = taskType === "System Task" ? "High" : String(req.body?.priority || "").trim();
        const taskName = String(req.body?.taskName || "").trim();
        const description = String(req.body?.description || "").trim();
        const assigneeId = String(req.body?.assigneeId || "").trim();
        const completionDate = parseCompletionDate(req.body?.completionDate);
        const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];

        if (!taskType) return res.status(400).json({ message: "Choose a task type." });
        if (!PRIORITIES.has(priority)) return res.status(400).json({ message: "Choose a task priority." });
        if (!taskName) return res.status(400).json({ message: "Task name is required." });
        if (!isObjectId(assigneeId)) return res.status(400).json({ message: "Select an assignee." });
        if (!completionDate) return res.status(400).json({ message: "Completion date is required." });

        const assignee = await findAssignee(assigneeId);
        if (!assignee) return res.status(400).json({ message: "Selected assignee was not found." });
        const viewer = await resolveTaskViewer(req);
        const previous = assigneeOf(target);
        const assigneeChanged = String(previous.assigneeId) !== String(assignee._id);
        if (assigneeChanged && !viewerCanReassign(viewer, previous.assigneeId, previous.assigneeEmpId)) {
            return res.status(403).json({
                message: "Only the current assignee or the admin super user can reassign this task.",
            });
        }

        const storedFiles = [];
        for (const file of attachments) {
            const data = String(file?.data || "");
            const name = String(file?.name || "attachment").trim() || "attachment";
            if (!data) continue;
            const uploaded = await uploadDocumentToS3(data, "task-manager", name, "raw");
            storedFiles.push({ fileName: name, key: uploaded.publicId || "", url: uploaded.url || "" });
        }

        const assigneeName = personName(assignee) || assignee.employeeId || "Unassigned";
        const ownerReassigned = assigneeChanged && viewerIsCurrentAssignee(viewer, previous);
        const assignerName = ownerReassigned
            ? await nameOfAssignee(previous, target.kind === "manual" ? target.task?.assigneeName : target.task?.assigneeName || viewer.name)
            : "";
        let saved;
        if (target.kind === "manual") {
            const task = target.task;
            task.taskType = taskType;
            task.priority = priority;
            task.taskName = taskName;
            task.description = description;
            task.assignee = assignee._id;
            task.assigneeEmpId = assignee.employeeId || "";
            task.assigneeName = assigneeName;
            if (assignerName) task.requestedByName = requesterWithAssigner(task.requestedByName, assignerName);
            task.completionDate = completionDate;
            if (storedFiles.length) task.attachments = [...(task.attachments || []), ...storedFiles];
            task.history = task.history || [];
            task.history.push(historyEntry("Edited", "Task details were updated.", viewer.name));
            if (assigneeChanged) {
                task.history.push(historyEntry("Reassigned", `Assignee changed to ${assigneeName}.`, viewer.name));
            }
            saved = await task.save();
            await syncManualTaskNotification(saved);
        } else {
            const action = target.action;
            let overlay = target.task;
            if (!overlay) {
                overlay = new TaskManagerTask({
                    sourceDashboardActionId: action._id,
                    requestedByName: action.requestedByName || "",
                    status: "Pending",
                    completionDate,
                    assignee: assignee._id,
                    taskType,
                    priority,
                    taskName,
                });
            }
            overlay.taskType = taskType;
            overlay.priority = priority;
            overlay.taskName = taskName;
            overlay.description = description;
            overlay.assignee = assignee._id;
            overlay.assigneeEmpId = assignee.employeeId || "";
            overlay.assigneeName = assigneeName;
            if (assignerName) {
                overlay.requestedByName = requesterWithAssigner(action.requestedByName || overlay.requestedByName, assignerName);
            }
            overlay.completionDate = completionDate;
            if (storedFiles.length) overlay.attachments = [...(overlay.attachments || []), ...storedFiles];
            overlay.history = overlay.history || [];
            overlay.history.push(historyEntry("Edited", "Task details were updated.", viewer.name));
            saved = await overlay.save();
            action.extra1 = taskName;
            action.assignedTo = assignee._id;
            action.assignedToEmpId = assignee.employeeId || "";
            await action.save();
        }

        if (assigneeChanged) {
            const destination = moduleForText(taskName, description, taskType, target.action?.requestType);
            try {
                await sendTaskReassignedEmail({
                    toEmp: assignee,
                    taskName,
                    taskNumber: "",
                    reason: "The task was updated and assigned to you.",
                    modulePath: destination.path,
                    requesterName: saved.requestedByName,
                    recordId: String(target.action?._id || saved?._id || ""),
                });
            } catch (mailError) {
                console.error("Task edit reassignment email failed:", mailError);
            }
        }

        const fresh = await loadTarget(req.params.taskKey);
        return res.status(200).json({
            message: "Task updated",
            task: await buildDetail(fresh, viewer),
        });
    } catch (error) {
        console.error("Update task error:", error);
        const message = String(error?.message || "");
        if (/Only PDF|upload|JPEG|PNG|file/i.test(message)) {
            return res.status(400).json({ message: message.replace(/^Failed to upload to storage:\s*/i, "") });
        }
        return res.status(500).json({ message: "Failed to update task" });
    }
};

export const reassignTaskManagerTask = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        const target = await loadTarget(req.params.taskKey);
        if (!target) return res.status(404).json({ message: "Task not found." });
        const viewer = await resolveTaskViewer(req);
        const current = assigneeOf(target);
        if (!viewerCanReassign(viewer, current.assigneeId, current.assigneeEmpId)) {
            return res.status(403).json({
                message: "Only the current assignee or the admin super user can reassign this task.",
            });
        }

        const assigneeId = String(req.body?.assigneeId || "").trim();
        const reason = String(req.body?.reason || "").trim();
        const notifyAssignee = req.body?.notifyAssignee !== false;
        const notifyRequester = req.body?.notifyRequester !== false;
        if (!isObjectId(assigneeId)) return res.status(400).json({ message: "Select a new assignee." });
        if (!reason) return res.status(400).json({ message: "Reason for reassignment is required." });
        if (reason.length > 500) return res.status(400).json({ message: "Reason must be 500 characters or less." });

        const assignee = await findAssignee(assigneeId);
        if (!assignee) return res.status(400).json({ message: "Selected assignee was not found." });
        const assigneeName = personName(assignee) || assignee.employeeId || "Unassigned";
        const detail = `Reassigned to ${assigneeName}. ${reason}`;
        const ownerReassigned = viewerIsCurrentAssignee(viewer, current);
        const assignerName = ownerReassigned
            ? await nameOfAssignee(
                current,
                target.kind === "manual" ? target.task?.assigneeName : target.task?.assigneeName || viewer.name,
            )
            : "";

        let taskName = "";
        let requesterName = "";
        let modulePath = "/task-manager";

        if (target.kind === "manual") {
            const task = target.task;
            task.assignee = assignee._id;
            task.assigneeEmpId = assignee.employeeId || "";
            task.assigneeName = assigneeName;
            if (assignerName) task.requestedByName = requesterWithAssigner(task.requestedByName, assignerName);
            task.history = task.history || [];
            task.history.push(historyEntry("Reassigned", detail, viewer.name));
            await pushWorkUpdate(task, {
                authorName: viewer.name,
                authorRole: await authorRoleFor(viewer),
                kind: "Work Update",
                badge: "",
                text: detail,
            });
            await task.save();
            await syncManualTaskNotification(task);
            taskName = task.taskName;
            requesterName = task.requestedByName;
            modulePath = moduleForText(task.taskName, task.description, task.taskType).path;
        } else {
            const action = target.action;
            action.assignedTo = assignee._id;
            action.assignedToEmpId = assignee.employeeId || "";
            await action.save();
            let overlay = target.task;
            if (!overlay) {
                overlay = new TaskManagerTask({
                    sourceDashboardActionId: action._id,
                    taskType: "Workflow Task",
                    priority: "Medium",
                    taskName: action.extra1 || action.requestType || "Task",
                    description: action.extra2 || "",
                    completionDate: action.actionedDate || action.requestedDate || new Date(),
                    requestedByName: action.requestedByName || "",
                    status: "Pending",
                });
            }
            overlay.assignee = assignee._id;
            overlay.assigneeEmpId = assignee.employeeId || "";
            overlay.assigneeName = assigneeName;
            if (assignerName) {
                overlay.requestedByName = requesterWithAssigner(action.requestedByName || overlay.requestedByName, assignerName);
            }
            overlay.history = overlay.history || [];
            overlay.history.push(historyEntry("Reassigned", detail, viewer.name));
            await pushWorkUpdate(overlay, {
                authorName: viewer.name,
                authorRole: await authorRoleFor(viewer),
                kind: "Work Update",
                badge: "",
                text: detail,
            });
            await overlay.save();
            taskName = overlay.taskName || action.extra1 || action.requestType;
            requesterName = overlay.requestedByName || action.requestedByName || "";
            modulePath = moduleForRequestType(action.requestType, `${action.extra1 || ""} ${action.extra2 || ""}`).path;
        }

        let emailSent = false;
        if (notifyAssignee) {
            try {
                const result = await sendTaskReassignedEmail({
                    toEmp: assignee,
                    taskName,
                    taskNumber: "",
                    reason,
                    modulePath,
                    requesterName,
                    recordId: String(target.action?._id || target.task?._id || ""),
                });
                emailSent = Boolean(result.sent);
            } catch (mailError) {
                console.error("Reassignment email failed:", mailError);
            }
        }
        if (notifyRequester && requesterName) {
            const requester = await findEmployeeByName(requesterName);
            if (requester) {
                try {
                    await sendTaskReassignedEmail({
                        toEmp: requester,
                        taskName,
                        reason: `${assigneeName} is now assigned. ${reason}`,
                        modulePath,
                        requesterName,
                        recordId: String(target.action?._id || target.task?._id || ""),
                    });
                } catch (mailError) {
                    console.error("Requester reassignment email failed:", mailError);
                }
            }
        }

        const fresh = await loadTarget(req.params.taskKey);
        return res.status(200).json({
            message: emailSent
                ? "Task reassigned. The new assignee was emailed."
                : "Task reassigned. The assignee email could not be sent.",
            emailSent,
            task: await buildDetail(fresh, viewer),
        });
    } catch (error) {
        console.error("Reassign task error:", error);
        return res.status(500).json({ message: "Failed to reassign task" });
    }
};

export const updateTaskManagerTaskStatus = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        const target = await loadTarget(req.params.taskKey);
        if (!target) return res.status(404).json({ message: "Task not found." });
        if (target.kind === "dashboard" && target.action?.requestType !== "Task Manager") {
            return res.status(400).json({
                message: "This request is updated on its own page. You can still reassign it here.",
            });
        }
        const status = String(req.body?.status || "").trim();
        if (!STATUSES.has(status)) return res.status(400).json({ message: "Choose a valid status." });
        const viewer = await resolveTaskViewer(req);
        const task = target.task;
        task.status = status;
        task.history = task.history || [];
        task.history.push(historyEntry("Status", `Status set to ${status}.`, viewer.name));
        await pushWorkUpdate(task, {
            authorName: viewer.name,
            authorRole: await authorRoleFor(viewer),
            kind: "Status Changed",
            badge: status,
            text: `Status set to ${status}.`,
        });
        await task.save();
        await syncManualTaskNotification(task);
        const fresh = await loadTarget(req.params.taskKey);
        return res.status(200).json({ message: "Status updated", task: await buildDetail(fresh, viewer) });
    } catch (error) {
        console.error("Task status error:", error);
        return res.status(500).json({ message: "Failed to update status" });
    }
};

export const addTaskManagerComment = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        const target = await loadTarget(req.params.taskKey);
        if (!target) return res.status(404).json({ message: "Task not found." });
        const text = String(req.body?.text || "").trim();
        if (!text) return res.status(400).json({ message: "Comment is required." });
        if (text.length > 1000) return res.status(400).json({ message: "Comment must be 1000 characters or less." });
        const viewer = await resolveTaskViewer(req);
        let task = target.task;
        if (!task && target.action) {
            task = new TaskManagerTask({
                sourceDashboardActionId: target.action._id,
                taskType: "Workflow Task",
                priority: "Medium",
                taskName: target.action.extra1 || target.action.requestType || "Task",
                description: "",
                assignee: target.action.assignedTo,
                assigneeEmpId: target.action.assignedToEmpId || "",
                assigneeName: target.action.subjectName || "",
                completionDate: target.action.requestedDate || new Date(),
                requestedByName: target.action.requestedByName || "",
                status: "Pending",
            });
        }
        const safeText = sanitizeComment(text);
        if (!plainText(safeText)) return res.status(400).json({ message: "Comment is required." });
        const mail = await notifyParties(task, {
            notifyKind: "comment",
            subject: `New Comment: ${task.taskName || "Task"}`,
            html: `
                <p>${escapeHtml(viewer.name)} added a comment.</p>
                <p>${safeText}</p>
                <p><strong>Task:</strong> ${escapeHtml(task.taskName || "Task")}</p>
            `,
        });
        task.comments = task.comments || [];
        task.comments.push({
            authorName: viewer.name,
            authorRole: await authorRoleFor(viewer),
            text: safeText,
            createdAt: new Date(),
            ...mail,
        });
        task.history = task.history || [];
        task.history.push(historyEntry("Comment", text, viewer.name));
        await task.save();
        const fresh = await loadTarget(req.params.taskKey);
        return res.status(200).json({ task: await buildDetail(fresh, viewer) });
    } catch (error) {
        console.error("Task comment error:", error);
        return res.status(500).json({ message: "Failed to add comment" });
    }
};

export const updateTaskManagerReminders = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        const target = await loadTarget(req.params.taskKey);
        if (!target) return res.status(404).json({ message: "Task not found." });
        if (!target.task && target.action) {
            target.task = new TaskManagerTask({
                sourceDashboardActionId: target.action._id,
                taskType: "Workflow Task",
                priority: "Medium",
                taskName: target.action.extra1 || target.action.requestType || "Task",
                description: "",
                assignee: target.action.assignedTo,
                assigneeEmpId: target.action.assignedToEmpId || "",
                assigneeName: target.action.subjectName || "",
                completionDate: target.action.requestedDate || new Date(),
                requestedByName: target.action.requestedByName || "",
                status: "Pending",
            });
        }
        if (!target.task) return res.status(404).json({ message: "Task not found." });
        target.task.reminders = {
            dueDate: Boolean(req.body?.dueDate),
            overdue: Boolean(req.body?.overdue),
        };
        await target.task.save();
        const viewer = await resolveTaskViewer(req);
        const fresh = await loadTarget(req.params.taskKey);
        return res.status(200).json({ task: await buildDetail(fresh, viewer) });
    } catch (error) {
        console.error("Task reminder error:", error);
        return res.status(500).json({ message: "Failed to update reminders" });
    }
};

function blankOverlay(action) {
    return new TaskManagerTask({
        sourceDashboardActionId: action._id,
        taskType: "Workflow Task",
        priority: "Medium",
        taskName: action.extra1 || action.requestType || "Task",
        description: action.extra2 || "",
        assignee: action.assignedTo,
        assigneeEmpId: action.assignedToEmpId || "",
        assigneeName: action.subjectName || "",
        completionDate: action.requestedDate || new Date(),
        requestedByName: action.requestedByName || "",
        status: "Pending",
    });
}

export const addTaskManagerUpdate = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        const target = await loadTarget(req.params.taskKey);
        if (!target) return res.status(404).json({ message: "Task not found." });
        const text = String(req.body?.text || "").trim();
        if (!text) return res.status(400).json({ message: "Work update is required." });
        if (text.length > 2000) return res.status(400).json({ message: "Work update must be 2000 characters or less." });
        const mentionIds = Array.isArray(req.body?.mentions) ? req.body.mentions : [];
        const viewer = await resolveTaskViewer(req);
        const task = target.task || (target.action ? blankOverlay(target.action) : null);
        if (!task) return res.status(404).json({ message: "Task not found." });
        const destination = target.kind === "manual"
            ? moduleForText(task.taskName, task.description, task.taskType)
            : moduleForRequestType(target.action?.requestType, `${target.action?.extra1 || ""} ${target.action?.extra2 || ""}`);
        const accessPath = accessPathFor(
            destination,
            target.kind === "manual" ? "" : target.action?.requestId,
            target.kind === "manual" ? "" : target.action?.subjectEmployeeId,
        );
        const mail = await notifyWorkUpdateAudience(task, {
            text,
            authorName: viewer.name,
            mentionIds,
            accessPath,
        });
        await pushWorkUpdate(task, {
            authorName: viewer.name,
            authorRole: await authorRoleFor(viewer),
            kind: "Work Update",
            badge: "",
            text,
        }, mail);
        task.history = task.history || [];
        task.history.push(historyEntry("Work Update", text, viewer.name));
        await task.save();
        const fresh = await loadTarget(req.params.taskKey);
        return res.status(200).json({ message: "Work update added", task: await buildDetail(fresh, viewer) });
    } catch (error) {
        console.error("Task work update error:", error);
        return res.status(500).json({ message: "Failed to add the work update" });
    }
};

export const updateTaskManagerNotifications = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        const target = await loadTarget(req.params.taskKey);
        if (!target) return res.status(404).json({ message: "Task not found." });
        const task = target.task || (target.action ? blankOverlay(target.action) : null);
        if (!task) return res.status(404).json({ message: "Task not found." });
        const current = task.notifications || {};
        task.notifications = {
            workUpdate: req.body?.workUpdate == null ? current.workUpdate !== false : Boolean(req.body.workUpdate),
            comment: req.body?.comment == null ? current.comment !== false : Boolean(req.body.comment),
        };
        await task.save();
        const viewer = await resolveTaskViewer(req);
        const fresh = await loadTarget(req.params.taskKey);
        return res.status(200).json({ task: await buildDetail(fresh, viewer) });
    } catch (error) {
        console.error("Task notification settings error:", error);
        return res.status(500).json({ message: "Failed to update notification settings" });
    }
};

const WORKFLOW_CHAINS = {
    leave: ["created", "assigned", "manager", "hr", "leaveBalance", "done"],
    attendance: ["created", "assigned", "manager", "done"],
    fine: ["created", "assigned", "manager", "hr", "accounts", "done"],
    loan: ["created", "assigned", "manager", "hr", "accounts", "done"],
    salary: ["created", "assigned", "hr", "accounts", "done"],
    reward: ["created", "assigned", "manager", "hr", "done"],
    vehicle: ["created", "assigned", "admin", "hr", "done"],
    utility: ["created", "assigned", "admin", "accounts", "done"],
    tools: ["created", "assigned", "admin", "done"],
    payment: ["created", "assigned", "accounts", "done"],
    company: ["created", "assigned", "admin", "done"],
    employees: ["created", "assigned", "hr", "done"],
    general: ["created", "assigned", "done"],
};

const ROLE_STEP = {
    manager: { title: "Manager Approval", label: "HOD" },
    hr: { title: "HR Approval", label: "HR" },
    accounts: { title: "Accounts Approval", label: "Accounts" },
    admin: { title: "Admin Approval", label: "Admin" },
};

function stepPerson(emp, fallbackName = "") {
    const card = contactCard(emp);
    if (!card.name && fallbackName) card.name = fallbackName;
    return {
        personId: card.id || "",
        personName: card.name || fallbackName || "",
        personRole: card.role || "",
        personPhoto: card.photo || "",
    };
}

async function reportingManager(employee) {
    if (!employee?._id) return null;
    const row = await EmployeeBasic.findById(employee._id)
        .populate("primaryReportee", "firstName lastName employeeId designation companyEmail profilePicture status")
        .lean();
    const manager = row?.primaryReportee;
    if (!manager || manager.status === "Left User") return null;
    return manager;
}

async function buildTaskWorkflow(target, viewer) {
    const manual = target.kind === "manual";
    const task = target.task;
    const action = target.action;
    const { assigneeId, assigneeEmpId } = assigneeOf(target);
    const assigneeEmp = await findAssignee(assigneeId);
    const requesterName = String(task?.requestedByName || action?.requestedByName || "").trim() || "System";
    const requesterEmp = await findEmployeeByName(requesterName);
    const assigneeName = stepPerson(assigneeEmp, manual ? task?.assigneeName : action?.subjectName || "Unassigned").personName;
    const destination = manual
        ? moduleForText(task?.taskName, task?.description, task?.taskType)
        : moduleForRequestType(action?.requestType, `${action?.extra1 || ""} ${action?.extra2 || ""}`);
    const manager = (await reportingManager(requesterEmp)) || (await reportingManager(assigneeEmp));
    const [hr, accounts, admin] = await Promise.all([
        getDepartmentHOD("hr").catch(() => null),
        getDepartmentHOD("finance").catch(() => null),
        getDepartmentHOD("admincontroller").catch(() => null),
    ]);
    const holders = { manager, hr, accounts, admin };
    const keys = WORKFLOW_CHAINS[destination.module] || WORKFLOW_CHAINS.general;
    const requestDate = manual ? task?.createdAt : action?.requestedDate || action?.createdAt || null;
    const updatedAt = task?.updatedAt || action?.updatedAt || requestDate;
    const requester = stepPerson(requesterEmp, requesterName);
    const assignee = stepPerson(assigneeEmp, assigneeName);
    const steps = [];

    for (const key of keys) {
        if (key === "created") {
            steps.push({
                key,
                title: "Task Created",
                detail: `By ${requester.personName || "System"} (Requester)`,
                ...requester,
                at: requestDate,
            });
            continue;
        }
        if (key === "assigned") {
            steps.push({
                key,
                title: `Assigned to ${assignee.personName || "Unassigned"}`,
                detail: `By ${requester.personName || "System"}`,
                ...assignee,
                at: requestDate,
            });
            continue;
        }
        if (key === "leaveBalance") {
            steps.push({
                key,
                title: "Update Leave Balance",
                detail: "Pending",
                personId: "",
                personName: "",
                personRole: "",
                personPhoto: "",
                at: null,
            });
            continue;
        }
        if (key === "done") {
            steps.push({
                key,
                title: "Completed",
                detail: "Pending",
                personId: "",
                personName: "",
                personRole: "",
                personPhoto: "",
                at: null,
            });
            continue;
        }
        const holder = holders[key];
        const person = stepPerson(holder);
        if (!person.personName) continue;
        const role = ROLE_STEP[key];
        if (person.personId && steps[steps.length - 1]?.personId === person.personId) continue;
        steps.push({
            key,
            title: role.title,
            detail: `Pending with ${person.personName} (${role.label})`,
            ...person,
            personRole: person.personRole || role.label,
            at: null,
        });
    }

    const raw = String(task?.status || action?.status || "Pending");
    const finished = raw === "Completed" || raw === "Approved";
    const rejected = raw === "Cancelled" || raw === "Rejected" || raw === "Dismissed";
    const workflowLocked = !manual && action?.requestType !== "Task Manager";
    let current = -1;
    steps.forEach((step, index) => {
        if (step.personId && assigneeId && step.personId === String(assigneeId)) current = index;
    });
    if (current < 0) current = Math.max(0, steps.findIndex((step) => step.key === "assigned"));

    steps.forEach((step, index) => {
        if (finished) step.status = "Completed";
        else if (rejected) step.status = index < current ? "Completed" : index === current ? "Rejected" : "Not Started";
        else step.status = index < current ? "Completed" : index === current ? "In Progress" : "Not Started";

        if (step.status === "Completed" && step.key !== "created") {
            if (step.key === "done") step.detail = "Completed";
            else if (step.key === "leaveBalance") step.detail = "Updated";
            else if (step.personName && step.key !== "assigned") step.detail = `By ${step.personName}`;
        }
        if (step.status === "Not Started" && !step.personName) step.detail = "Pending";
        if (step.status === "Rejected") step.detail = step.personName ? `Rejected by ${step.personName}` : "Rejected";
        if (step.status === "Completed" || step.status === "In Progress" || step.status === "Rejected") {
            step.at = step.at || (index === 0 ? requestDate : updatedAt);
        } else {
            step.at = null;
        }
        step.canAct = step.status === "In Progress"
            && Boolean(step.personId)
            && !workflowLocked
            && viewerCanReassign(viewer, assigneeId, assigneeEmpId);
    });

    return {
        module: destination.module,
        moduleLabel: destination.label,
        modulePath: destination.path,
        accessPath: accessPathFor(
            destination,
            manual ? "" : action?.requestId,
            manual ? "" : action?.subjectEmployeeId,
        ),
        workflowLocked,
        taskName: (task?.taskName || action?.extra1 || "Task").trim(),
        steps,
    };
}

export const getTaskManagerWorkflow = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        const target = await loadTarget(req.params.taskKey);
        if (!target) return res.status(404).json({ message: "Task not found." });
        const viewer = await resolveTaskViewer(req);
        return res.status(200).json(await buildTaskWorkflow(target, viewer));
    } catch (error) {
        console.error("Task workflow error:", error);
        return res.status(500).json({ message: "Failed to load the workflow" });
    }
};

export const decideTaskManagerWorkflow = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        const target = await loadTarget(req.params.taskKey);
        if (!target) return res.status(404).json({ message: "Task not found." });
        if (!target.task || (target.kind === "dashboard" && target.action?.requestType !== "Task Manager")) {
            return res.status(400).json({
                message: "This request is approved on its own page. You can still reassign it here.",
            });
        }
        const decision = String(req.body?.decision || "").trim().toLowerCase();
        if (decision !== "approve" && decision !== "reject") {
            return res.status(400).json({ message: "Choose approve or reject." });
        }
        const viewer = await resolveTaskViewer(req);
        const workflow = await buildTaskWorkflow(target, viewer);
        const currentIndex = workflow.steps.findIndex((step) => step.status === "In Progress");
        const current = workflow.steps[currentIndex];
        if (!current?.canAct) {
            return res.status(403).json({ message: "Only the current assignee or the admin super user can decide this step." });
        }

        const task = target.task;
        task.history = task.history || [];
        if (decision === "reject") {
            task.status = "Cancelled";
            task.history.push(historyEntry("Rejected", `${current.title} was rejected.`, viewer.name));
            await task.save();
            await syncManualTaskNotification(task);
        } else {
            const next = workflow.steps.slice(currentIndex + 1).find((step) => step.personId && step.personId !== String(task.assignee));
            if (next?.personId) {
                const assignee = await findAssignee(next.personId);
                if (!assignee) return res.status(400).json({ message: "The next person in this workflow was not found." });
                const assigneeName = personName(assignee) || assignee.employeeId || "Unassigned";
                task.assignee = assignee._id;
                task.assigneeEmpId = assignee.employeeId || "";
                task.assigneeName = assigneeName;
                task.status = "In Progress";
                task.history.push(historyEntry("Approved", `${current.title} approved. Sent to ${assigneeName}.`, viewer.name));
                await task.save();
                await syncManualTaskNotification(task);
                try {
                    await sendTaskReassignedEmail({
                        toEmp: assignee,
                        taskName: task.taskName,
                        reason: `${current.title} was approved. This step is now with you.`,
                        modulePath: workflow.modulePath,
                        requesterName: task.requestedByName,
                        recordId: String(task._id || ""),
                    });
                } catch (mailError) {
                    console.error("Workflow approval email failed:", mailError);
                }
            } else {
                task.status = "Completed";
                task.history.push(historyEntry("Approved", `${current.title} approved. The task is completed.`, viewer.name));
                await task.save();
                await syncManualTaskNotification(task);
            }
        }

        const fresh = await loadTarget(req.params.taskKey);
        return res.status(200).json({
            message: decision === "reject" ? "Step rejected." : "Step approved.",
            ...(await buildTaskWorkflow(fresh, viewer)),
            task: await buildDetail(fresh, viewer),
        });
    } catch (error) {
        console.error("Task workflow decision error:", error);
        return res.status(500).json({ message: "Failed to update the workflow" });
    }
};

export const deleteTaskManagerTask = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        const target = await loadTarget(req.params.taskKey);
        if (!target) return res.status(404).json({ message: "Task not found." });
        const viewer = await resolveTaskViewer(req);
        const manual = target.kind === "manual";
        const ownerName = String(target.task?.requestedByName || "").trim().toLowerCase();
        const viewerName = String(viewer?.name || "").trim().toLowerCase();
        const ownsCreatedTask = manual && (
            target.task?.requestedByUserId
                ? viewer?.userId && String(target.task.requestedByUserId) === String(viewer.userId)
                : Boolean(ownerName && ownerName === viewerName)
        );
        if (!viewer?.superUser && !ownsCreatedTask) {
            return res.status(403).json({
                message: manual
                    ? "Only the person who created this task, or an admin super user, can delete it."
                    : "Only an admin super user can delete a system or workflow task.",
            });
        }
        const task = target.task;
        if (manual && task?._id) {
            await DashboardAction.deleteMany({ requestId: task._id, requestType: "Task Manager" });
            await TaskManagerTask.deleteOne({ _id: task._id });
        } else if (viewer?.superUser && target.action?._id) {
            if (task?._id) await TaskManagerTask.deleteOne({ _id: task._id });
            await DashboardAction.deleteOne({ _id: target.action._id });
        } else if (target.action?._id && target.action.requestType === "Task Manager") {
            await DashboardAction.deleteOne({ _id: target.action._id, requestType: "Task Manager" });
        }
        return res.status(200).json({ message: "Task deleted." });
    } catch (error) {
        console.error("Delete task error:", error);
        return res.status(500).json({ message: "Failed to delete task" });
    }
};
