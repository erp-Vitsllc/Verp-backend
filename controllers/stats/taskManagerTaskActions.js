import Company from "../../models/Company.js";
import DashboardAction from "../../models/DashboardAction.js";
import EmailNotificationLog from "../../models/EmailNotificationLog.js";
import Payment from "../../models/Payment.js";
import AssetHistory from "../../models/AssetHistory.js";
import AssetItem from "../../models/AssetItem.js";
import Attendance from "../../models/Attendance.js";
import AttendanceChangeRequest from "../../models/AttendanceChangeRequest.js";
import { attendanceFactsByActionId } from "../../utils/loadAttendanceTaskFacts.js";
import { isAttendanceTaskType } from "../../utils/attendanceTaskCopy.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import EmployeeHubRequest from "../../models/EmployeeHubRequest.js";
import Fine from "../../models/Fine.js";
import Loan from "../../models/Loan.js";
import Reward from "../../models/Reward.js";
import TaskManagerTask from "../../models/TaskManagerTask.js";
import { deleteDashboardActionsForVehicleService } from "../../utils/cleanupAssetDashboardActions.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";
import { getSignedFileUrl, uploadDocumentToS3 } from "../../utils/s3Upload.js";
import { emailFrontendUrl } from "../../utils/resolveFrontendBaseUrl.js";
import { sendTextMessage } from "../../services/whatsappService.js";
import { resolveEmployeeWhatsAppPhone } from "../../utils/sendToolsAssetWhatsAppReport.js";
import {
    docTypeFromLabel,
    documentLabelFromExpiryText,
    emailBelongsToDocumentExpiry,
    emailBelongsToVehicleService,
    attachStoredEmailsToAction,
    findEmailsForTask,
    serviceTypeFromTaskText,
} from "../../utils/emailDispatch.js";
import { resolveEmployeeEmailWithReporteeLoaded } from "../../utils/resolveEmployeeEmail.js";
import {
    alignOpenFineDashboardRows,
    displayStatus,
    taskNumbersByRecordId,
    taskCategory as categoryFromRequestType,
    displayRequesterName,
    preferRequesterName,
    sourceRequesterNameMap,
    taskTitleAndDescription,
    vehicleDisplayById,
    vehicleDisplayFor,
    viewerMaySeeAllNotifications,
    collapseOpenDuplicatesOf,
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
    closeReassignmentNotices,
    deleteReassignmentNotices,
    promoteDueTaskCompletions,
    publishReassignmentNotices,
    sendTaskActivityEmail,
    sendTaskReassignedEmail,
    reassignmentAssignees,
    syncManualTaskNotification,
    taskOpenPath,
    upsertTaskNotice,
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

function isGeneralTask(task) {
    return String(task?.taskType || "") === "General Task";
}

function detailDisplayStatus(task, action, manual) {
    if (isGeneralTask(task) && task?.closeRequest?.closedAt && !task?.closeRequest?.reviewPending) return "Closed";
    if (isGeneralTask(task) && task?.closeRequest?.reopenedAt && !task?.closeRequest?.closedAt && task?.status === "Pending") return "Reopened";
    if (task?.closeRequest?.reviewPending && task?.status !== "Completed") return "Pending Review";
    if (task?.closeRequest?.reviewReturned && (task?.status === "Pending" || task?.status === "In Progress")) return "Open";
    if (task?.status === "Completed" || task?.status === "Cancelled" || task?.status === "Rejected") return task.status;
    if (task?.closeRequest?.reopenedAt && (task.status === "Pending" || task.status === "In Progress")) {
        const requested = manual ? task.createdAt : (action?.requestedDate || action?.createdAt || task.createdAt);
        return displayStatus(task.status, manual ? "" : action?.requestType, dubaiDateKey(requested), dubaiDateKey(new Date()));
    }
    if (manual && task) {
        return displayStatus("Pending", "", dubaiDateKey(task.createdAt), dubaiDateKey(new Date()));
    }
    return displayStatus(
        action?.status,
        action?.requestType,
        dubaiDateKey(action?.requestedDate || action?.createdAt),
        dubaiDateKey(new Date()),
    );
}

const PRIORITIES = new Set(["High", "Medium", "Low"]);
const STATUSES = new Set(["Pending", "In Progress", "Completed", "Cancelled", "Rejected"]);

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

function taskActionHtml({ hello, lines = [], taskName, description, link }) {
    const paragraphs = lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
    const note = String(description || "").trim()
        ? `<p><strong>Description:</strong></p><p>${escapeHtml(description).replace(/\n/g, "<br>")}</p>`
        : "";
    return `
        <p>Hello ${escapeHtml(hello || "there")},</p>
        ${paragraphs}
        <p><strong>${escapeHtml(taskName || "Task")}</strong></p>
        ${note}
        <p><a href="${escapeHtml(link)}">Open Task</a></p>
    `;
}

function readDescription(body) {
    const text = String(body?.description || body?.reason || "").trim();
    if (!text) return { error: "Description is required." };
    if (text.length > 500) return { error: "Description must be 500 characters or less." };
    return { text };
}

async function mailEmployee(emp, { subject, html, recordId, emailType }) {
    if (!emp) return { sent: false };
    const resolved = await resolveEmployeeEmailWithReporteeLoaded(emp);
    const to = String(resolved?.email || "").trim();
    if (!to) return { sent: false };
    return sendTaskActivityEmail({ to: [to], subject, html, recordId, emailType });
}

async function businessEmail(emp) {
    if (!emp) return "";
    const resolved = await resolveEmployeeEmailWithReporteeLoaded(emp);
    return String(resolved?.email || "").trim();
}

/** Assignee and requester both get every task email. Mentioned people are added. */
async function taskRecipientEmails(task, extraPeople = []) {
    const assignee = isObjectId(task?.assignee) ? await findAssignee(String(task.assignee)) : null;
    const requester = await findEmployeeByName(task?.requestedByName);
    const emails = [];
    for (const person of [assignee, requester, ...extraPeople]) {
        const email = await businessEmail(person);
        if (email) emails.push(email);
    }
    return {
        to: [...new Set(emails)],
        assignee,
        requester,
        assigneeName: task?.assigneeName || personName(assignee),
        requesterName: task?.requestedByName || personName(requester),
    };
}

async function emailTaskHistory(task, { event, detail, actorName }) {
    const audience = await taskRecipientEmails(task);
    if (!audience.to.length) return { sent: false };
    const taskKey = task?.sourceDashboardActionId ? String(task.sourceDashboardActionId) : `manual-${task?._id || ""}`;
    const link = `${emailFrontendUrl()}/task-manager/${encodeURIComponent(taskKey)}`;
    try {
        return await sendTaskActivityEmail({
            to: audience.to,
            subject: `Task ${event}: ${task?.taskName || "Task"}`,
            html: taskActionHtml({
                hello: "there",
                lines: [`${actorName || "Someone"} — ${detail || event}`],
                taskName: task?.taskName,
                link,
            }),
            recordId: String(task?.sourceDashboardActionId || task?._id || ""),
            emailType: `Task ${event}`,
        });
    } catch (error) {
        console.error("Task history email failed:", error);
        return { sent: false };
    }
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
    const audience = await taskRecipientEmails(task);
    if (!result.assigneeName) result.assigneeName = audience.assigneeName;
    if (!result.requesterName) result.requesterName = audience.requesterName;
    const to = audience.to;
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
            result.assigneeNotified = Boolean(audience.assignee);
            result.requesterNotified = Boolean(audience.requester);
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
    const mentioned = ids.length
        ? await EmployeeBasic.find({ _id: { $in: ids }, status: { $ne: "Left User" } })
            .select("firstName lastName companyEmail workEmail primaryReportee status")
            .lean()
        : [];
    const audience = await taskRecipientEmails(task, mentioned);
    if (!result.assigneeName) result.assigneeName = audience.assigneeName;
    if (!result.requesterName) result.requesterName = audience.requesterName;
    const to = audience.to;
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
        result.assigneeNotified = Boolean(result.emailSent && audience.assignee);
        result.requesterNotified = Boolean(result.emailSent && audience.requester);
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

async function targetFromTask(task, preferredAction = null) {
    if (!task) return null;
    let source = preferredAction && preferredAction.requestType !== "Task Manager" ? preferredAction : null;
    if (!source && isObjectId(task.sourceDashboardActionId)) {
        const found = await DashboardAction.findById(task.sourceDashboardActionId);
        if (found && found.requestType !== "Task Manager") source = found;
    }
    if (source) return { kind: "dashboard", task, action: source };
    return { kind: "manual", task, action: null };
}

async function taskByStoredKey(taskKey) {
    const raw = decodeURIComponent(String(taskKey || "")).trim();
    if (!raw) return null;
    const manualId = raw.startsWith("manual-") ? raw.slice("manual-".length) : "";
    if (manualId && isObjectId(manualId)) return TaskManagerTask.findById(manualId);
    if (!isObjectId(raw)) return null;
    return (
        (await TaskManagerTask.findOne({ sourceDashboardActionId: raw }))
        || (await TaskManagerTask.findById(raw))
        || (await TaskManagerTask.findOne({ "closeRequest.reassignmentNotices.requestId": raw }))
    );
}

async function taskFromReassignmentNotice(raw) {
    const key = String(raw || "").trim();
    if (!key) return null;
    const clauses = [];
    if (isObjectId(key)) {
        clauses.push({ _id: key }, { requestId: key });
    }
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    clauses.push({ extra3: new RegExp(`"(?:taskKey|taskManagerId)":"${escaped}"`) });
    const notice = await DashboardAction.findOne({
        requestType: "Task Manager",
        $or: clauses,
    }).select("extra3").lean();
    if (!notice) return null;
    const meta = readMeta(notice.extra3);
    const candidates = [meta.taskManagerId, meta.taskKey]
        .map((value) => String(value || "").trim())
        .filter((value) => value && value !== key);
    for (const candidate of candidates) {
        const task = await taskByStoredKey(candidate);
        if (task) return task;
    }
    return null;
}

async function loadTarget(taskKey) {
    const raw = decodeURIComponent(String(taskKey || ""));
    const manualId = raw.startsWith("manual-") ? raw.slice("manual-".length) : "";
    if (manualId && isObjectId(manualId)) {
        return targetFromTask(await TaskManagerTask.findById(manualId));
    }
    if (!isObjectId(raw)) return null;
    const action = await DashboardAction.findById(raw);
    if (action?.requestType === "Task Manager" && action.requestId) {
        const linked = await TaskManagerTask.findById(action.requestId);
        if (linked && !linked.sourceDashboardActionId) return { kind: "manual", task: linked, action };
    }
    if (action?.requestType === "Task Manager") {
        const meta = readMeta(action.extra3);
        const storedKey = String(meta.taskKey || "").trim();
        const linked = await taskByStoredKey(meta.taskManagerId || (storedKey && storedKey !== raw ? storedKey : ""));
        if (linked) return targetFromTask(linked);
        if (isObjectId(action.requestId)) {
            const byRequest = await TaskManagerTask.findById(action.requestId);
            if (byRequest) return targetFromTask(byRequest);
        }
        const recovered = await taskFromReassignmentNotice(raw);
        if (recovered) return targetFromTask(recovered);
        return null;
    }
    const overlay = await TaskManagerTask.findOne({ sourceDashboardActionId: raw });
    if (overlay) return targetFromTask(overlay, action);
    const byNotice = await TaskManagerTask.findOne({ "closeRequest.reassignmentNotices.requestId": raw });
    if (byNotice) return targetFromTask(byNotice);
    if (action) return { kind: "dashboard", task: null, action };
    const byId = await TaskManagerTask.findById(raw);
    if (byId) return targetFromTask(byId);
    const recovered = await taskFromReassignmentNotice(raw);
    if (recovered) return targetFromTask(recovered);
    return null;
}

function viewerIsCurrentAssignee(viewer, current) {
    const assigneeId = String(current?.assigneeId || "");
    if (assigneeId && viewer?.employeeObjectId && assigneeId === String(viewer.employeeObjectId)) return true;
    if (assigneeId && viewer?.userId && assigneeId === String(viewer.userId)) return true;
    const code = String(current?.assigneeEmpId || "").trim().toLowerCase();
    if (code && viewer?.employeeId && code === String(viewer.employeeId).trim().toLowerCase()) return true;
    const viewerName = personBaseName(viewer?.name).toLowerCase();
    const assigneeName = personBaseName(current?.assigneeName).toLowerCase();
    return Boolean(viewerName && assigneeName && viewerName === assigneeName);
}

async function nameOfAssignee(current, fallback = "") {
    const person = isObjectId(current?.assigneeId) ? await findAssignee(current.assigneeId) : null;
    return personName(person) || String(fallback || "").trim();
}

const SILENT_MAIL = {
    emailSent: false,
    assigneeNotified: false,
    requesterNotified: false,
    assigneeName: "",
    requesterName: "",
};

function closeSnapshot(task) {
    const saved = task?.closeRequest?.toObject ? task.closeRequest.toObject() : (task?.closeRequest || {});
    return { ...saved };
}

function rememberOriginalAssignee(task, current, previousName) {
    if (!task) return;
    const saved = closeSnapshot(task);
    if (saved.originalAssigneeId || saved.originalAssigneeName) return;
    task.closeRequest = {
        ...saved,
        originalAssigneeId: isObjectId(current?.assigneeId) ? current.assigneeId : null,
        originalAssigneeEmpId: current?.assigneeEmpId || "",
        originalAssigneeName: previousName || "",
    };
    task.markModified("closeRequest");
}

function clearPendingCompletion(task) {
    if (!task?.closeRequest?.completionRequestedAt && !task?.closeRequest?.completionNote && !task?.closeRequest?.completesAt) return;
    const saved = closeSnapshot(task);
    task.closeRequest = {
        ...saved,
        completionRequestedAt: null,
        completionRequestedById: null,
        completionRequestedByName: "",
        completionNote: "",
        completionConfirmedAt: null,
        completesAt: null,
    };
    task.markModified("closeRequest");
}

function taskWasReassigned(task) {
    if (task?.closeRequest?.originalAssigneeName || task?.closeRequest?.originalAssigneeId) return true;
    return (task?.history || []).some((item) => item?.event === "Reassigned");
}

function originalAssigneeNameFromHistory(task) {
    const first = (task?.history || []).find((item) => item?.event === "Reassigned");
    if (!first) return "";
    return parseReassignment(first.detail, first.actorName).from || "";
}

function viewerMatchesEmployee(viewer, employee) {
    if (!employee) return false;
    const id = String(employee._id || "");
    if (id && viewer?.employeeObjectId && id === String(viewer.employeeObjectId)) return true;
    if (id && viewer?.userId && id === String(viewer.userId)) return true;
    const code = String(employee.employeeId || "").trim().toLowerCase();
    if (code && viewer?.employeeId && code === String(viewer.employeeId).trim().toLowerCase()) return true;
    const viewerName = personBaseName(viewer?.name).toLowerCase();
    const employeeName = personName(employee).toLowerCase();
    return Boolean(viewerName && employeeName && viewerName === employeeName);
}

async function signedProfilePhoto(raw) {
    const text = String(raw || "").trim().replace(/^\/+/, "");
    if (!text) return "";
    if (text.startsWith("http")) {
        try {
            const signed = await getSignedFileUrl(text);
            if (signed && String(signed).startsWith("http")) return signed;
        } catch {
            return text;
        }
        return text;
    }
    try {
        const signed = await getSignedFileUrl(text);
        return signed && String(signed).startsWith("http") ? signed : "";
    } catch {
        return "";
    }
}

async function employeeById(id) {
    if (!isObjectId(id)) return null;
    return EmployeeBasic.findById(id)
        .select("firstName lastName employeeId designation companyEmail workEmail profilePicture")
        .lean();
}

async function resolveOriginalAssignee(task) {
    const savedId = task?.closeRequest?.originalAssigneeId;
    if (isObjectId(savedId)) {
        const person = await employeeById(savedId);
        if (person) return person;
    }
    const name = personBaseName(task?.closeRequest?.originalAssigneeName) || originalAssigneeNameFromHistory(task);
    if (!name) return null;
    return findEmployeeByName(name);
}

function taskRecordKey(target, task) {
    if (target?.kind === "manual") return `manual-${task?._id || target?.task?._id || ""}`;
    return String(target?.action?._id || task?._id || "");
}

function taskDetailLink(target) {
    return `${emailFrontendUrl()}${taskOpenPath(taskRecordKey(target, target?.task))}`;
}

async function keepReassignmentVisible(task, target, { previous, newAssignee, reassigneeName, taskName, moduleName, noticeText = "" }) {
    if (!task) return;
    const watchers = [];
    if (isObjectId(previous?.assigneeId)) {
        watchers.push({
            employeeId: previous.assigneeId,
            empId: previous.assigneeEmpId || "",
        });
    }
    const originalId = task.closeRequest?.originalAssigneeId;
    if (isObjectId(originalId)) {
        watchers.push({
            employeeId: originalId,
            empId: task.closeRequest?.originalAssigneeEmpId || "",
        });
    }
    const newAssigneeId = newAssignee?._id || newAssignee;
    if (isObjectId(newAssigneeId)) {
        watchers.push({
            employeeId: newAssigneeId,
            empId: newAssignee?.employeeId || "",
        });
    }
    await publishReassignmentNotices(task, {
        watchers,
        reassigneeName,
        newAssigneeId: newAssignee?._id || newAssignee,
        taskName,
        moduleName,
        taskKey: taskRecordKey(target, task),
        noticeText,
    });
}

const CLOSE_HOLD_MS = 2 * 24 * 60 * 60 * 1000;

function isSystemRequester(name) {
    const base = personBaseName(name).toLowerCase();
    return !base || base === "system";
}

function completionWindowOpen(task) {
    if (!task || task.status === "Completed" || task.status === "Cancelled" || task.status === "Rejected") return false;
    const at = task.closeRequest?.completesAt ? new Date(task.closeRequest.completesAt).getTime() : 0;
    return Boolean(at) && at > Date.now();
}

function scheduleCompletion(from = new Date()) {
    return new Date(from.getTime() + CLOSE_HOLD_MS);
}

async function viewerIsTaskRequester(task, viewer, action = null) {
    const requestedByName = task?.requestedByName || action?.requestedByName || "";
    if (!task && !action) return false;
    if (isSystemRequester(requestedByName)) return Boolean(viewer?.superUser);
    if (task?.requestedByUserId && viewer?.userId && String(task.requestedByUserId) === String(viewer.userId)) return true;
    const requesterName = personBaseName(requestedByName);
    const requester = await findEmployeeByName(requesterName);
    if (viewerMatchesEmployee(viewer, requester)) return true;
    const viewerName = personBaseName(viewer?.name).toLowerCase();
    return Boolean(viewerName && viewerName === requesterName.toLowerCase());
}

function generalTaskClosed(task) {
    if (!task) return false;
    const reviewable = isGeneralTask(task) || String(task.taskType || "") === "System Task";
    if (!reviewable || task.status !== "Completed") return false;
    const saved = closeSnapshot(task);
    return Boolean(saved.closedAt) && !saved.reviewPending;
}

async function viewerCanReopen(task, viewer) {
    const owner = await viewerIsTaskRequester(task, viewer);
    if (!owner) return false;
    if (completionWindowOpen(task)) return true;
    return generalTaskClosed(task);
}

async function notifyRequesterTaskClosed(task, target) {
    if (!task) return { sent: false };
    const saved = closeSnapshot(task);
    if (saved.requesterNotifiedAt) return { sent: false, already: true };
    if (isSystemRequester(task.requestedByName)) return { sent: false, system: true };
    const requester = await findEmployeeByName(personBaseName(task.requestedByName));
    const companyEmail = await businessEmail(requester);
    const requesterName = personName(requester) || personBaseName(task.requestedByName) || "there";
    const link = taskDetailLink(target);
    const recordId = String(target?.action?._id || task._id || "");
    const sentence = task.status === "Completed"
        ? "Your task is closed."
        : "Your task is closed. You can reopen it by opening this page and choosing Reopen Request. After 2 days the status becomes Completed and Reopen Request is disabled.";
    let channel = "";
    if (companyEmail) {
        const sent = await sendTaskActivityEmail({
            to: [companyEmail],
            subject: `Your task is closed: ${task.taskName || "Task"}`,
            html: taskActionHtml({
                hello: requesterName,
                lines: [sentence],
                taskName: task.taskName,
                link,
            }),
            recordId,
            emailType: "Task closed",
        });
        if (sent?.sent) channel = "email";
    } else if (requester?.employeeId) {
        const phone = await resolveEmployeeWhatsAppPhone(requester.employeeId);
        if (phone) {
            const result = await sendTextMessage(
                phone,
                `${sentence} ${task.taskName || "Task"}. ${link}`,
                {
                    source: "auto",
                    skipPaidChannelCheck: true,
                    employeeId: requester.employeeId || "",
                    contactName: requesterName,
                },
            );
            if (result?.success === true) channel = "whatsapp";
        }
    }
    if (!channel) return { sent: false };
    const told = channel === "whatsapp"
        ? `${requesterName} was sent a WhatsApp message that this task is closed and can be reopened.`
        : `${requesterName} was emailed that this task is closed and can be reopened.`;
    task.closeRequest = {
        ...closeSnapshot(task),
        requesterNotifiedAt: new Date(),
        requesterChannel: channel,
    };
    task.markModified("closeRequest");
    task.history = task.history || [];
    task.history.push(historyEntry("Requester Notified", told, "Task Manager"));
    await pushWorkUpdate(task, {
        authorName: "Task Manager",
        authorRole: "",
        kind: "Closed",
        badge: channel === "whatsapp" ? "WhatsApp" : "Email",
        text: told,
    }, SILENT_MAIL);
    await task.save();
    return { sent: true, channel };
}

function dashboardActionIsClosed(action) {
    return ["Approved", "Rejected", "Dismissed", "Completed", "Cancelled"].includes(String(action?.status || ""));
}

async function closeFlags(task, viewer, currentAssigneeId, assigneeEmpId, action = null) {
    const reassigned = taskWasReassigned(task);
    const saved = closeSnapshot(task);
    const completed = task?.status === "Completed" || (Boolean(saved.closedAt) && !saved.reviewPending);
    const requested = Boolean(saved.requestedAt);
    const notified = Boolean(saved.assigneeNotifiedAt);
    const closed = Boolean(saved.closedAt);
    const viewerIsAssignee = viewerIsCurrentAssignee(viewer, {
        assigneeId: currentAssigneeId,
        assigneeEmpId,
        assigneeName: task?.assigneeName,
    });
    const original = reassigned ? await resolveOriginalAssignee(task) : null;
    const viewerIsOriginal = viewerMatchesEmployee(viewer, original);
    const cancelled = task?.status === "Cancelled" || task?.status === "Rejected";
    // A workflow request can be open before anyone edits it, so there is no task row yet.
    const open = task
        ? !completed && !cancelled
        : Boolean(action) && !dashboardActionIsClosed(action);
    const completionPending = Boolean(saved.completionRequestedAt) && !saved.completionConfirmedAt && !completed;
    const closeScheduled = completionWindowOpen(task);
    const requesterViewer = await viewerIsTaskRequester(task, viewer, action);
    const viewerIsReassignee = Boolean(reassigned && viewerIsAssignee && !viewerIsOriginal);
    const viewerIsOriginalAssignee = reassigned ? viewerIsOriginal : viewerIsAssignee;
    const alreadyRejected = cancelled || ["Rejected", "Cancelled", "Dismissed"].includes(String(action?.status || ""));
    let closeMessage = "";
    if (closeScheduled) {
        closeMessage = "This task is closed. The status becomes Completed after 2 days. Reopen Request is disabled once the status is Completed.";
    } else if (closed) {
        closeMessage = saved.requesterChannel === "whatsapp"
            ? "The requester was sent one WhatsApp message that this request is completed."
            : saved.requesterChannel === "email"
                ? "The requester was emailed that this request is completed."
                : "This request is closed.";
    } else if (completionPending) {
        closeMessage = `${saved.completionRequestedByName || "The reassigned employee"} asked to close this task. Confirm close.`;
    } else if (notified) {
        closeMessage = `${saved.requestedByName || "The reassigned employee"} completed this task. The assignee can close this request.`;
    }
    const holder = viewer?.superUser || viewerIsAssignee;
    const general = isGeneralTask(task);
    const taskType = String(task?.taskType || '');
    const systemOrWorkflow = taskType === 'System Task' || taskType === 'Workflow Task' || taskType === 'Work Flow Task';
    const reviewPending = Boolean(saved.reviewPending) && !completed;
    const flags = {
        reassigned,
        canReassign: open && (viewer?.superUser || viewerIsAssignee || viewerIsOriginal),
        canReturn: open && reassigned && viewerIsAssignee && !viewerIsOriginal,
        canSubmitCompletion: open && reassigned && viewerIsAssignee && !viewerIsOriginal && !completionPending && !closeScheduled,
        canConfirmComplete: open && reassigned && completionPending && (viewerIsOriginal || viewer?.superUser) && !closeScheduled,
        completionPending,
        completionByName: saved.completionRequestedByName || "",
        completionNote: saved.completionNote || "",
        canComplete: false,
        canMarkRejected: false,
        canMarkCompleted: false,
        canRejectWithNote: !alreadyRejected && open && (requesterViewer || viewerIsOriginalAssignee) && !viewerIsReassignee && !(systemOrWorkflow && reassigned),
        canHandBackToOriginal: open && viewerIsReassignee && !systemOrWorkflow && !reviewPending && !closeScheduled,
        canCloseNow: open && !reassigned && (viewerIsAssignee || viewer?.superUser) && !general && !reviewPending && !closeScheduled,
        canRequestClose: completed && reassigned && holder && !notified && !closed,
        canFinishClose: completed && requested && !closed && viewerIsOriginal,
        canReopen: (closeScheduled && requesterViewer) || (completed && requesterViewer && Boolean(saved.closedAt) && general),
        showReopen: requesterViewer && (closeScheduled || (completed && Boolean(saved.closedAt) && general) || Boolean(saved.completesAt)),
        closeScheduled,
        closeState: closed ? "closed" : completionPending ? "confirm" : notified ? "requested" : "none",
        closeMessage,
        canCompleteGeneral: false,
        canApproveGeneral: false,
        canRejectGeneral: false,
    };
    const needsRequesterReview = general;
    if (!needsRequesterReview) return flags;
    if (reviewPending) {
        flags.closeMessage = `${saved.completionRequestedByName || saved.returnAssigneeName || "The assignee"} completed this task. Approve to close it, or reject it with a reason.`;
    } else if (saved.reviewReturned && open) {
        flags.closeMessage = "This task was rejected and is open again for the assignee.";
    }
    return {
        ...flags,
        canSubmitCompletion: false,
        canConfirmComplete: false,
        canMarkRejected: false,
        canMarkCompleted: false,
        canRejectWithNote: flags.canRejectWithNote && !reviewPending,
        canHandBackToOriginal: false,
        canCloseNow: false,
        canRequestClose: false,
        canFinishClose: false,
        canCompleteGeneral: open && (viewerIsAssignee || viewer?.superUser) && !reviewPending,
        canApproveGeneral: reviewPending && (requesterViewer || viewer?.superUser),
        canRejectGeneral: reviewPending && (requesterViewer || viewer?.superUser),
    };
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

const EMPLOYEE_RECORD_TYPES = new Set([
    "Employee Document Expiry Reminder",
    "Employee Document Not Renew",
    "Profile Activation",
    "Profile Incomplete",
    "Probation Change",
    "Left User Request",
    "Card Deleted Progress",
    "Salary Enrollment",
    "Salary DMF Approval",
    "Notice Request",
]);

const COMPANY_RECORD_TYPES = new Set([
    "Document Expiry Reminder",
    "Company Activation",
    "Company Activation Incomplete",
    "Company Document Not Renew",
]);

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

/** Extra facts from the record this task points at. Missing records stay blank. */
async function loadTaskSourceFacts(action) {
    const type = String(action?.requestType || "");
    if (isAttendanceTaskType(type)) {
        const map = await attendanceFactsByActionId([action]);
        return map.get(String(action?._id || "")) || {};
    }
    const id = String(action?.requestId || "");
    if (!isObjectId(id)) return {};
    try {
        if (type === "Fine" || type === "Group Fine Request") {
            const fine = await Fine.findById(id)
                .select("fineId fineType fineAmount description remarks companyDescription assignedEmployees assetId fineStatus")
                .lean();
            if (!fine) return {};
            const people = fine.assignedEmployees || [];
            return {
                fineId: fine.fineId || "",
                fineType: fine.fineType || "",
                amount: fine.fineAmount != null ? fine.fineAmount : "",
                reason: [fine.description, fine.remarks, fine.companyDescription].filter(Boolean).join(". "),
                employeeName: people.map((row) => row.employeeName).filter(Boolean).join(", "),
                employeeId: people.map((row) => row.employeeId).filter(Boolean).join(", "),
                assetNo: fine.assetId || "",
                status: fine.fineStatus || "",
            };
        }
        if (type === "Loan" || type === "Employee Loan Request" || type === "Employee Advance Request" || type === "Advance") {
            const loan = await Loan.findById(id)
                .select("type amount reason employeeId duration monthStart eligibilityNotes status")
                .lean();
            if (!loan) return {};
            return {
                loanType: loan.type || "",
                amount: loan.amount != null ? loan.amount : "",
                reason: [loan.reason, loan.eligibilityNotes].filter(Boolean).join(". "),
                employeeId: loan.employeeId || "",
                duration: loan.duration ? `${loan.duration} months` : "",
                monthStart: loan.monthStart || "",
                status: loan.status || "",
            };
        }
        if (type === "Reward") {
            const reward = await Reward.findById(id)
                .select("rewardId rewardType amount remarks employeeName employeeId rewardStatus")
                .lean();
            if (!reward) return {};
            return {
                rewardType: reward.rewardType || "",
                amount: reward.amount != null ? reward.amount : "",
                reason: reward.remarks || "",
                employeeName: reward.employeeName || "",
                employeeId: reward.employeeId || "",
                reference: reward.rewardId || "",
                status: reward.rewardStatus || "",
            };
        }
        if (type === "Payment Approval") {
            const payment = await Payment.findById(id)
                .select("paymentId paymentType amount description paidByName status referenceId")
                .lean();
            if (!payment) return {};
            return {
                paymentType: payment.paymentType || "",
                amount: payment.amount != null ? payment.amount : "",
                reason: payment.description || "",
                employeeName: payment.paidByName || "",
                reference: payment.paymentId || payment.referenceId || "",
                status: payment.status || "",
            };
        }
        if (type === "Vehicle Service Request") {
            const meta = readMeta(action.extra3);
            const asset = await AssetItem.findById(id)
                .select("assetId name plateEmirate plateNumber services._id services.serviceReqNo services.serviceType services.description services.currentKm services.paidBy services.value services.workflowSnapshot.stage")
                .lean();
            if (!asset) return {};
            const serviceId = String(meta.serviceRecordId || "");
            const service = (asset.services || []).find((row) => String(row?._id || "") === serviceId);
            const plate = [asset.plateEmirate, asset.plateNumber].filter(Boolean).join(" ").trim();
            return {
                assetNo: asset.assetId || "",
                assetName: asset.name || "",
                vehicleNo: plate || "",
                serviceNo: service?.serviceReqNo || "",
                serviceType: service?.serviceType || meta.serviceType || "",
                stage: service?.workflowSnapshot?.stage || "",
                currentKm: service?.currentKm ?? "",
                reason: service?.description || "",
                status: service?.paidBy ? `Paid by ${service.paidBy}` : "",
                amount: service?.value != null && service.value !== "" ? service.value : "",
            };
        }
        if (COMPANY_RECORD_TYPES.has(type)) {
            const company = await Company.findById(id).select("name companyId").lean();
            if (!company) return {};
            return { companyName: company.name || "", companyId: company.companyId || "" };
        }
        if (EMPLOYEE_RECORD_TYPES.has(type)) {
            const employee = await EmployeeBasic.findById(id)
                .select("firstName lastName employeeId department designation")
                .lean();
            if (!employee) return {};
            return {
                employeeName: [employee.firstName, employee.lastName].filter(Boolean).join(" ").trim(),
                employeeId: employee.employeeId || "",
                department: employee.department || "",
                designation: employee.designation || "",
            };
        }
    } catch (error) {
        console.error("Task source facts:", error?.message || error);
    }
    return {};
}

async function alignTaskWithAttendanceRequest(target) {
    const task = target?.task;
    const requestId = String(target?.action?.requestId || "").trim();
    if (!task?.save || !isObjectId(requestId)) return;
    const change = await AttendanceChangeRequest.findById(requestId).select("stage").lean()
        || await AttendanceChangeRequest.findOne({
            "proposed.attendanceId": requestId,
            stage: { $ne: "superseded" },
        }).sort({ updatedAt: -1 }).select("stage").lean();
    const stage = String(change?.stage || "");
    const open = stage === "pending_reportee" || stage === "pending_hr" || stage === "pending_requester";
    if (stage === "rejected" && task.status !== "Cancelled") {
        task.status = "Cancelled";
        await task.save();
    } else if (open && ["Completed", "Cancelled", "Rejected"].includes(String(task.status || ""))) {
        task.status = "In Progress";
        await task.save();
    }
}

async function buildDetail(target, viewer) {
    await alignTaskWithAttendanceRequest(target);
    const manual = target.kind === "manual";
    const task = target.task;
    const action = target.action;
    const assigneeId = manual ? task.assignee : task?.assignee || action.assignedTo;
    const assigneeCode = manual ? task.assigneeEmpId : task?.assigneeEmpId || action.assignedToEmpId;
    const people = await loadPeopleDetails([assigneeId], [assigneeCode]);
    const { byId, byCode } = peopleIndex(people);
    const assigneeEmp = byId.get(String(assigneeId || "")) || byCode.get(String(assigneeCode || "")) || null;
    const sourceRequesters = await sourceRequesterNameMap(action ? [action] : []);
    const requesterName = displayRequesterName(
        preferRequesterName(task?.requestedByName, action?.requestedByName),
        action,
        sourceRequesters,
    ) || "System";
    const requester = await findEmployeeByName(personBaseName(requesterName) || requesterName);
    let destination = manual
        ? moduleForText(task.taskName, task.description, task.taskType)
        : moduleForRequestType(action.requestType, `${action.extra1 || ""} ${action.extra2 || ""}`);
    const cardAssignee = contactCard(assigneeEmp);
        if (!cardAssignee.name) cardAssignee.name = task?.assigneeName || "Unassigned";
    const cardRequester = contactCard(requester);
    if (!cardRequester.name) cardRequester.name = personBaseName(requesterName) || requesterName;
    const heldAssignee = String(task?.closeRequest?.returnAssigneeName || "").trim();
    if (heldAssignee) {
        const requesterPlain = personBaseName(cardRequester.name) || cardRequester.name;
        cardAssignee.name = !requesterPlain || requesterPlain.toLowerCase() === heldAssignee.toLowerCase()
            ? heldAssignee
            : `${heldAssignee} (${requesterPlain})`;
    }
    const originalAssigneeName = String(task?.closeRequest?.originalAssigneeName || "").trim();
    const originalAssigneeId = String(task?.closeRequest?.originalAssigneeId || "");

    const { assigneeId: currentAssigneeId, assigneeEmpId } = assigneeOf(target);
    const assigneePair = reassignmentAssignees({
        assigneeName: cardAssignee.name,
        originalAssigneeName,
    });
    const originalEmp = assigneePair.reassignedAssigneeName && isObjectId(originalAssigneeId)
        ? await employeeById(originalAssigneeId)
        : null;
    const vehicles = manual || !action ? new Map() : await vehicleDisplayById([action]);
    const source = manual || !action ? {} : await loadTaskSourceFacts(action);
    const workflowLocked = !manual && action?.requestType !== "Task Manager";
    let mailAction = action;
    if (!mailAction && isObjectId(task?.sourceDashboardActionId)) {
        mailAction = await DashboardAction.findById(task.sourceDashboardActionId);
    }
    if (!mailAction && /^expiry follow-up required:/i.test(String(task?.taskName || ""))) {
        const sameReminder = {
            extra1: task.taskName,
            requestType: {
                $in: [
                    "Vehicle Document Expiry Reminder",
                    "Employee Document Expiry Reminder",
                    "Document Expiry Reminder",
                ],
            },
        };
        const extra2 = String(task.description || "").trim();
        if (extra2) sameReminder.extra2 = extra2;
        mailAction = await DashboardAction.findOne(sameReminder).sort({ updatedAt: -1 });
    }
    if (manual && mailAction?.requestType) {
        destination = moduleForRequestType(
            mailAction.requestType,
            `${mailAction.extra1 || ""} ${mailAction.extra2 || ""} ${task?.taskName || ""} ${task?.description || ""}`,
        );
    }
    const taskTitle = String(task?.taskName || mailAction?.extra1 || "").trim();
    const expirySource = [mailAction?.extra1, task?.description, task?.taskName]
        .map((value) => String(value || "").trim())
        .find((value) => /expiry follow-up required:/i.test(value)) || "";
    const docLabel = documentLabelFromExpiryText(expirySource);
    const mailMeta = readActionMeta(mailAction?.extra3);
    const docType = String(mailMeta.vehicleDocType || mailMeta.docType || "").trim() || docTypeFromLabel(docLabel);
    const focusMatch = expirySource.match(/expiry follow-up required:\s*(.+?)(?:\s*[([\{]\s*exp:|$)/i);
    const requestType = String(mailAction?.requestType || "");
    const documentExpiry = /document expiry/i.test(requestType) || Boolean(docLabel);
    const broadRecord = !documentExpiry && /expiry|reminder/i.test(requestType);
    const vehicleService = requestType === "Vehicle Service Request";
    const exactIds = [action?._id, mailAction?._id, task?._id, task?.sourceDashboardActionId];
    const requestIds = [mailAction?.requestId, action?.requestId].map((id) => String(id || "").trim()).filter((id) => isObjectId(id));
    if (requestIds.length) {
        const siblings = await DashboardAction.find({ requestId: { $in: requestIds } }).select("_id requestId").lean();
        for (const row of siblings) exactIds.push(row._id);
        const changes = await AttendanceChangeRequest.find({
            $or: [
                { _id: { $in: requestIds } },
                { "proposed.attendanceId": { $in: requestIds.map(String) } },
            ],
        }).select("_id proposed.attendanceId").lean();
        const changeIds = [];
        for (const row of changes) {
            exactIds.push(row._id);
            if (row.proposed?.attendanceId) exactIds.push(row.proposed.attendanceId);
            changeIds.push(row._id);
        }
        if (changeIds.length) {
            const changeActions = await DashboardAction.find({ requestId: { $in: changeIds } }).select("_id").lean();
            for (const row of changeActions) exactIds.push(row._id);
        }
    }
    if (mailAction?._id) await attachStoredEmailsToAction(mailAction);
    const taskEmails = await findEmailsForTask({ ids: exactIds });
    let recordEmails = [];
    if (vehicleService) {
        const meta = readActionMeta(mailAction?.extra3);
        const assetId = String(mailAction?.requestId || "").trim();
        const serviceRecordId = String(meta.serviceRecordId || "").trim();
        let serviceType = String(meta.serviceType || "").trim() || serviceTypeFromTaskText(`${taskTitle} ${mailAction?.extra1 || ""} ${mailAction?.extra2 || ""}`);
        let serviceReqNo = "";
        let exactAssetCode = "";
        if (isObjectId(assetId) && serviceRecordId) {
            const asset = await AssetItem.findById(assetId)
                .select("assetId services._id services.serviceReqNo services.serviceType")
                .lean();
            const service = (asset?.services || []).find((row) => String(row?._id || "") === serviceRecordId);
            serviceReqNo = String(service?.serviceReqNo || "").trim();
            if (!serviceType) serviceType = String(service?.serviceType || "").trim();
            if (asset?.assetId) exactAssetCode = String(asset.assetId).trim();
        }
        const candidates = await findEmailsForTask({
            ids: [assetId, serviceRecordId, serviceReqNo, exactAssetCode],
        });
        recordEmails = candidates.filter((row) => emailBelongsToVehicleService(row, {
            serviceRecordId,
            serviceReqNo,
            serviceType,
            assetId,
            assetCode: exactAssetCode,
        }));
    } else if (documentExpiry) {
        const recordId = String(mailAction?.requestId || mailMeta.vehicleMongoId || "").trim();
        const candidates = recordId
            ? await findEmailsForTask({
                ids: [recordId],
                prefixes: [recordId],
                onlyExpiry: true,
            })
            : [];
        recordEmails = candidates.filter((row) => emailBelongsToDocumentExpiry(row, { docLabel, docType }));
    } else if (broadRecord) {
        const focus = focusMatch ? focusMatch[1].trim() : "";
        recordEmails = await findEmailsForTask({
            prefixes: focus ? [mailAction?.requestId] : [],
            focus,
            requireFocus: true,
        });
    } else {
        recordEmails = await findEmailsForTask({
            ids: [
                mailAction?.requestId,
                action?.requestId,
                mailMeta.attendanceId,
                mailMeta.leaveRequestGroupId,
                mailMeta.groupId,
            ],
        });
    }
    const seenEmail = new Set();
    const seenBody = new Set();
    const emails = [];
    for (const row of [...taskEmails, ...recordEmails]) {
        const id = String(row?.id || "");
        const bodyKey = `${row?.subject || ""}\n${(row?.to || []).join(",")}\n${row?.html || ""}`;
        if (!id || seenEmail.has(id) || (row?.html && seenBody.has(bodyKey))) continue;
        seenEmail.add(id);
        if (row?.html) seenBody.add(bodyKey);
        emails.push(row);
    }
    emails.sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0));

    return {
        actionId: manual ? `manual-${task._id}` : String(action._id),
        manual,
        workflowLocked,
        canReassign: viewerCanReassign(viewer, currentAssigneeId, assigneeEmpId),
        canDelete: generalTaskClosed(task) ? false : Boolean(
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
        accessPath: (manual
            ? (displayTaskType(task?.taskType) || "General Task")
            : categoryFromRequestType(action?.requestType, action?.extra2 || "")) === "General Task"
            ? ""
            : accessPathFor(
                destination,
                (action || mailAction)?.requestId,
                (action || mailAction)?.subjectEmployeeId,
                {
                    extra1: (action || mailAction)?.extra1 || task?.taskName,
                    extra2: (action || mailAction)?.extra2 || task?.description,
                    extra3: (action || mailAction)?.extra3,
                    requestType: (action || mailAction)?.requestType,
                },
            ),
        ...taskTitleAndDescription({
            requestType: manual ? task?.taskType : action?.requestType,
            extra1: manual ? task?.description : action?.extra1,
            extra2: manual ? "" : action?.extra2,
            extra3: manual ? "" : action?.extra3,
            subjectName: manual ? "" : action?.subjectName,
            subjectEmployeeId: manual ? "" : action?.subjectEmployeeId,
            comment: manual ? "" : action?.comment,
            requestedBy: requesterName,
            taskName: task?.taskName,
            description: task?.description || (manual ? "" : action?.extra2),
            manual,
            source,
            ...(manual ? {} : vehicleDisplayFor(action, vehicles)),
        }),
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
        assigneePhoto: await signedProfilePhoto(cardAssignee.photo),
        mainAssigneeName: assigneePair.mainAssigneeName || cardAssignee.name,
        reassignedAssigneeName: assigneePair.reassignedAssigneeName,
        mainAssigneeRole: assigneePair.reassignedAssigneeName ? (originalEmp?.designation || "") : cardAssignee.role,
        mainAssigneePhoto: await signedProfilePhoto(
            assigneePair.reassignedAssigneeName ? (originalEmp?.profilePicture || "") : cardAssignee.photo,
        ),
        reassignedAssigneePhoto: assigneePair.reassignedAssigneeName
            ? await signedProfilePhoto(cardAssignee.photo)
            : "",
        originalAssigneeName,
        originalAssigneeId,
        requesterName: cardRequester.name,
        requesterBaseName: cardRequester.name,
        requesterRole: cardRequester.role,
        requesterEmail: cardRequester.email,
        requesterPhone: cardRequester.phone,
        requesterPhoto: await signedProfilePhoto(cardRequester.photo),
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
        handoff: await handoffPeople(task?.history, cardAssignee.name),
        ...(await closeFlags(task, viewer, currentAssigneeId, assigneeEmpId, action)),
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
        await promoteDueTaskCompletions();
        const target = await loadTarget(req.params.taskKey);
        if (!target) return res.status(404).json({ message: "Task not found." });
        if (target.action && /^(fine|group fine request)$/i.test(String(target.action.requestType || ""))) {
            const overlays = new Map();
            if (target.task) overlays.set(String(target.action._id), target.task);
            await alignOpenFineDashboardRows([target.action], overlays);
        }
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
        if (generalTaskClosed(target.task)) {
            return res.status(400).json({ message: "This task is closed. Edit is disabled." });
        }

        const taskType = canonicalTaskType(req.body?.taskType);
        const priority = String(req.body?.priority || "").trim();
        const taskName = String(req.body?.taskName || "").trim();
        const description = String(req.body?.description || "").trim();
        const assigneeId = String(req.body?.assigneeId || "").trim();
        const completionDate = parseCompletionDate(req.body?.completionDate);
        const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];

        if (taskType !== "General Task") {
            return res.status(400).json({ message: "Only General Task can be updated here." });
        }
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
        const previousAssigneeName = assigneeChanged
            ? await nameOfAssignee(previous, target.task?.assigneeName || viewer.name)
            : "";
        let saved;
        if (target.kind === "manual") {
            const task = target.task;
            if (assigneeChanged) rememberOriginalAssignee(task, previous, previousAssigneeName);
            task.taskType = taskType;
            task.priority = priority;
            task.taskName = taskName;
            task.description = description;
            task.assignee = assignee._id;
            task.assigneeEmpId = assignee.employeeId || "";
            task.assigneeName = assigneeName;
            task.completionDate = completionDate;
            if (storedFiles.length) task.attachments = [...(task.attachments || []), ...storedFiles];
            task.history = task.history || [];
            task.history.push(historyEntry("Edited", "Task details were updated.", viewer.name));
            if (assigneeChanged) {
                task.history.push(historyEntry("Reassigned", `Assignee changed to ${assigneeName}.`, viewer.name));
            }
            await emailTaskHistory(task, {
                event: assigneeChanged ? "Reassigned" : "Edited",
                detail: assigneeChanged
                    ? `Assignee changed to ${assigneeName}.`
                    : "Task details were updated.",
                actorName: viewer.name,
            });
            saved = await task.save();
            await syncManualTaskNotification(saved);
        } else {
            const action = target.action;
            let overlay = target.task;
            if (!overlay) overlay = await ensureOverlay(action);
            if (assigneeChanged) rememberOriginalAssignee(overlay, previous, previousAssigneeName);
            overlay.taskType = taskType;
            overlay.priority = priority;
            overlay.taskName = taskName;
            overlay.description = description;
            overlay.assignee = assignee._id;
            overlay.assigneeEmpId = assignee.employeeId || "";
            overlay.assigneeName = assigneeName;
            overlay.completionDate = completionDate;
            if (storedFiles.length) overlay.attachments = [...(overlay.attachments || []), ...storedFiles];
            overlay.history = overlay.history || [];
            overlay.history.push(historyEntry("Edited", "Task details were updated.", viewer.name));
            await emailTaskHistory(overlay, {
                event: "Edited",
                detail: "Task details were updated.",
                actorName: viewer.name,
            });
            saved = await overlay.save();
            action.extra1 = taskName;
            action.assignedTo = assignee._id;
            action.assignedToEmpId = assignee.employeeId || "";
            await action.save();
        }

        if (assigneeChanged && saved) {
            const destination = moduleForText(taskName, description, taskType, target.action?.requestType);
            try {
                await collapseOpenDuplicatesOf(target.action);
            } catch (collapseError) {
                console.error("Duplicate task cleanup failed:", collapseError);
            }
            try {
                await keepReassignmentVisible(saved, target, {
                    previous,
                    newAssignee: assignee,
                    reassigneeName: assigneeName,
                    taskName,
                    moduleName: destination.module,
                });
            } catch (noticeError) {
                console.error("Reassignment notice failed:", noticeError);
            }
            try {
                await sendTaskReassignedEmail({
                    toEmp: assignee,
                    taskName,
                    taskNumber: "",
                    reason: "The task was updated and assigned to you.",
                    modulePath: destination.path,
                    taskPath: taskOpenPath(taskRecordKey(target, saved)),
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
        if (generalTaskClosed(target.task)) {
            return res.status(400).json({ message: "This task is closed. Reassign is disabled." });
        }
        const viewer = await resolveTaskViewer(req);
        const current = assigneeOf(target);
        const originalPerson = target.task ? await resolveOriginalAssignee(target.task) : null;
        if (!viewerCanReassign(viewer, current.assigneeId, current.assigneeEmpId) && !viewerMatchesEmployee(viewer, originalPerson)) {
            return res.status(403).json({
                message: "Only the current assignee, the original assignee, or the admin super user can reassign this task.",
            });
        }

        const assigneeId = String(req.body?.assigneeId || "").trim();
        const reason = String(req.body?.reason || "").trim();
        const notifyRequester = req.body?.notifyRequester !== false;
        if (!isObjectId(assigneeId)) return res.status(400).json({ message: "Select a new assignee." });
        if (!reason) return res.status(400).json({ message: "Reason for reassignment is required." });
        if (reason.length > 500) return res.status(400).json({ message: "Reason must be 500 characters or less." });

        const assignee = await findAssignee(assigneeId);
        if (!assignee) return res.status(400).json({ message: "Selected assignee was not found." });
        const assigneeName = personName(assignee) || assignee.employeeId || "Unassigned";
        const previousName = await nameOfAssignee(
            current,
            target.kind === "manual" ? target.task?.assigneeName : target.task?.assigneeName || "",
        );
        const detail = `Reassigned from ${previousName || "the previous assignee"} to ${assigneeName}. ${reason}`;

        let taskName = "";
        let requesterName = "";
        let modulePath = "/task-manager";
        let moduleName = "general";
        let noticeTask = null;

        if (target.kind === "manual") {
            const task = target.task;
            rememberOriginalAssignee(task, current, previousName);
            clearPendingCompletion(task);
            task.assignee = assignee._id;
            task.assigneeEmpId = assignee.employeeId || "";
            task.assigneeName = assigneeName;
            task.history = task.history || [];
            task.history.push(historyEntry("Reassigned", detail, viewer.name));
            await pushWorkUpdate(task, {
                authorName: viewer.name,
                authorRole: await authorRoleFor(viewer),
                kind: "Reassigned",
                badge: "Reassigned",
                text: detail,
            }, SILENT_MAIL);
            await task.save();
            await syncManualTaskNotification(task);
            taskName = task.taskName;
            requesterName = task.requestedByName;
            const destination = moduleForText(task.taskName, task.description, task.taskType);
            modulePath = destination.path;
            moduleName = destination.module;
            noticeTask = task;
        } else {
            const action = target.action;
            action.assignedTo = assignee._id;
            action.assignedToEmpId = assignee.employeeId || "";
            await action.save();
            let overlay = target.task;
            if (!overlay) overlay = await ensureOverlay(action);
            rememberOriginalAssignee(overlay, current, previousName);
            clearPendingCompletion(overlay);
            overlay.assignee = assignee._id;
            overlay.assigneeEmpId = assignee.employeeId || "";
            overlay.assigneeName = assigneeName;
            overlay.history = overlay.history || [];
            overlay.history.push(historyEntry("Reassigned", detail, viewer.name));
            await pushWorkUpdate(overlay, {
                authorName: viewer.name,
                authorRole: await authorRoleFor(viewer),
                kind: "Reassigned",
                badge: "Reassigned",
                text: detail,
            }, SILENT_MAIL);
            await overlay.save();
            taskName = overlay.taskName || action.extra1 || action.requestType;
            requesterName = overlay.requestedByName || action.requestedByName || "";
            const destination = moduleForRequestType(action.requestType, `${action.extra1 || ""} ${action.extra2 || ""}`);
            modulePath = destination.path;
            moduleName = destination.module;
            noticeTask = overlay;
        }

        try {
            await collapseOpenDuplicatesOf(target.action || noticeTask);
        } catch (collapseError) {
            console.error("Duplicate task cleanup failed:", collapseError);
        }
        try {
            await keepReassignmentVisible(noticeTask, target, {
                previous: current,
                newAssignee: assignee,
                reassigneeName: assigneeName,
                taskName,
                moduleName,
            });
        } catch (noticeError) {
            console.error("Reassignment notice failed:", noticeError);
        }
        const openPath = taskOpenPath(taskRecordKey(target, noticeTask));
        const recordId = String(target.action?._id || noticeTask?._id || "");
        const link = `${emailFrontendUrl()}${openPath}`;

        let emailSent = false;
        try {
            const result = await sendTaskReassignedEmail({
                toEmp: assignee,
                taskName,
                taskNumber: "",
                reason,
                modulePath,
                taskPath: openPath,
                requesterName,
                recordId,
            });
            emailSent = Boolean(result.sent);
        } catch (mailError) {
            console.error("Reassignment email failed:", mailError);
        }
        if (isObjectId(current.assigneeId) && String(current.assigneeId) !== String(assignee._id)) {
            try {
                const previousEmp = await employeeById(current.assigneeId);
                const previousMail = await mailEmployee(previousEmp, {
                    subject: `Task reassigned: ${taskName || "Task"}`,
                    html: taskActionHtml({
                        hello: personName(previousEmp) || previousName || "there",
                        lines: [
                            `This task is now also with ${assigneeName}.`,
                            "It stays on your tasks until they close it and you confirm.",
                        ],
                        taskName,
                        description: reason,
                        link,
                    }),
                    recordId,
                    emailType: "Task reassigned",
                });
                if (previousMail?.sent) emailSent = true;
            } catch (mailError) {
                console.error("Previous assignee reassignment email failed:", mailError);
            }
        }
        if (notifyRequester && requesterName) {
            const requester = await findEmployeeByName(personBaseName(requesterName));
            if (requester) {
                try {
                    await sendTaskReassignedEmail({
                        toEmp: requester,
                        taskName,
                        reason: `${assigneeName} is now assigned. ${reason}`,
                        modulePath,
                        taskPath: openPath,
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
                ? "Task reassigned. It stays with the original assignee and the new assignee. The new assignee was emailed."
                : "Task reassigned. It stays with both assignees. The new assignee email could not be sent.",
            emailSent,
            task: await buildDetail(fresh, viewer),
        });
    } catch (error) {
        console.error("Reassign task error:", error);
        return res.status(500).json({ message: "Failed to reassign task" });
    }
};

export const returnTaskManagerTask = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        const note = readDescription(req.body);
        if (note.error) return res.status(400).json({ message: note.error });
        const target = await loadTarget(req.params.taskKey);
        if (!target?.task) return res.status(404).json({ message: "Task not found." });
        const viewer = await resolveTaskViewer(req);
        const task = target.task;
        if (!taskWasReassigned(task)) return res.status(400).json({ message: "Only a reassigned task can be returned." });
        if (task.status === "Completed" || task.status === "Cancelled") {
            return res.status(400).json({ message: "This task is already closed." });
        }
        const current = assigneeOf(target);
        if (!viewerIsCurrentAssignee(viewer, { ...current, assigneeName: task.assigneeName })) {
            return res.status(403).json({ message: "Only the current assignee can return this task." });
        }
        const original = await resolveOriginalAssignee(task);
        if (!original) return res.status(400).json({ message: "The original assignee could not be found." });
        if (viewerMatchesEmployee(viewer, original)) {
            return res.status(400).json({ message: "This task is already with the original assignee." });
        }
        const originalName = personName(original) || task.closeRequest?.originalAssigneeName || "the original assignee";
        clearPendingCompletion(task);
        const text = `Returned to ${originalName}. ${note.text}`;
        if (target.kind !== "manual" && target.action) {
            target.action.assignedTo = original._id;
            target.action.assignedToEmpId = original.employeeId || "";
            await target.action.save();
        }
        task.assignee = original._id;
        task.assigneeEmpId = original.employeeId || "";
        task.assigneeName = originalName;
        task.history = task.history || [];
        task.history.push(historyEntry("Returned", text, viewer.name));
        await pushWorkUpdate(task, {
            authorName: viewer.name,
            authorRole: await authorRoleFor(viewer),
            kind: "Returned",
            badge: "Returned",
            text,
        }, SILENT_MAIL);
        await task.save();
        if (!task.sourceDashboardActionId) await syncManualTaskNotification(task);
        try {
            // The return stays on the task and in the email. It does not open a vehicle, employee, or company bell.
            await closeReassignmentNotices(task);
        } catch (noticeError) {
            console.error("Return notice clear failed:", noticeError);
        }
        const recordId = String(target.action?._id || task._id || "");
        let emailSent = false;
        try {
            const numberMap = await taskNumbersByRecordId([
                task.sourceDashboardActionId,
                target.action?._id,
                task._id,
                `manual-${task._id}`,
            ]);
            const taskNumber = numberMap.get(String(task.sourceDashboardActionId || target.action?._id || ""))
                || numberMap.get(`manual-${task._id}`)
                || numberMap.get(String(task._id || ""))
                || "";
            const sent = await mailEmployee(original, {
                subject: `Task returned to you: ${taskNumber || task.taskName || "Task"}`,
                html: taskActionHtml({
                    hello: originalName,
                    lines: [
                        `${viewer.name} returned this task to you.`,
                        `Task number: ${taskNumber || "—"}`,
                        `Task name: ${task.taskName || "Task"}`,
                    ],
                    taskName: task.taskName,
                    description: note.text,
                    link: taskDetailLink(target),
                }),
                recordId,
                emailType: "Task returned",
            });
            emailSent = Boolean(sent?.sent);
        } catch (mailError) {
            console.error("Return email failed:", mailError);
        }
        const fresh = await loadTarget(req.params.taskKey);
        return res.status(200).json({
            message: emailSent
                ? "Task returned. The original assignee was emailed."
                : "Task returned. The original assignee email could not be sent.",
            emailSent,
            task: await buildDetail(fresh, viewer),
        });
    } catch (error) {
        console.error("Return task error:", error);
        return res.status(500).json({ message: "Failed to return task" });
    }
};

async function resolveTaskRequesterEmployee(task) {
    const byName = await findEmployeeByName(personBaseName(task?.requestedByName));
    if (byName) return byName;
    return null;
}

export const submitTaskCompletion = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        const note = readDescription(req.body);
        if (note.error) return res.status(400).json({ message: note.error });
        const target = await loadTarget(req.params.taskKey);
        if (!target) return res.status(404).json({ message: "Task not found." });
        if (!target.task && target.action) {
            const category = categoryFromRequestType(target.action.requestType, target.action.extra1);
            if (category === "General Task") {
                target.task = await ensureOverlay(target.action);
                target.task.taskType = "General Task";
            }
        }
        if (!target.task) return res.status(404).json({ message: "Task not found." });
        const viewer = await resolveTaskViewer(req);
        const task = target.task;
        const systemTask = String(task.taskType || '') === 'System Task';
        const workflowTask = String(task.taskType || '') === 'Workflow Task' || String(task.taskType || '') === 'Work Flow Task';
        const currentAssignee = assigneeOf(target);
        const originalAssignee = taskWasReassigned(task) ? await resolveOriginalAssignee(task) : null;
        const viewerIsReassignedHolder = Boolean(
            originalAssignee
            && viewerIsCurrentAssignee(viewer, currentAssignee)
            && !viewerMatchesEmployee(viewer, originalAssignee),
        );
        if (viewerIsReassignedHolder && !systemTask && !workflowTask) {
            if (task.status === 'Completed' || task.status === 'Cancelled' || task.status === 'Rejected') {
                return res.status(400).json({ message: 'This task is already closed.' });
            }
            const originalName = personName(originalAssignee) || 'the original assignee';
            task.assignee = originalAssignee._id;
            task.assigneeEmpId = originalAssignee.employeeId || '';
            task.assigneeName = originalName;
            task.status = 'Pending';
            task.history = task.history || [];
            task.history.push(historyEntry('Returned', `${viewer.name} completed this task and returned it to ${originalName}. ${note.text}`, viewer.name));
            await pushWorkUpdate(task, {
                authorName: viewer.name,
                authorRole: await authorRoleFor(viewer),
                kind: 'Work Update',
                badge: 'Pending',
                text: note.text,
            }, SILENT_MAIL);
            await task.save();
            if (!task.sourceDashboardActionId) await syncManualTaskNotification(task);
            let emailSent = false;
            try {
                const sent = await mailEmployee(originalAssignee, {
                    subject: `Task returned for you to close: ${task.taskName || 'Task'}`,
                    html: taskActionHtml({
                        hello: originalName,
                        lines: [`${viewer.name} completed this reassigned task. Close it to finish.`],
                        taskName: task.taskName,
                        description: note.text,
                        link: taskDetailLink(target),
                    }),
                    recordId: String(target.action?._id || task._id || ''),
                    emailType: 'Task returned',
                });
                emailSent = Boolean(sent?.sent);
            } catch (mailError) {
                console.error('Hand-back email failed:', mailError);
            }
            const freshHandback = await loadTarget(req.params.taskKey);
            return res.status(200).json({
                message: emailSent
                    ? 'Returned to the original assignee. They were emailed.'
                    : 'Returned to the original assignee. The email could not be sent.',
                emailSent,
                task: await buildDetail(freshHandback, viewer),
            });
        }
        if (!isGeneralTask(task) && !viewerIsReassignedHolder && viewerIsCurrentAssignee(viewer, currentAssignee)) {
            if (task.status === 'Completed' || task.status === 'Cancelled' || task.status === 'Rejected') {
                return res.status(400).json({ message: 'This task is already closed.' });
            }
            task.status = 'Completed';
            const savedClose = closeSnapshot(task);
            task.closeRequest = {
                ...savedClose,
                closedAt: new Date(),
                closedByName: viewer.name,
                completesAt: null,
                reviewPending: false,
            };
            task.markModified('closeRequest');
            task.history = task.history || [];
            task.history.push(historyEntry('Closed', `${viewer.name} closed this task. ${note.text}`, viewer.name));
            await pushWorkUpdate(task, {
                authorName: viewer.name,
                authorRole: await authorRoleFor(viewer),
                kind: 'Work Update',
                badge: 'Closed',
                text: note.text,
            }, SILENT_MAIL);
            await task.save();
            if (!task.sourceDashboardActionId) await syncManualTaskNotification(task);
            let requesterMailed = false;
            try {
                const requester = await resolveTaskRequesterEmployee(task);
                const requesterName = personName(requester) || personBaseName(task.requestedByName) || 'there';
                const sent = await mailEmployee(requester, {
                    subject: `Task closed: ${task.taskName || 'Task'}`,
                    html: taskActionHtml({
                        hello: requesterName,
                        lines: [`${viewer.name} closed this task.`],
                        taskName: task.taskName,
                        description: note.text,
                        link: taskDetailLink(target),
                    }),
                    recordId: String(target.action?._id || task._id || ''),
                    emailType: 'Task closed',
                });
                requesterMailed = Boolean(sent?.sent);
            } catch (mailError) {
                console.error('Requester close email failed:', mailError);
            }
            const freshClosed = await loadTarget(req.params.taskKey);
            return res.status(200).json({
                message: requesterMailed
                    ? 'Task closed. The requester was emailed.'
                    : 'Task closed. The requester email could not be sent.',
                emailSent: requesterMailed,
                task: await buildDetail(freshClosed, viewer),
            });
        }
        if (isGeneralTask(task)) {
            if (task.status === "Completed" || task.status === "Cancelled" || task.status === "Rejected") {
                return res.status(400).json({ message: "This task is already closed." });
            }
            const saved = closeSnapshot(task);
            if (saved.reviewPending) {
                return res.status(400).json({ message: "This task is already with the requester for review." });
            }
            const current = assigneeOf(target);
            if (!viewer?.superUser && !viewerIsCurrentAssignee(viewer, current)) {
                return res.status(403).json({ message: "Only the assignee can complete this task." });
            }
            const requester = await resolveTaskRequesterEmployee(task);
            if (!requester?._id) {
                return res.status(400).json({ message: "The original requester could not be found." });
            }
            const requesterName = personName(requester) || personBaseName(task.requestedByName) || "the requester";
            const assigneeName = task.assigneeName || viewer.name || "The assignee";
            task.closeRequest = {
                ...saved,
                reviewPending: true,
                reviewReturned: false,
                reviewNote: note.text,
                completionRequestedAt: new Date(),
                completionRequestedByName: viewer.name,
                completionNote: note.text,
                returnAssigneeId: task.assignee || null,
                returnAssigneeEmpId: task.assigneeEmpId || "",
                returnAssigneeName: assigneeName,
                completesAt: null,
            };
            task.markModified("closeRequest");
            task.status = "Pending";
            task.history = task.history || [];
            task.history.push(historyEntry("Pending Review", `${viewer.name} completed this task. ${note.text}`, viewer.name));
            await pushWorkUpdate(task, {
                authorName: viewer.name,
                authorRole: await authorRoleFor(viewer),
                kind: "Work Update",
                badge: "Pending Review",
                text: note.text,
            }, SILENT_MAIL);
            await task.save();
            await syncManualTaskNotification(task);
            let emailSent = false;
            try {
                const sent = await mailEmployee(requester, {
                    subject: `Review completed task: ${task.taskName || "Task"}`,
                    html: taskActionHtml({
                        hello: requesterName,
                        lines: [
                            `${viewer.name} completed this task and sent it to you for review.`,
                            "Approve to close it, or reject it with a reason.",
                        ],
                        taskName: task.taskName,
                        description: note.text,
                        link: taskDetailLink(target),
                    }),
                    recordId: String(task._id || ""),
                    emailType: "Task review",
                });
                emailSent = Boolean(sent?.sent);
            } catch (mailError) {
                console.error("General task review email failed:", mailError);
            }
            const fresh = await loadTarget(req.params.taskKey);
            return res.status(200).json({
                message: emailSent
                    ? "Sent to the requester for review. They were emailed."
                    : "Sent to the requester for review. The requester email could not be sent.",
                emailSent,
                task: await buildDetail(fresh, viewer),
            });
        }
        if (!taskWasReassigned(task)) {
            return res.status(400).json({ message: "Close confirmation is for a task that was reassigned." });
        }
        if (task.status === "Completed" || task.status === "Cancelled") {
            return res.status(400).json({ message: "This task is already closed." });
        }
        const current = assigneeOf(target);
        const original = await resolveOriginalAssignee(task);
        if (!original) return res.status(400).json({ message: "The original assignee could not be found." });
        if (!viewerIsCurrentAssignee(viewer, current) || viewerMatchesEmployee(viewer, original)) {
            return res.status(403).json({ message: "Only the reassigned employee can send this for confirmation." });
        }
        const saved = closeSnapshot(task);
        if (saved.completionRequestedAt && !saved.completionConfirmedAt) {
            return res.status(400).json({ message: "This task is already waiting for the original assignee to confirm." });
        }
        const text = `${viewer.name} asked to close this task. ${note.text}`;
        task.closeRequest = {
            ...saved,
            completionRequestedAt: new Date(),
            completionRequestedById: isObjectId(viewer.employeeObjectId) ? viewer.employeeObjectId : (isObjectId(current.assigneeId) ? current.assigneeId : null),
            completionRequestedByName: viewer.name,
            completionNote: note.text,
            completionConfirmedAt: null,
        };
        task.markModified("closeRequest");
        task.history = task.history || [];
        task.history.push(historyEntry("Close", text, viewer.name));
        await pushWorkUpdate(task, {
            authorName: viewer.name,
            authorRole: await authorRoleFor(viewer),
            kind: "Close",
            badge: "Confirm",
            text,
        }, SILENT_MAIL);
        await task.save();
        const destination = target.kind === "manual"
            ? moduleForText(task.taskName, task.description, task.taskType)
            : moduleForRequestType(target.action?.requestType, `${target.action?.extra1 || ""} ${target.action?.extra2 || ""}`);
        if (original?._id) {
            try {
                await upsertTaskNotice(task, {
                    employeeId: original._id,
                    empId: original.employeeId || "",
                    taskName: task.taskName,
                    moduleName: destination.module,
                    taskKey: taskRecordKey(target, task),
                    noticeText: `${viewer.name} asked to close this task. Confirm close.`,
                });
            } catch (noticeError) {
                console.error("Completion notice failed:", noticeError);
            }
        }
        let emailSent = false;
        try {
            const sent = await mailEmployee(original, {
                subject: `Confirm close: ${task.taskName || "Task"}`,
                html: taskActionHtml({
                    hello: personName(original) || "there",
                    lines: [
                        `${viewer.name} asked to close this task.`,
                        "Confirm close before the status becomes Completed.",
                    ],
                    taskName: task.taskName,
                    description: note.text,
                    link: taskDetailLink(target),
                }),
                recordId: String(target.action?._id || task._id || ""),
                emailType: "Confirm close",
            });
            emailSent = Boolean(sent?.sent);
        } catch (mailError) {
            console.error("Close email failed:", mailError);
        }
        const fresh = await loadTarget(req.params.taskKey);
        return res.status(200).json({
            message: emailSent
                ? "The original assignee was emailed to confirm close."
                : "The close request was sent. The original assignee email could not be sent.",
            emailSent,
            task: await buildDetail(fresh, viewer),
        });
    } catch (error) {
        console.error("Submit close error:", error);
        return res.status(500).json({ message: "Failed to send the close" });
    }
};

export const reviewGeneralTask = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        const decision = String(req.body?.decision || "").trim().toLowerCase();
        if (decision !== "approve" && decision !== "reject") {
            return res.status(400).json({ message: "Choose approve or reject." });
        }
        const target = await loadTarget(req.params.taskKey);
        const reviewable = isGeneralTask(target.task) || String(target.task?.taskType || '') === 'System Task';
        if (!target?.task || !reviewable) {
            return res.status(400).json({ message: "This review is for a General Task or a System Task." });
        }
        const viewer = await resolveTaskViewer(req);
        const task = target.task;
        const saved = closeSnapshot(task);
        if (!saved.reviewPending || task.status === "Completed") {
            return res.status(400).json({ message: "This task is not waiting for review." });
        }
        if (!(await viewerIsTaskRequester(task, viewer)) && !viewer?.superUser) {
            return res.status(403).json({ message: "Only the original requester can review this task." });
        }
        if (decision === "approve") {
            if (saved.returnAssigneeId) {
                task.assignee = saved.returnAssigneeId;
                task.assigneeEmpId = saved.returnAssigneeEmpId || "";
                task.assigneeName = saved.returnAssigneeName || task.assigneeName;
            }
            task.status = "Completed";
            task.closeRequest = {
                ...saved,
                reviewPending: false,
                reviewReturned: false,
                closedAt: new Date(),
                closedByName: viewer.name,
                completionConfirmedAt: new Date(),
                completesAt: null,
            };
            task.markModified("closeRequest");
            task.history = task.history || [];
            task.history.push(historyEntry("Approved", `${viewer.name} approved this task.`, viewer.name));
            task.history.push(historyEntry("Closed", `${viewer.name} approved this task. It is closed.`, viewer.name));
            await pushWorkUpdate(task, {
                authorName: viewer.name,
                authorRole: await authorRoleFor(viewer),
                kind: "Work Update",
                badge: "Closed",
                text: `${viewer.name} approved this task. It is closed.`,
            }, SILENT_MAIL);
            await task.save();
            await syncManualTaskNotification(task);
            let emailSent = false;
            try {
                const audience = await taskRecipientEmails(task);
                const sent = await sendTaskActivityEmail({
                    to: audience.to,
                    subject: `Task closed: ${task.taskName || "Task"}`,
                    html: taskActionHtml({
                        hello: audience.assigneeName || "there",
                        lines: [`${viewer.name} approved this task. It is closed and completed.`],
                        taskName: task.taskName,
                        link: taskDetailLink(target),
                    }),
                    recordId: String(task._id || target.action?._id || ""),
                    emailType: "Task approved",
                });
                emailSent = Boolean(sent?.sent);
            } catch (mailError) {
                console.error("General task approve email failed:", mailError);
            }
            const fresh = await loadTarget(req.params.taskKey);
            return res.status(200).json({
                message: emailSent
                    ? "Task approved and closed. The assignee was emailed."
                    : "Task approved and closed.",
                emailSent,
                task: await buildDetail(fresh, viewer),
            });
        }
        const note = readDescription(req.body);
        if (note.error) return res.status(400).json({ message: "A rejection reason is required." });
        const assignee = isObjectId(saved.returnAssigneeId) ? await findAssignee(String(saved.returnAssigneeId)) : null;
        if (!assignee?._id) {
            return res.status(400).json({ message: "The assigned user could not be found." });
        }
        const assigneeName = personName(assignee) || saved.returnAssigneeName || "the assignee";
        task.status = "Pending";
        task.assignee = assignee._id;
        task.assigneeEmpId = assignee.employeeId || saved.returnAssigneeEmpId || "";
        task.assigneeName = assigneeName;
        task.closeRequest = {
            ...saved,
            reviewPending: false,
            reviewReturned: true,
            reviewNote: note.text,
            completionConfirmedAt: null,
            completesAt: null,
        };
        task.markModified("closeRequest");
        task.history = task.history || [];
        task.history.push(historyEntry("Rejected", `${viewer.name} rejected this task. ${note.text}`, viewer.name));
        await pushWorkUpdate(task, {
            authorName: viewer.name,
            authorRole: await authorRoleFor(viewer),
            kind: "Work Update",
            badge: "Open",
            text: note.text,
        }, SILENT_MAIL);
        await task.save();
        await syncManualTaskNotification(task);
        let emailSent = false;
        try {
            const sent = await mailEmployee(assignee, {
                subject: `Task returned: ${task.taskName || "Task"}`,
                html: taskActionHtml({
                    hello: assigneeName,
                    lines: [
                        `${viewer.name} rejected this task. It is open again for you to correct and resubmit.`,
                    ],
                    taskName: task.taskName,
                    description: note.text,
                    link: taskDetailLink(target),
                }),
                recordId: String(task._id || ""),
                emailType: "Task rejected",
            });
            emailSent = Boolean(sent?.sent);
        } catch (mailError) {
            console.error("General task reject email failed:", mailError);
        }
        const fresh = await loadTarget(req.params.taskKey);
        return res.status(200).json({
            message: emailSent
                ? "Task rejected and returned to the assignee. They were emailed."
                : "Task rejected and returned to the assignee. The assignee email could not be sent.",
            emailSent,
            task: await buildDetail(fresh, viewer),
        });
    } catch (error) {
        console.error("Review general task error:", error);
        return res.status(500).json({ message: "Failed to review the task" });
    }
};

export const confirmTaskCompletion = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        const note = readDescription(req.body);
        if (note.error) return res.status(400).json({ message: note.error });
        const target = await loadTarget(req.params.taskKey);
        if (!target?.task) return res.status(404).json({ message: "Task not found." });
        const viewer = await resolveTaskViewer(req);
        const task = target.task;
        if (!taskWasReassigned(task)) {
            return res.status(400).json({ message: "Only a reassigned task uses confirmation." });
        }
        if (task.status === "Completed" || task.status === "Cancelled") {
            return res.status(400).json({ message: "This task is already closed." });
        }
        const original = await resolveOriginalAssignee(task);
        if (!viewerMatchesEmployee(viewer, original) && !viewer.superUser) {
            return res.status(403).json({ message: "Only the original assignee can confirm this close." });
        }
        const current = assigneeOf(target);
        const saved = closeSnapshot(task);
        if (!saved.completionRequestedAt || saved.completionConfirmedAt) {
            return res.status(400).json({ message: "The reassigned employee has to close this before you confirm." });
        }
        if (completionWindowOpen(task) || task.status === "Completed") {
            return res.status(400).json({ message: "This task is already closed." });
        }
        const sourceStillOpen = Boolean(target.action) && !dashboardActionIsClosed(target.action) && target.action.requestType !== "Task Manager";
        const text = sourceStillOpen
            ? `Confirmed close. This task is closed. The original request is still open on its own page. ${note.text}`
            : `Confirmed close. This task is closed. ${note.text}`;
        task.status = "Completed";
        task.closeRequest = {
            ...saved,
            completionConfirmedAt: new Date(),
            closedAt: new Date(),
            closedByName: viewer.name,
            completesAt: null,
        };
        task.markModified("closeRequest");
        task.history = task.history || [];
        task.history.push(historyEntry("Confirmed", text, viewer.name));
        await pushWorkUpdate(task, {
            authorName: viewer.name,
            authorRole: await authorRoleFor(viewer),
            kind: "Confirmed",
            badge: "Closed",
            text,
        }, SILENT_MAIL);
        await task.save();
        await closeReassignmentNotices(task);
        if (!task.sourceDashboardActionId) await syncManualTaskNotification(task);
        const requestedId = saved.completionRequestedById;
        const recipient = isObjectId(requestedId)
            ? await employeeById(requestedId)
            : (isObjectId(current.assigneeId) ? await employeeById(current.assigneeId) : null);
        let emailSent = false;
        if (recipient && !viewerMatchesEmployee(viewer, recipient)) {
            try {
                const sent = await mailEmployee(recipient, {
                    subject: `Task confirmed closed: ${task.taskName || "Task"}`,
                    html: taskActionHtml({
                        hello: personName(recipient) || "there",
                        lines: [
                            `${viewer.name} confirmed this task is closed.`,
                            "It is no longer in the open task list.",
                        ],
                        taskName: task.taskName,
                        description: note.text,
                        link: taskDetailLink(target),
                    }),
                    recordId: String(target.action?._id || task._id || ""),
                    emailType: "Task confirmed closed",
                });
                emailSent = Boolean(sent?.sent);
            } catch (mailError) {
                console.error("Confirm close email failed:", mailError);
            }
        }
        try {
            await notifyRequesterTaskClosed(task, target);
        } catch (noticeError) {
            console.error("Requester close notice failed:", noticeError);
        }
        const fresh = await loadTarget(req.params.taskKey);
        if (fresh?.task?.status !== "Completed") {
            return res.status(500).json({ message: "The task did not close. It is still open." });
        }
        return res.status(200).json({
            message: sourceStillOpen
                ? "Close confirmed. This task is closed. The original request is still open on its own page."
                : "Close confirmed. This task is closed and has left the open list.",
            emailSent,
            task: await buildDetail(fresh, viewer),
        });
    } catch (error) {
        console.error("Confirm close error:", error);
        return res.status(500).json({ message: "Failed to confirm close" });
    }
};

export const reopenTaskManagerTask = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        await promoteDueTaskCompletions();
        const target = await loadTarget(req.params.taskKey);
        if (!target?.task) return res.status(404).json({ message: "Task not found." });
        const viewer = await resolveTaskViewer(req);
        const task = target.task;
        const closedGeneral = generalTaskClosed(task);
        if (task.status === "Completed" && !closedGeneral) {
            return res.status(400).json({ message: "Reopen Request is disabled after the task is Completed." });
        }
        if (!(await viewerCanReopen(task, viewer))) {
            return res.status(403).json({ message: "Only the task owner can reopen this task." });
        }
        const saved = closeSnapshot(task);
        let noteText = "";
        if (closedGeneral) {
            const note = readDescription(req.body);
            if (note.error) return res.status(400).json({ message: "A comment is required to reopen this task." });
            noteText = note.text;
            const assignee = isObjectId(saved.returnAssigneeId) ? await findAssignee(String(saved.returnAssigneeId)) : null;
            if (assignee?._id) {
                task.assignee = assignee._id;
                task.assigneeEmpId = assignee.employeeId || saved.returnAssigneeEmpId || "";
                task.assigneeName = personName(assignee) || saved.returnAssigneeName || task.assigneeName;
            } else if (saved.returnAssigneeId) {
                task.assignee = saved.returnAssigneeId;
                task.assigneeEmpId = saved.returnAssigneeEmpId || task.assigneeEmpId;
                task.assigneeName = saved.returnAssigneeName || task.assigneeName;
            }
        }
        const returnedName = task.assigneeName || saved.returnAssigneeName || "the last assigned user";
        const text = noteText
            ? `${viewer.name} reopened this task. Reason: ${noteText}`
            : `${viewer.name} reopened this task. It is pending again.`;
        task.status = "Pending";
        task.closeRequest = {
            ...saved,
            reopenedAt: new Date(),
            requesterNotifiedAt: null,
            requesterChannel: "",
            closedAt: null,
            completesAt: null,
            completionConfirmedAt: null,
            reviewPending: false,
            reviewReturned: closedGeneral ? true : Boolean(saved.reviewReturned),
            reviewNote: noteText || saved.reviewNote || "",
        };
        task.markModified("closeRequest");
        task.history = task.history || [];
        task.history.push(historyEntry("Reopened", text, viewer.name));
        if (closedGeneral) {
            task.history.push(historyEntry("Reassigned", `The task returned to ${returnedName}, the last assigned user.`, viewer.name));
        }
        await pushWorkUpdate(task, {
            authorName: viewer.name,
            authorRole: await authorRoleFor(viewer),
            kind: "Reopened",
            badge: "Reopened",
            text,
        }, SILENT_MAIL);
        await task.save();
        if (!task.sourceDashboardActionId) await syncManualTaskNotification(task);
        const assignee = isObjectId(task.assignee) ? await findAssignee(String(task.assignee)) : null;
        let emailSent = false;
        try {
            const audience = await taskRecipientEmails(task);
            const owner = await resolveTaskRequesterEmployee(task);
            const ownerName = personName(owner) || personBaseName(task.requestedByName) || viewer.name;
            const ownerRole = await authorRoleFor(viewer);
            const ownerEmail = await businessEmail(owner);
            const numberMap = await taskNumbersByRecordId([
                task.sourceDashboardActionId,
                task._id,
                `manual-${task._id}`,
            ]);
            const taskNumber = numberMap.get(String(task.sourceDashboardActionId || ""))
                || numberMap.get(`manual-${task._id}`)
                || numberMap.get(String(task._id || ""))
                || "";
            const ownerLine = [ownerName, ownerRole, ownerEmail].filter(Boolean).join(", ");
            const sent = await sendTaskActivityEmail({
                to: audience.to.length ? audience.to : [await businessEmail(assignee)].filter(Boolean),
                subject: `Task reopened: ${taskNumber || task.taskName || "Task"}`,
                html: taskActionHtml({
                    hello: personName(assignee) || task.assigneeName || "there",
                    lines: [
                        `${ownerName} reopened this task and returned it to you.`,
                        `Task number: ${taskNumber || "—"}`,
                        `Task name: ${task.taskName || "Task"}`,
                        `Reopening reason: ${noteText || "—"}`,
                        `Task owner: ${ownerLine || ownerName}`,
                    ],
                    taskName: task.taskName,
                    link: taskDetailLink(target),
                }),
                recordId: String(task._id || target.action?._id || ""),
                emailType: "Task reopened",
            });
            emailSent = Boolean(sent?.sent);
        } catch (mailError) {
            console.error("Reopen email failed:", mailError);
        }
        const fresh = await loadTarget(req.params.taskKey);
        return res.status(200).json({
            message: emailSent
                ? "Task reopened. The assignee was emailed."
                : "Task reopened. The assignee email could not be sent.",
            emailSent,
            task: await buildDetail(fresh, viewer),
        });
    } catch (error) {
        console.error("Reopen task error:", error);
        return res.status(500).json({ message: "Failed to reopen the task" });
    }
};

export const updateTaskManagerTaskStatus = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        const target = await loadTarget(req.params.taskKey);
        if (!target) return res.status(404).json({ message: "Task not found." });
        if (generalTaskClosed(target.task)) {
            return res.status(400).json({ message: "This task is closed. Complete, edit, reassign, and delete are disabled." });
        }
        const status = String(req.body?.status || "").trim();
        if (!STATUSES.has(status)) return res.status(400).json({ message: "Choose a valid status." });
        const viewer = await resolveTaskViewer(req);
        const current = assigneeOf(target);
            if (status === "Rejected") {
            const flags = await closeFlags(target.task, viewer, current.assigneeId, current.assigneeEmpId, target.action);
            if (!flags.canRejectWithNote) {
                return res.status(403).json({ message: "Only the requester or the original assignee can reject this task." });
            }
            const note = readDescription(req.body);
            if (note.error) return res.status(400).json({ message: "A rejection comment is required." });
            const task = target.task || (target.action ? await ensureOverlay(target.action) : null);
            if (!task) return res.status(404).json({ message: "Task not found." });
            const text = note.text;
            task.status = "Rejected";
            task.history = task.history || [];
            task.history.push(historyEntry("Rejected", text, viewer.name));
            await pushWorkUpdate(task, {
                authorName: viewer.name,
                authorRole: await authorRoleFor(viewer),
                kind: "Rejected",
                badge: "Rejected",
                text,
            }, SILENT_MAIL);
            await task.save();
            if (target.action && !["Rejected", "Cancelled", "Dismissed"].includes(String(target.action.status || ""))) {
                target.action.status = "Rejected";
                target.action.actionedDate = new Date();
                target.action.comment = "Rejected from Task Manager";
                await target.action.save();
            }
            try {
                await closeReassignmentNotices(task);
            } catch (noticeError) {
                console.error("Reject notice clear failed:", noticeError);
            }
            if (!task.sourceDashboardActionId) await syncManualTaskNotification(task);
            const fresh = await loadTarget(req.params.taskKey);
            return res.status(200).json({ message: "Task rejected", task: await buildDetail(fresh, viewer) });
        }
        const workflowLocked = target.kind === "dashboard" && target.action?.requestType !== "Task Manager";
        const completingReassigned = workflowLocked
            && status === "Completed"
            && viewerIsCurrentAssignee(viewer, current)
            && taskWasReassigned(target.task);
        if (workflowLocked && !completingReassigned) {
            return res.status(400).json({
                message: "This request is updated on its own page. You can still reassign it here.",
            });
        }
        const task = target.task || (target.action ? await ensureOverlay(target.action) : null);
        if (!task) return res.status(404).json({ message: "Task not found." });
        if (status === "Completed" && taskWasReassigned(task)) {
            return res.status(400).json({
                message: "The reassigned employee closes first. The original assignee confirms close after that.",
            });
        }
        if (status === "Completed" && isGeneralTask(task)) {
            return res.status(400).json({
                message: "Complete the task with a reply. The requester reviews it before it closes.",
            });
        }
        if (status === "Completed") {
            if (completionWindowOpen(task)) {
                return res.status(400).json({ message: "This task is already closed. The status becomes Completed after 2 days." });
            }
            const saved = closeSnapshot(task);
            const text = `${viewer.name} closed this task. The status becomes Completed after 2 days.`;
            task.closeRequest = {
                ...saved,
                completesAt: scheduleCompletion(),
                completionConfirmedAt: saved.completionConfirmedAt || new Date(),
                closedByName: viewer.name,
            };
            task.markModified("closeRequest");
            task.history = task.history || [];
            task.history.push(historyEntry("Closed", text, viewer.name));
            await pushWorkUpdate(task, {
                authorName: viewer.name,
                authorRole: await authorRoleFor(viewer),
                kind: "Closed",
                badge: "Closed",
                text,
            }, SILENT_MAIL);
            await task.save();
            try {
                await notifyRequesterTaskClosed(task, target);
            } catch (noticeError) {
                console.error("Requester close notice failed:", noticeError);
            }
            const fresh = await loadTarget(req.params.taskKey);
            return res.status(200).json({
                message: "Task closed. The status becomes Completed after 2 days.",
                task: await buildDetail(fresh, viewer),
            });
        }
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
        if (status === "Cancelled") await closeReassignmentNotices(task);
        if (!task.sourceDashboardActionId) await syncManualTaskNotification(task);
        const fresh = await loadTarget(req.params.taskKey);
        return res.status(200).json({ message: "Status updated", task: await buildDetail(fresh, viewer) });
    } catch (error) {
        console.error("Task status error:", error);
        return res.status(500).json({ message: "Failed to update status" });
    }
};

export const closeTaskManagerRequest = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        const target = await loadTarget(req.params.taskKey);
        if (!target) return res.status(404).json({ message: "Task not found." });
        const step = String(req.body?.step || "").trim().toLowerCase();
        if (step !== "request" && step !== "finish") {
            return res.status(400).json({ message: "Choose the close step." });
        }
        const viewer = await resolveTaskViewer(req);
        const task = target.task;
        if (!task) return res.status(400).json({ message: "Complete the task before closing the request." });
        if (task.status !== "Completed") {
            return res.status(400).json({ message: "Mark the task completed before closing the request." });
        }
        if (!taskWasReassigned(task)) {
            return res.status(400).json({ message: "This close step is for a task that was reassigned." });
        }

        const current = assigneeOf(target);
        const saved = closeSnapshot(task);
        const link = taskDetailLink(target);
        const recordId = String(target.action?._id || task._id || "");

        if (step === "request") {
            if (!viewerIsCurrentAssignee(viewer, current)) {
                return res.status(403).json({ message: "Only the reassigned employee can send this close request." });
            }
            if (saved.closedAt) return res.status(400).json({ message: "This request is already closed." });
            if (saved.assigneeNotifiedAt) {
                return res.status(200).json({
                    message: "The assignee was already emailed once.",
                    task: await buildDetail(target, viewer),
                });
            }
            const original = await resolveOriginalAssignee(task);
            const originalEmail = String(original?.companyEmail || original?.workEmail || "").trim();
            if (!original || !originalEmail) {
                return res.status(400).json({ message: "The original assignee has no email address." });
            }
            const reassignedName = task.assigneeName || viewer.name || "The reassigned employee";
            const subject = `${reassignedName} completed this task`;
            const html = `
                <p>Hello ${escapeHtml(personName(original) || "there")},</p>
                <p>${escapeHtml(reassignedName)} completed this task. You can close this request now.</p>
                <p><strong>${escapeHtml(task.taskName || "Task")}</strong></p>
                <p><a href="${escapeHtml(link)}">Open the task</a></p>
            `;
            const sent = await sendTaskActivityEmail({
                to: [originalEmail],
                subject,
                html,
                recordId,
                emailType: "Close request",
            });
            if (!sent?.sent) return res.status(500).json({ message: "The assignee email could not be sent." });
            const next = closeSnapshot(task);
            task.closeRequest = {
                ...next,
                requestedAt: next.requestedAt || new Date(),
                requestedByName: reassignedName,
                assigneeNotifiedAt: new Date(),
            };
            task.markModified("closeRequest");
            task.history = task.history || [];
            task.history.push(historyEntry("Close Request", `${reassignedName} completed this task. ${personName(original)} can close it.`, viewer.name));
            await pushWorkUpdate(task, {
                authorName: viewer.name,
                authorRole: await authorRoleFor(viewer),
                kind: "Close Request",
                badge: "Completed",
                text: `${reassignedName} completed this task. ${personName(original)} can close this request.`,
            }, SILENT_MAIL);
            await task.save();
            const fresh = await loadTarget(req.params.taskKey);
            return res.status(200).json({
                message: "The assignee was emailed once to close this request.",
                task: await buildDetail(fresh, viewer),
            });
        }

        const original = await resolveOriginalAssignee(task);
        if (!viewerMatchesEmployee(viewer, original)) {
            return res.status(403).json({ message: "Only the original assignee can close this request." });
        }
        if (!saved.requestedAt) {
            return res.status(400).json({ message: "The reassigned employee has not asked you to close this yet." });
        }
        if (saved.closedAt || saved.requesterNotifiedAt) {
            return res.status(200).json({
                message: "The requester was already told that this request is completed.",
                task: await buildDetail(target, viewer),
            });
        }

        if (isSystemRequester(task.requestedByName)) {
            const next = closeSnapshot(task);
            task.closeRequest = {
                ...next,
                closedAt: new Date(),
                closedByName: viewer.name,
            };
            task.markModified("closeRequest");
            task.history = task.history || [];
            task.history.push(historyEntry("Request Closed", "The requester is System, so no close message was sent.", viewer.name));
            await task.save();
            const fresh = await loadTarget(req.params.taskKey);
            return res.status(200).json({
                message: "This request is closed. The admin super user can reopen it.",
                task: await buildDetail(fresh, viewer),
            });
        }

        const requester = await findEmployeeByName(personBaseName(task.requestedByName));
        const companyEmail = String(requester?.companyEmail || "").trim();
        const requesterName = personName(requester) || personBaseName(task.requestedByName) || "there";
        let channel = "";
        if (companyEmail) {
            const sent = await sendTaskActivityEmail({
                to: [companyEmail],
                subject: `Your task is closed: ${task.taskName || "Task"}`,
                html: `
                    <p>Hello ${escapeHtml(requesterName)},</p>
                    <p>Your task is closed. You can reopen it by opening this page and choosing Reopen Request. After 2 days the status becomes Completed and Reopen Request is disabled.</p>
                    <p><strong>${escapeHtml(task.taskName || "Task")}</strong></p>
                    <p><a href="${escapeHtml(link)}">Open the task</a></p>
                `,
                recordId,
                emailType: "Request completed",
            });
            if (!sent?.sent) return res.status(500).json({ message: "The requester email could not be sent." });
            channel = "email";
        } else {
            const phone = await resolveEmployeeWhatsAppPhone(requester?.employeeId);
            if (!phone) {
                return res.status(400).json({ message: "The requester has no company email and no WhatsApp number." });
            }
            const result = await sendTextMessage(
                phone,
                `Your task is closed. You can reopen it by opening this page and choosing Reopen Request. After 2 days the status becomes Completed and Reopen Request is disabled. ${task.taskName || "Task"}. ${link}`,
                {
                    source: "auto",
                    skipPaidChannelCheck: true,
                    employeeId: requester?.employeeId || "",
                    contactName: requesterName,
                },
            );
            if (result?.success !== true) {
                return res.status(500).json({ message: result?.error || "The WhatsApp message could not be sent." });
            }
            channel = "whatsapp";
        }

        const next = closeSnapshot(task);
        task.closeRequest = {
            ...next,
            closedAt: new Date(),
            closedByName: viewer.name,
            requesterNotifiedAt: new Date(),
            requesterChannel: channel,
        };
        task.markModified("closeRequest");
        task.history = task.history || [];
        const told = channel === "whatsapp"
            ? `${requesterName} was sent one WhatsApp message that this request is completed.`
            : `${requesterName} was emailed that this request is completed.`;
        task.history.push(historyEntry("Request Closed", told, viewer.name));
        await pushWorkUpdate(task, {
            authorName: viewer.name,
            authorRole: await authorRoleFor(viewer),
            kind: "Request Closed",
            badge: "Closed",
            text: told,
        }, SILENT_MAIL);
        await task.save();
        const fresh = await loadTarget(req.params.taskKey);
        return res.status(200).json({
            message: channel === "whatsapp"
                ? "The requester was sent one WhatsApp message."
                : "The requester was emailed that this request is completed.",
            task: await buildDetail(fresh, viewer),
        });
    } catch (error) {
        console.error("Close task request error:", error);
        return res.status(500).json({ message: "Failed to close the request" });
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
        if (!task && target.action) task = await ensureOverlay(target.action);
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
        await pushWorkUpdate(task, {
            authorName: viewer.name,
            authorRole: await authorRoleFor(viewer),
            kind: "Work Update",
            badge: "Comment",
            text: safeText,
        }, SILENT_MAIL);
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
        if (!target.task && target.action) target.task = await ensureOverlay(target.action);
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

/** Reuse the task already linked to this request. A second copy is closed. */
async function ensureOverlay(action) {
    if (!action?._id) return null;
    const rows = await TaskManagerTask.find({ sourceDashboardActionId: action._id }).sort({ updatedAt: -1 });
    const open = rows.filter((row) => !["Completed", "Cancelled", "Rejected"].includes(String(row.status || "")));
    const pool = open.length ? open : [];
    if (!pool.length) return blankOverlay(action);
    const [keep, ...extra] = pool;
    if (extra.length) {
        await TaskManagerTask.updateMany(
            { _id: { $in: extra.map((row) => row._id) }, status: { $nin: ["Completed", "Cancelled"] } },
            { $set: { status: "Cancelled" } },
        );
    }
    return keep;
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
        const task = target.task || (target.action ? await ensureOverlay(target.action) : null);
        if (!task) return res.status(404).json({ message: "Task not found." });
        if (generalTaskClosed(task)) {
            return res.status(400).json({ message: "This task is closed. Only the requester can reopen it." });
        }
        const destination = target.kind === "manual"
            ? moduleForText(task.taskName, task.description, task.taskType)
            : moduleForRequestType(target.action?.requestType, `${target.action?.extra1 || ""} ${target.action?.extra2 || ""}`);
        const accessPath = accessPathFor(
            destination,
            target.kind === "manual" ? "" : target.action?.requestId,
            target.kind === "manual" ? "" : target.action?.subjectEmployeeId,
            target.kind === "manual" ? null : {
                extra1: target.action?.extra1,
                extra2: target.action?.extra2,
                extra3: target.action?.extra3,
                requestType: target.action?.requestType,
            },
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
        const task = target.task || (target.action ? await ensureOverlay(target.action) : null);
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

function personBaseName(value) {
    return String(value || "").trim().replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function parseReassignment(detail, actorName) {
    const text = String(detail || "");
    const fromTo = text.match(/reassigned from\s+(.+?)\s+to\s+(.+?)\./i);
    if (fromTo) return { from: fromTo[1].trim(), to: fromTo[2].trim() };
    const toOnly = text.match(/reassigned to\s+(.+?)\./i);
    return { from: personBaseName(actorName), to: toOnly ? toOnly[1].trim() : "" };
}

async function handoffPeople(history, currentName) {
    const events = (Array.isArray(history) ? history : []).filter((item) => item?.event === "Reassigned");
    const rows = [];
    const push = (name, role, at) => {
        const clean = personBaseName(name);
        if (!clean || clean.toLowerCase() === "system") return;
        const previous = rows[rows.length - 1];
        if (previous && previous.name.toLowerCase() === clean.toLowerCase()) return;
        rows.push({ name: clean, role, at: at || null });
    };
    if (!events.length) {
        push(currentName, "Assignee", null);
    } else {
        events.forEach((event, index) => {
            const hop = parseReassignment(event.detail, event.actorName);
            if (index === 0) push(hop.from, "Assignee", event.createdAt);
            push(hop.to, rows.length ? "Reassigned" : "Assignee", event.createdAt);
        });
        push(currentName, rows.length ? "Reassigned" : "Assignee", null);
    }
    const cache = new Map();
    const people = [];
    for (const row of rows) {
        const key = row.name.toLowerCase();
        if (!cache.has(key)) cache.set(key, await findEmployeeByName(row.name));
        const person = stepPerson(cache.get(key), row.name);
        const card = contactCard(cache.get(key));
        people.push({
            ...person,
            email: card.email || "",
            role: row.role,
            at: row.at,
            current: false,
        });
    }
    if (people.length) people[people.length - 1].current = true;
    return people;
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
    const sourceRequesters = await sourceRequesterNameMap(action ? [action] : []);
    const requesterName = displayRequesterName(
        preferRequesterName(task?.requestedByName, action?.requestedByName),
        action,
        sourceRequesters,
    ) || "System";
    const requesterEmp = await findEmployeeByName(requesterName);
    const assigneeName = stepPerson(assigneeEmp, manual ? task?.assigneeName : action?.subjectName || "Unassigned").personName;
    const destination = manual
        ? moduleForText(task?.taskName, task?.description, task?.taskType)
        : moduleForRequestType(action?.requestType, `${action?.extra1 || ""} ${action?.extra2 || ""}`);
    const category = manual
        ? (displayTaskType(task?.taskType) || "General Task")
        : categoryFromRequestType(action?.requestType, action?.extra2 || "");
    // A general task has no approval chain. Words such as "asset" or "tools" in the title must not add Admin, HR, or Manager.
    const keys = category === "General Task"
        ? WORKFLOW_CHAINS.general
        : (WORKFLOW_CHAINS[destination.module] || WORKFLOW_CHAINS.general);
    const manager = category === "General Task"
        ? null
        : ((await reportingManager(requesterEmp)) || (await reportingManager(assigneeEmp)));
    const [hr, accounts, admin] = category === "General Task"
        ? [null, null, null]
        : await Promise.all([
            getDepartmentHOD("hr").catch(() => null),
            getDepartmentHOD("finance").catch(() => null),
            getDepartmentHOD("admincontroller").catch(() => null),
        ]);
    const holders = { manager, hr, accounts, admin };
    const requestDate = manual ? task?.createdAt : action?.requestedDate || action?.createdAt || null;
    const updatedAt = task?.updatedAt || action?.updatedAt || requestDate;
    const requester = stepPerson(requesterEmp, requesterName);
    const assignee = stepPerson(assigneeEmp, assigneeName);
    const steps = [];

    let changeRequest = null;
    if (!manual && isObjectId(action?.requestId)) {
        const changeSelect = "stage reporteeId reporteeName hrId hrName decidedAtReportee decidedAtHr";
        changeRequest = await AttendanceChangeRequest.findById(action.requestId).select(changeSelect).lean();
        if (!changeRequest) {
            changeRequest = await AttendanceChangeRequest.findOne({
                "proposed.attendanceId": String(action.requestId),
                stage: { $ne: "superseded" },
            })
                .sort({ updatedAt: -1 })
                .select(changeSelect)
                .lean();
        }
    }

    async function employeeStep(id, fallbackName) {
        let emp = null;
        if (isObjectId(id)) {
            emp = await EmployeeBasic.findById(id)
                .select("firstName lastName employeeId designation companyEmail profilePicture status")
                .lean();
        }
        return stepPerson(emp, fallbackName);
    }

    async function slotPeople(base, active) {
        const person = {
            ...base,
            role: base.personRole || "Assignee",
            at: base.at || null,
            current: false,
        };
        if (!active || !person.personName) return person.personName ? [person] : [];
        const handoff = await handoffPeople(task?.history, person.personName);
        if (handoff.length <= 1) return [{ ...person, current: true }];
        return handoff.map((row, index) => ({
            ...row,
            current: index === handoff.length - 1,
        }));
    }

    if (changeRequest && (changeRequest.reporteeName || changeRequest.reporteeId || changeRequest.hrName || changeRequest.hrId)) {
        steps.push({
            key: "created",
            title: "Task Created",
            detail: `By ${requester.personName || "System"} (Requester)`,
            ...requester,
            at: requestDate,
        });
        const reportee = await employeeStep(changeRequest.reporteeId, changeRequest.reporteeName);
        const hrPerson = await employeeStep(changeRequest.hrId, changeRequest.hrName);
        const reporteeActive = changeRequest.stage === "pending_reportee";
        const hrActive = changeRequest.stage === "pending_hr";
        const reporteeChain = await slotPeople(
            { ...reportee, personRole: reportee.personRole || "Primary reportee", at: changeRequest.decidedAtReportee },
            reporteeActive,
        );
        reporteeChain.forEach((person, index) => {
            const first = index === 0;
            steps.push({
                key: first ? "reportee" : "reassigned",
                title: first
                    ? `Reportee ${person.personName}`
                    : `Reassigned to ${person.personName}`,
                detail: first
                    ? "Approves the request, then it goes to HR"
                    : `Passed from ${reporteeChain[index - 1]?.personName || "the previous approver"}`,
                ...person,
                at: person.at || null,
            });
        });
        const hrChain = await slotPeople(
            { ...hrPerson, personRole: hrPerson.personRole || "HR", at: changeRequest.decidedAtHr },
            hrActive,
        );
        hrChain.forEach((person, index) => {
            const first = index === 0;
            steps.push({
                key: first ? "hr" : "reassigned",
                title: first
                    ? `HR ${person.personName}`
                    : `Reassigned to ${person.personName}`,
                detail: first
                    ? "Final approval on the Attendance page"
                    : `Passed from ${hrChain[index - 1]?.personName || "the previous approver"}`,
                ...person,
                at: person.at || null,
            });
        });
        steps.push({
            key: "done",
            title: "Completed",
            detail: "Pending",
            personId: "",
            personName: "",
            personRole: "",
            personPhoto: "",
            at: null,
        });
    } else for (const key of keys) {
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
            const handoff = await handoffPeople(task?.history, assignee.personName);
            const chain = handoff.length ? handoff : [{ ...assignee, role: "Assignee", at: requestDate, current: true }];
            chain.forEach((person, index) => {
                const first = index === 0;
                steps.push({
                    key: first ? "assigned" : "reassigned",
                    title: first
                        ? `Assignee ${person.personName || "Unassigned"}`
                        : `Reassigned to ${person.personName || "Unassigned"}`,
                    detail: first
                        ? `From ${personBaseName(requester.personName) || "Requester"}`
                        : `Passed from ${chain[index - 1]?.personName || "the previous assignee"}`,
                    ...person,
                    at: person.at || requestDate,
                });
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

    const stage = String(changeRequest?.stage || "");
    const requestOpen = stage === "pending_reportee" || stage === "pending_hr" || stage === "pending_requester";
    const requestRejected = stage === "rejected";
    if (task?.save && requestRejected && task.status !== "Cancelled") {
        task.status = "Cancelled";
        await task.save();
    } else if (task?.save && requestOpen && ["Completed", "Cancelled", "Rejected"].includes(String(task.status || ""))) {
        task.status = "In Progress";
        await task.save();
    }
    const raw = requestRejected
        ? "Cancelled"
        : requestOpen
          ? "In Progress"
          : String(task?.status || action?.status || "Pending");
    const finished = !requestRejected && !requestOpen && (raw === "Completed" || raw === "Approved");
    const rejected = requestRejected || raw === "Cancelled" || raw === "Rejected" || raw === "Dismissed";
    const workflowLocked = !manual && action?.requestType !== "Task Manager";
    let current = -1;
    for (let index = steps.length - 1; index >= 0; index -= 1) {
        if (steps[index].current) {
            current = index;
            break;
        }
    }
    if (current < 0) {
        steps.forEach((step, index) => {
            if (
                (step.key === "assigned" || step.key === "reassigned")
                && step.personId
                && assigneeId
                && step.personId === String(assigneeId)
            ) current = index;
        });
    }
    if (current < 0) current = Math.max(0, steps.findIndex((step) => step.key === "assigned" || step.key === "reassigned"));
    if (requestRejected) {
        const rejectedKey = changeRequest?.decidedAtHr ? "hr" : "reportee";
        const rejectedIndex = steps.findIndex((step) => step.key === rejectedKey);
        if (rejectedIndex >= 0) current = rejectedIndex;
    }

    steps.forEach((step, index) => {
        if (finished) step.status = "Completed";
        else if (rejected) step.status = index < current ? "Completed" : index === current ? "Rejected" : "Not Started";
        else step.status = index < current ? "Completed" : index === current ? "In Progress" : "Not Started";

        if (step.status === "Completed" && step.key !== "created") {
            if (step.key === "done") step.detail = "Completed";
            else if (step.key === "leaveBalance") step.detail = "Updated";
            else if (step.personName && step.key !== "assigned" && step.key !== "reassigned") step.detail = `By ${step.personName}`;
        }
        if (step.status === "Not Started" && !step.personName) step.detail = "Pending";
        if (step.status === "Rejected") step.detail = step.personName ? `Rejected by ${step.personName}` : "Rejected";
        if (step.status === "Completed" || step.status === "In Progress" || step.status === "Rejected") {
            step.at = step.at || (index === 0 ? requestDate : updatedAt);
        } else {
            step.at = null;
        }
        const taskType = String(task?.taskType || category || '');
        const systemOrWorkflow = /system task|workflow task|work flow task/i.test(taskType);
        const originalId = String(task?.closeRequest?.originalAssigneeId || '');
        const backWithOriginal = systemOrWorkflow
            && taskWasReassigned(task)
            && originalId
            && String(assigneeId || '') === originalId;
        step.canAct = step.status === "In Progress"
            && Boolean(step.personId)
            && !workflowLocked
            && !backWithOriginal
            && viewerCanReassign(viewer, assigneeId, assigneeEmpId);
    });

    return {
        module: destination.module,
        moduleLabel: destination.label,
        modulePath: destination.path,
        accessPath: (manual
            ? (displayTaskType(task?.taskType) || "General Task")
            : categoryFromRequestType(action?.requestType, action?.extra2 || "")) === "General Task"
            ? ""
            : accessPathFor(
                destination,
                action?.requestId,
                action?.subjectEmployeeId,
                {
                    extra1: action?.extra1,
                    extra2: action?.extra2,
                    extra3: action?.extra3,
                    requestType: action?.requestType,
                },
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
            await emailTaskHistory(task, {
                event: "Rejected",
                detail: `${current.title} was rejected.`,
                actorName: viewer.name,
            });
            await task.save();
            await closeReassignmentNotices(task);
            await syncManualTaskNotification(task);
        } else {
            const next = workflow.steps.slice(currentIndex + 1).find((step) => step.personId && step.personId !== String(task.assignee));
            if (next?.personId) {
                const assignee = await findAssignee(next.personId);
                if (!assignee) return res.status(400).json({ message: "The next person in this workflow was not found." });
                const assigneeName = personName(assignee) || assignee.employeeId || "Unassigned";
                const previousAssignee = { assigneeId: task.assignee, assigneeEmpId: task.assigneeEmpId || "" };
                rememberOriginalAssignee(task, previousAssignee, task.assigneeName || "");
                task.assignee = assignee._id;
                task.assigneeEmpId = assignee.employeeId || "";
                task.assigneeName = assigneeName;
                task.status = "In Progress";
                task.history.push(historyEntry("Approved", `${current.title} approved. Sent to ${assigneeName}.`, viewer.name));
                await emailTaskHistory(task, {
                    event: "Approved",
                    detail: `${current.title} approved. Sent to ${assigneeName}.`,
                    actorName: viewer.name,
                });
                await task.save();
                await syncManualTaskNotification(task);
                const destination = moduleForText(task.taskName, task.description, task.taskType);
                try {
                    await keepReassignmentVisible(task, target, {
                        previous: previousAssignee,
                        newAssignee: assignee,
                        reassigneeName: assigneeName,
                        taskName: task.taskName,
                        moduleName: destination.module,
                    });
                } catch (noticeError) {
                    console.error("Reassignment notice failed:", noticeError);
                }
                try {
                    await sendTaskReassignedEmail({
                        toEmp: assignee,
                        taskName: task.taskName,
                        reason: `${current.title} was approved. This step is now with you.`,
                        modulePath: workflow.modulePath,
                        taskPath: taskOpenPath(taskRecordKey(target, task)),
                        requesterName: task.requestedByName,
                        recordId: String(task._id || ""),
                    });
                } catch (mailError) {
                    console.error("Workflow approval email failed:", mailError);
                }
            } else {
                task.status = "Completed";
                task.history.push(historyEntry("Approved", `${current.title} approved. The task is completed.`, viewer.name));
                await emailTaskHistory(task, {
                    event: "Approved",
                    detail: `${current.title} approved. The task is completed.`,
                    actorName: viewer.name,
                });
                await task.save();
                await closeReassignmentNotices(task);
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

function readActionMeta(value) {
    if (!value) return {};
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return {};
    }
}

const HUB_REQUEST_TYPES = new Set([
    "Employee Leave Request",
    "Employee Advance Request",
    "Employee Loan Request",
    "Employee Salary Request",
    "Employee Certificate Request",
    "Employee Asset Request",
    "Employee Fine Request",
    "Employee Vehicle Request",
    "Employee Utility Request",
]);

const ASSET_PENDING_TYPES = new Set([
    "Asset Return",
    "Asset Transfer",
    "Asset Leave",
    "Asset End of Life",
    "Asset Loss Damage",
    "Asset Retention",
    "Asset Accessory",
    "Asset Accessory Approval",
    "Asset Accessory Unattach",
    "Asset Owner On Duty",
    "Asset On Duty Request",
    "Vehicle Assignment Photo Review",
]);

function restoreFromContext(asset, context) {
    if (!context) return false;
    if (context.previousStatus) asset.status = context.previousStatus;
    if (context.previousAssignedTo) asset.assignedTo = context.previousAssignedTo;
    else if (context.oldAssignedTo && isObjectId(context.oldAssignedTo)) asset.assignedTo = context.oldAssignedTo;
    if (context.previousAssignedToType) asset.assignedToType = context.previousAssignedToType;
    if (Object.prototype.hasOwnProperty.call(context, "previousAssignedCompany")) {
        asset.assignedCompany = context.previousAssignedCompany;
    }
    if (Object.prototype.hasOwnProperty.call(context, "previousAcceptanceStatus")) {
        asset.acceptanceStatus = context.previousAcceptanceStatus;
    }
    if (Object.prototype.hasOwnProperty.call(context, "previousAssignedBy")) asset.assignedBy = context.previousAssignedBy;
    else if (context.oldAssignedBy && isObjectId(context.oldAssignedBy)) asset.assignedBy = context.oldAssignedBy;
    if (Object.prototype.hasOwnProperty.call(context, "previousAssignmentType")) {
        asset.assignmentType = context.previousAssignmentType;
    } else if (Object.prototype.hasOwnProperty.call(context, "oldAssignmentType")) {
        asset.assignmentType = context.oldAssignmentType;
    }
    if (context.previousOwnership) asset.ownership = context.previousOwnership;
    return Boolean(context.previousStatus || context.previousAssignedTo || context.oldAssignedTo);
}

function clearAssetAssignment(asset) {
    asset.assignedTo = null;
    asset.assignedCompany = null;
    asset.assignedBy = null;
    asset.acceptedBy = null;
    asset.assignedToType = "Employee";
    asset.assignmentType = null;
    asset.assignedDays = null;
    asset.assignedDate = null;
    asset.temporaryEndDate = null;
    asset.temporaryReminderSentAt = null;
    asset.temporaryExpiredSentAt = null;
    asset.acceptanceStatus = null;
    asset.actionRequiredBy = null;
    asset.pendingAction = null;
    asset.pendingActionDetails = null;
    asset.negotiationHistory = [];
    asset.status = "Unassigned";
    asset.ownership = "Unassigned";
}

async function undoAssetAssignment(assetId) {
    if (!isObjectId(assetId)) return;
    const asset = await AssetItem.findById(assetId);
    if (!asset) return;
    const details = asset.pendingActionDetails || {};
    const restored = restoreFromContext(
        asset,
        details.serviceReassignContext || details.parkingReassignContext || null,
    );
    if (!restored) clearAssetAssignment(asset);
    else {
        asset.pendingAction = null;
        asset.actionRequiredBy = null;
        asset.pendingActionDetails = null;
        asset.acceptanceStatus = asset.acceptanceStatus || "Accepted";
        if (!asset.status || asset.status === "Pending") asset.status = "Assigned";
    }
    await asset.save();
    await AssetHistory.create({
        assetId: asset._id,
        action: restored ? "Restored" : "Unassigned",
        comments: "Assignment undone because the task was deleted.",
        date: new Date(),
    });
}

async function undoPendingAssetRequest(assetId) {
    if (!isObjectId(assetId)) return;
    const asset = await AssetItem.findById(assetId);
    if (!asset) return;
    const details = asset.pendingActionDetails || {};
    const restored = restoreFromContext(asset, details.returnHandoverContext || null);
    if (!restored && asset.status === "Pending") {
        asset.status = asset.assignedTo || asset.assignedCompany ? "Assigned" : "Unassigned";
    }
    asset.pendingAction = null;
    asset.actionRequiredBy = null;
    asset.pendingActionDetails = null;
    await asset.save();
    await AssetHistory.create({
        assetId: asset._id,
        action: "Restored",
        comments: "Request undone because the task was deleted.",
        date: new Date(),
    });
}

async function undoLeaveRequest(action) {
    const meta = readActionMeta(action.extra3);
    const ids = [action.requestId, meta.attendanceId, meta.leaveAttendanceId]
        .map((value) => String(value || ""))
        .filter(isObjectId);
    const groupIds = [meta.groupId, meta.leaveRequestGroupId, action.requestId]
        .map((value) => String(value || "").trim())
        .filter(Boolean);
    const or = [];
    if (ids.length) or.push({ _id: { $in: ids } });
    if (groupIds.length) or.push({ leaveRequestGroupId: { $in: groupIds } });
    const from = String(meta.from || "").trim();
    const to = String(meta.to || from).trim();
    const employeeMongoId = String(meta.employeeMongoId || "").trim();
    if (employeeMongoId && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
        or.push({
            employeeMongoId,
            leaveRequestFromDate: from,
            ...(to ? { leaveRequestToDate: to } : {}),
            leaveRequestStatus: { $in: ["pending", "approved", "rejected"] },
        });
    }
    if (!or.length) return;
    const rows = await Attendance.find({ $or: or });
    for (const record of rows) {
        const requestStatus = String(record.leaveRequestStatus || "").trim();
        if (!requestStatus && !record.leaveRequestGroupId) continue;
        const prevKey = String(record.previousStatusKey || "not_marked");
        const hadNoClock = !String(record.timeIn || "").trim();
        if (hadNoClock && (!prevKey || prevKey === "not_marked")) {
            await Attendance.deleteOne({ _id: record._id });
            continue;
        }
        record.statusKey = prevKey || "not_marked";
        record.statusLabel = record.previousStatusLabel || record.statusLabel;
        record.leaveRequestStatus = "";
        record.leaveRequestKind = "";
        record.requestedStatusKey = "";
        record.requestedStatusLabel = "";
        record.leaveRequestFromDate = "";
        record.leaveRequestToDate = "";
        record.leaveRequestGroupId = "";
        record.leaveApprovalStage = "";
        record.annualLeaveNotEligible = false;
        record.leaveRequestedAt = null;
        record.leaveDecidedAt = null;
        record.leaveDecidedBy = null;
        record.leaveRequestReason = "";
        record.leaveRequestDayPart = "";
        record.leaveRequestTimeIn = "";
        record.leaveRequestTimeOut = "";
        record.approvalStatus = "";
        record.leavePayType = "";
        await record.save();
    }
}

async function undoMoneyRequest(Model, requestId, statusField) {
    if (!isObjectId(requestId)) return;
    const row = await Model.findById(requestId);
    if (!row) return;
    const status = String(row[statusField] || "");
    if (["Paid", "Approved (Paid)", "Completed", "Active"].includes(status)) return;
    row[statusField] = "Cancelled";
    if (row.approvalStatus && !["Paid", "Approved (Paid)"].includes(String(row.approvalStatus))) {
        row.approvalStatus = "Cancelled";
    }
    await row.save();
}

const ATTENDANCE_APPROVAL_TYPES = new Set([
    "Attendance Change Request",
    "Hour Approval Request",
    "Flexible OT Request",
]);

function escapeIdPattern(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Drop the approval document behind an attendance task and clear a still-pending
 * hour or overtime mark. Applied attendance days stay as they are.
 * Returns the approval ids so their bells and mail alerts can be removed too.
 */
async function undoAttendanceApproval(action) {
    const requestType = String(action?.requestType || "");
    if (!ATTENDANCE_APPROVAL_TYPES.has(requestType)) return [];
    const requestId = String(action?.requestId || "");
    if (!isObjectId(requestId)) return [];

    const changes = await AttendanceChangeRequest.find({
        $or: [{ _id: requestId }, { "proposed.attendanceId": requestId }],
    }).select("_id proposed.attendanceId").lean();
    const changeIds = changes.map((row) => row._id);
    const attendanceIds = new Set();
    if (!changes.some((row) => String(row._id) === requestId)) attendanceIds.add(requestId);
    for (const row of changes) {
        const attendanceId = String(row?.proposed?.attendanceId || "");
        if (isObjectId(attendanceId)) attendanceIds.add(attendanceId);
    }

    for (const id of attendanceIds) {
        const record = await Attendance.findById(id);
        if (!record) continue;
        let dirty = false;
        if (record.hourAdjustStatus === "pending") {
            record.hourAdjustStatus = "";
            record.hourAdjustKind = "";
            record.hourAdjustReason = "";
            record.hourAdjustMode = "";
            record.hoursApproved = 0;
            dirty = true;
        }
        if (record.flexibleOtStatus === "pending") {
            record.flexibleOtStatus = "";
            record.flexibleOtReason = "";
            record.flexibleOtApprovedHours = 0;
            dirty = true;
        }
        if (dirty) await record.save();
    }

    if (changeIds.length) await AttendanceChangeRequest.deleteMany({ _id: { $in: changeIds } });
    return changeIds;
}

async function deleteAlertsForRecords(recordIds = []) {
    const ids = [...new Set((recordIds || []).map((id) => String(id || "")).filter(Boolean))];
    if (!ids.length) return;
    const or = [{ recordId: { $in: ids } }];
    for (const id of ids) {
        or.push({ recordId: new RegExp(`^${escapeIdPattern(id)}:`, "i") });
    }
    await EmailNotificationLog.deleteMany({ $or: or });
}

/** Reverse the request this task started, then drop every related bell. */
async function undoTaskProcess(action) {
    const requestType = String(action?.requestType || "");
    const requestId = action?.requestId;
    if (ATTENDANCE_APPROVAL_TYPES.has(requestType)) return;
    if (requestType === "Asset Assignment" || requestType === "Asset Reassign") {
        await undoAssetAssignment(requestId);
        return;
    }
    if (ASSET_PENDING_TYPES.has(requestType)) {
        await undoPendingAssetRequest(requestId);
        return;
    }
    if (HUB_REQUEST_TYPES.has(requestType)) {
        if (isObjectId(requestId)) await EmployeeHubRequest.deleteOne({ _id: requestId });
        if (requestType === "Employee Leave Request") await undoLeaveRequest(action);
        return;
    }
    if (requestType === "Attendance Leave Request") {
        await undoLeaveRequest(action);
        return;
    }
    if (requestType === "Loan") {
        await undoMoneyRequest(Loan, requestId, "status");
        return;
    }
    if (requestType === "Fine" || requestType === "Group Fine Request") {
        await undoMoneyRequest(Fine, requestId, "fineStatus");
        return;
    }
    if (requestType === "Reward") {
        await undoMoneyRequest(Reward, requestId, "rewardStatus");
    }
}

/** Drop the task bell and undo the request it started. */
async function deleteTaskSource(action) {
    if (!action?._id) return;
    const requestType = String(action.requestType || "");
    const requestId = action.requestId;
    if (requestType === "Vehicle Service Request" && isObjectId(requestId)) {
        const serviceRecordId = String(readActionMeta(action.extra3).serviceRecordId || "").trim();
        if (isObjectId(serviceRecordId)) {
            const asset = await AssetItem.findById(requestId);
            const service = asset?.services?.id?.(serviceRecordId);
            if (asset && service) {
                const previous = String(asset.activeServiceWorkflow?.previousStatus || "").trim();
                const activeId = String(asset.activeServiceWorkflow?.serviceRecordId || "");
                service.deleteOne();
                if (activeId === serviceRecordId) {
                    asset.activeServiceWorkflow = undefined;
                    asset.markModified("activeServiceWorkflow");
                    asset.onServiceActive = false;
                    if (asset.status === "On Service" && previous) asset.status = previous;
                }
                await asset.save();
            }
        }
        const bells = await DashboardAction.find({
            requestId,
            requestType: "Vehicle Service Request",
        }).select("_id extra3").lean();
        const relatedIds = bells
            .filter((row) => {
                if (String(row._id) === String(action._id)) return true;
                if (!serviceRecordId) return false;
                return String(readActionMeta(row.extra3).serviceRecordId || "") === serviceRecordId;
            })
            .map((row) => row._id);
        await deleteTasksAndBellsForActions(relatedIds);
        await deleteDashboardActionsForVehicleService(requestId, serviceRecordId);
        if (relatedIds.length) await DashboardAction.deleteMany({ _id: { $in: relatedIds } });
        return;
    }

    await undoTaskProcess(action);
    const approvalIds = await undoAttendanceApproval(action);

    const ids = [action._id];
    const title = String(action.extra1 || "").trim();
    const leaveRequest = requestType === "Employee Leave Request" || requestType === "Attendance Leave Request";
    const attendanceApproval = ATTENDANCE_APPROVAL_TYPES.has(requestType);
    const siblingTypes = requestType === "Asset Assignment" || requestType === "Asset Reassign"
        ? ["Asset Assignment", "Asset", "Asset Reassign"]
        : leaveRequest
            ? ["Employee Leave Request", "Attendance Leave Request", "Employee Request Resend"]
            : HUB_REQUEST_TYPES.has(requestType)
                ? [...HUB_REQUEST_TYPES, "Employee Request Resend"]
                : attendanceApproval
                    ? [...ATTENDANCE_APPROVAL_TYPES]
                    : [requestType];
    const requestIds = [requestId, ...approvalIds].filter((id) => isObjectId(id));
    if (requestIds.length && requestType && requestType !== "Task Manager") {
        const related = await DashboardAction.find({
            requestId: { $in: requestIds },
            ...(attendanceApproval ? {} : { requestType: { $in: siblingTypes } }),
            ...(title && !HUB_REQUEST_TYPES.has(requestType) && !leaveRequest && !attendanceApproval ? { extra1: title } : {}),
        }).select("_id").lean();
        related.forEach((row) => ids.push(row._id));
    }
    await deleteTasksAndBellsForActions(ids);
    await DashboardAction.deleteMany({ _id: { $in: ids } });
    await deleteAlertsForRecords([...ids, ...approvalIds, requestId]);
}

async function deleteTasksAndBellsForActions(actionIds = []) {
    const ids = (actionIds || []).filter((id) => isObjectId(id));
    if (!ids.length) return;
    const tasks = await TaskManagerTask.find({ sourceDashboardActionId: { $in: ids } })
        .select("_id closeRequest")
        .lean();
    const taskIds = tasks.map((task) => task._id).filter((id) => isObjectId(id));
    const noticeIds = [];
    for (const task of tasks) {
        for (const notice of task.closeRequest?.reassignmentNotices || []) {
            if (isObjectId(notice?.requestId)) noticeIds.push(notice.requestId);
        }
    }
    const bellOr = [];
    if (taskIds.length || noticeIds.length) {
        bellOr.push({ requestId: { $in: [...taskIds, ...noticeIds] } });
    }
    for (const taskId of taskIds) {
        const id = String(taskId);
        bellOr.push({ extra3: new RegExp(`"taskManagerId":"${id}"`) });
        bellOr.push({ extra3: new RegExp(`"taskKey":"(?:manual-)?${id}"`) });
    }
    if (bellOr.length) {
        await DashboardAction.deleteMany({ requestType: "Task Manager", $or: bellOr });
    }
    await TaskManagerTask.deleteMany({ sourceDashboardActionId: { $in: ids } });
}

async function deleteTaskManagerBells(task) {
    if (!task?._id) return;
    await deleteReassignmentNotices(task);
    const id = String(task._id);
    await DashboardAction.deleteMany({
        requestType: "Task Manager",
        $or: [
            { requestId: task._id },
            { extra3: new RegExp(`"taskManagerId":"${id}"`) },
            { extra3: new RegExp(`"taskKey":"(?:manual-)?${id}"`) },
        ],
    });
}

/** Remove the task, its bell rows, and the request it started. Caller checks permission. */
export async function eraseTaskByKey(taskKey) {
    const target = await loadTarget(taskKey);
    if (!target) return { ok: false, status: 404, message: "Task not found." };
    const task = target.task;
    const manual = target.kind === "manual";
    if (task) await deleteTaskManagerBells(task);
    if (manual && task?._id) {
        if (task.sourceDashboardActionId) {
            const source = await DashboardAction.findById(task.sourceDashboardActionId);
            if (source) await deleteTaskSource(source);
        }
        await TaskManagerTask.deleteOne({ _id: task._id });
        await deleteTaskManagerBells(task);
    } else if (target.action?._id) {
        await deleteTaskSource(target.action);
        if (task?._id) {
            await TaskManagerTask.deleteOne({ _id: task._id });
            await deleteTaskManagerBells(task);
        }
    }
    return { ok: true, message: "Task deleted." };
}

export const deleteTaskManagerTask = async (req, res) => {
    try {
        if (!(await denyUnlessViewer(req, res))) return;
        const target = await loadTarget(req.params.taskKey);
        if (!target) return res.status(404).json({ message: "Task not found." });
        if (generalTaskClosed(target.task)) {
            return res.status(400).json({ message: "This task is closed. Delete is disabled." });
        }
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
        if (!manual && target.action?._id && !viewer?.superUser && target.action.requestType !== "Task Manager") {
            return res.status(403).json({
                message: "Only an admin super user can delete a system or workflow task.",
            });
        }
        const result = await eraseTaskByKey(req.params.taskKey);
        if (!result.ok) return res.status(result.status || 400).json({ message: result.message });
        return res.status(200).json({ message: result.message || "Task deleted." });
    } catch (error) {
        console.error("Delete task error:", error);
        return res.status(500).json({ message: "Failed to delete task" });
    }
};
