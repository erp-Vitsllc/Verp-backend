import mongoose from "mongoose";
import DashboardAction from "../../models/DashboardAction.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import TaskManagerTask from "../../models/TaskManagerTask.js";
import User from "../../models/User.js";
import {
    moduleForRequestType,
    moduleForText,
    resolveTaskViewer,
    viewerCanReassign,
} from "../../utils/taskManagerModule.js";

const DUBAI_DATE = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});

const PENDING_STATUSES = new Set(["Pending", "On Hold"]);

function dubaiDateKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return DUBAI_DATE.format(date);
}

function monthKeyFromDateKey(dateKey) {
    return dateKey ? dateKey.slice(0, 7) : "";
}

function shiftMonth(year, month, delta) {
    const cursor = new Date(Date.UTC(year, month - 1 + delta, 1));
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    return `${y}-${String(m).padStart(2, "0")}`;
}

function daysBetween(fromKey, toKey) {
    if (!fromKey || !toKey) return 0;
    const [fy, fm, fd] = fromKey.split("-").map(Number);
    const [ty, tm, td] = toKey.split("-").map(Number);
    return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

function isObjectId(value) {
    const text = String(value || "");
    return /^[a-fA-F0-9]{24}$/.test(text) && mongoose.Types.ObjectId.isValid(text);
}

function personName(record) {
    if (!record) return "";
    if (record.name) return String(record.name).trim();
    return [record.firstName, record.lastName].filter(Boolean).join(" ").trim();
}

export function taskCategory(requestType) {
    const type = String(requestType || "");
    if (/reminder|expiry|incomplete|not renew|probation|card deleted|value missing|overdue/i.test(type)) {
        return "System Task";
    }
    if (/request|approval|activation|loan|fine|reward|leave|salary|payment|assignment|transfer|service|inspection|disposition|notice/i.test(type)) {
        return "Work Flow Task";
    }
    return "General Task";
}

export function displayStatus(rawStatus, requestType, requestedKey, todayKey) {
    const status = String(rawStatus || "Pending");
    if (status === "Approved") return "Completed";
    if (status === "Rejected") return "Rejected";
    if (status === "Dismissed") return "Dismissed";
    if (!PENDING_STATUSES.has(status)) return status || "Pending";

    const age = daysBetween(requestedKey, todayKey);
    const urgentType = /expiry|overdue|reminder/i.test(String(requestType || ""));
    if ((urgentType && age >= 0) || age > 3) return "Pending Due";
    if (status === "On Hold") return "On Hold";
    return "Pending";
}

function priorityFor(status, requestType) {
    if (status === "Pending Due") return "High";
    if (
        (status === "Pending" || status === "On Hold") &&
        /fine|salary|payment|expiry|overdue|activation/i.test(String(requestType || ""))
    ) {
        return "High";
    }
    if (status === "Pending" || status === "On Hold") return "Medium";
    return "Low";
}

function percentChange(current, previous) {
    if (!previous && !current) return 0;
    if (!previous) return 100;
    return Math.round(((current - previous) / previous) * 100);
}

export async function viewerMaySeeAllNotifications(req) {
    if (req.user?.isAdministrator || req.user?.isAdmin || req.user?.isSystemSuperUser) {
        return true;
    }

    let userId = req.user?.id || req.user?._id || null;
    if (req.user?.actor === "employee") {
        const code = String(req.user.employeeId || "").trim();
        const linked = code
            ? await User.findOne({ employeeId: code }).select("_id").lean()
            : null;
        userId = linked?._id || null;
    }
    if (!userId) return false;

    const { getUserPermissions, isUserAdministrator } = await import("../../services/permissionService.js");
    if (await isUserAdministrator(userId)) return true;

    const record = await getUserPermissions(userId);
    const permissions = record?.permissions || {};
    if (record?.isAdministrator || record?.isAdmin) return true;

    const allowed = (entry) => entry?.isView === true || entry?.isActive === true;
    if (allowed(permissions.hrm)) return true;
    return Object.keys(permissions).some((key) => key.startsWith("hrm_") && allowed(permissions[key]));
}

/**
 * Read-only company-wide notification list.
 * Does not create, update, close, or dismiss any notification.
 */
export const getTaskManagerNotifications = async (req, res) => {
    try {
        if (!(await viewerMaySeeAllNotifications(req))) {
            return res.status(403).json({
                message: "Access denied. HRM view permission is required to see every notification.",
            });
        }
        const viewer = await resolveTaskViewer(req);

        const actions = await DashboardAction.find({})
            .select(
                "assignedTo assignedToEmpId requestId requestType status subjectEmployeeId subjectName requestedDate requestedByName actionedDate extra1 extra2 extra3 createdAt",
            )
            .lean()
            .maxTimeMS(20000);

        const assigneeIds = [
            ...new Set(actions.map((row) => String(row.assignedTo || "")).filter(isObjectId)),
        ];

        const people = await EmployeeBasic.find({
            employeeId: { $ne: "VEGA-HR-0000" },
        })
            .select("firstName lastName employeeId profilePicture")
            .lean();

        const byId = new Map();
        const byCode = new Map();
        const nameOwners = new Map();
        for (const person of people) {
            const id = String(person._id);
            const code = String(person.employeeId || "").trim();
            byId.set(id, person);
            if (code) byCode.set(code, person);
            const name = personName(person).toLowerCase();
            if (!name) continue;
            const owners = nameOwners.get(name) || [];
            owners.push(person);
            nameOwners.set(name, owners);
        }

        const missingUserIds = assigneeIds.filter((id) => !byId.has(id));
        if (missingUserIds.length) {
            const users = await User.find({ _id: { $in: missingUserIds } })
                .select("name employeeId")
                .lean();
            for (const user of users) {
                byId.set(String(user._id), user);
                const code = String(user.employeeId || "").trim();
                if (code && !byCode.has(code)) byCode.set(code, user);
            }
        }

        const photoForName = (name) => {
            const owners = nameOwners.get(String(name || "").trim().toLowerCase()) || [];
            if (owners.length !== 1) return "";
            return owners[0].profilePicture || "";
        };

        const todayKey = dubaiDateKey(new Date());
        const todayParts = todayKey.split("-").map(Number);
        const thisMonth = monthKeyFromDateKey(todayKey);
        const lastMonth = shiftMonth(todayParts[0], todayParts[1], -1);

        const manualRows = await TaskManagerTask.find({})
            .select(
                "taskType priority taskName description assignee assigneeEmpId assigneeName completionDate requestedByName status createdAt updatedAt sourceDashboardActionId attachments comments history reminders",
            )
            .lean()
            .maxTimeMS(10000);
        const overlayByAction = new Map();
        const createdRows = [];
        for (const row of manualRows) {
            if (row.sourceDashboardActionId) overlayByAction.set(String(row.sourceDashboardActionId), row);
            else createdRows.push(row);
        }

        const monthCounts = {
            total: { current: 0, previous: 0 },
            pending: { current: 0, previous: 0 },
            pendingDue: { current: 0, previous: 0 },
            completed: { current: 0, previous: 0 },
        };
        const bump = (bucket, month) => {
            if (month === thisMonth) monthCounts[bucket].current += 1;
            else if (month === lastMonth) monthCounts[bucket].previous += 1;
        };

        const summary = { total: 0, pending: 0, pendingDue: 0, completed: 0 };
        const tasks = actions.filter((action) => action.requestType !== "Task Manager").map((action) => {
            const requestedAt = action.requestedDate || action.createdAt || null;
            const requestedKey = dubaiDateKey(requestedAt);
            const status = displayStatus(action.status, action.requestType, requestedKey, todayKey);
            const assignee =
                byId.get(String(action.assignedTo || "")) ||
                byCode.get(String(action.assignedToEmpId || "").trim()) ||
                null;
            const overlay = overlayByAction.get(String(action._id));
            const assigneeId = String(overlay?.assignee || action.assignedTo || "");
            const assigneeEmpId = String(overlay?.assigneeEmpId || action.assignedToEmpId || "").trim();
            const assigneeRecord = byId.get(assigneeId) || byCode.get(assigneeEmpId) || assignee;
            const assigneeName = personName(assigneeRecord) || overlay?.assigneeName || String(action.assignedToEmpId || "").trim() || "Unassigned";
            const requesterName = String(action.requestedByName || "").trim() || "System";
            const destination = moduleForRequestType(action.requestType, `${action.extra1 || ""} ${action.extra2 || ""}`);
            const requestMonth = monthKeyFromDateKey(requestedKey);
            const completedMonth = monthKeyFromDateKey(dubaiDateKey(action.actionedDate || requestedAt));

            summary.total += 1;
            bump("total", requestMonth);
            if (status === "Pending" || status === "On Hold") {
                summary.pending += 1;
                bump("pending", requestMonth);
            } else if (status === "Pending Due") {
                summary.pendingDue += 1;
                bump("pendingDue", requestMonth);
            } else if (status === "Completed") {
                summary.completed += 1;
                bump("completed", completedMonth);
            }

            return {
                actionId: String(action._id),
                manual: false,
                workflowLocked: action.requestType !== "Task Manager",
                canReassign: viewerCanReassign(viewer, assigneeId, assigneeEmpId),
                taskNumber: "",
                requestDate: requestedAt,
                completionDate: overlay?.completionDate || action.actionedDate || null,
                taskCategory: overlay?.taskType || taskCategory(action.requestType),
                requestType: action.requestType || "Notification",
                taskName: overlay?.taskName || String(action.extra1 || "").trim() || action.requestType || "Notification",
                description: overlay?.description || String(action.extra2 || action.extra1 || "").trim(),
                requesterName,
                requesterPhoto: photoForName(requesterName),
                assigneeId,
                assigneeName,
                assigneePhoto: assigneeRecord?.profilePicture || "",
                assigneeEmpId: String(assigneeRecord?.employeeId || assigneeEmpId).trim(),
                priority: overlay?.priority || priorityFor(status, action.requestType),
                module: destination.module,
                moduleLabel: destination.label,
                modulePath: destination.path,
                displayStatus: status,
                rawStatus: action.status || "Pending",
                id: action.requestId ? String(action.requestId) : "",
                type: action.requestType || "",
                extra1: action.extra1 || "",
                extra2: action.extra2 || "",
                extra3: action.extra3 || "",
                targetEmployeeId: action.subjectEmployeeId || "",
                subjectName: action.subjectName || "",
                requestedBy: action.requestedByName || "",
                requestedByName: action.requestedByName || "",
                status: action.status || "Pending",
                requestedDate: requestedAt,
            };
        });

        for (const row of createdRows) {
            const requestedAt = row.createdAt || null;
            const requestedKey = dubaiDateKey(requestedAt);
            const dueKey = dubaiDateKey(row.completionDate);
            const status = row.status === "Completed"
                ? "Completed"
                : row.status === "Cancelled"
                    ? "Cancelled"
                    : row.status === "In Progress"
                        ? "In Progress"
                        : dueKey && dueKey <= todayKey
                            ? "Pending Due"
                            : "Pending";
            const assignee = byId.get(String(row.assignee || "")) || null;
            const assigneeName = personName(assignee) || row.assigneeName || row.assigneeEmpId || "Unassigned";
            const requesterName = String(row.requestedByName || "").trim() || "System";
            const requestMonth = monthKeyFromDateKey(requestedKey);
            const completedMonth = monthKeyFromDateKey(dueKey);

            summary.total += 1;
            bump("total", requestMonth);
            if (status === "Pending" || status === "In Progress") {
                summary.pending += 1;
                bump("pending", requestMonth);
            } else if (status === "Pending Due") {
                summary.pendingDue += 1;
                bump("pendingDue", requestMonth);
            } else if (status === "Completed") {
                summary.completed += 1;
                bump("completed", completedMonth);
            }

            const destination = moduleForText(row.taskName, row.description, row.taskType);
            const assigneeId = String(row.assignee || "");
            tasks.push({
                actionId: `manual-${row._id}`,
                manual: true,
                workflowLocked: false,
                canReassign: viewerCanReassign(viewer, assigneeId, row.assigneeEmpId),
                taskNumber: "",
                requestDate: requestedAt,
                completionDate: row.completionDate || null,
                taskCategory: row.taskType,
                requestType: row.taskType,
                taskName: row.taskName || "Task",
                description: row.description || "",
                requesterName,
                requesterPhoto: photoForName(requesterName),
                assigneeId,
                assigneeName,
                assigneePhoto: assignee?.profilePicture || "",
                assigneeEmpId: String(assignee?.employeeId || row.assigneeEmpId || "").trim(),
                priority: row.priority || "Medium",
                module: destination.module,
                moduleLabel: destination.label,
                modulePath: destination.path,
                displayStatus: status,
                rawStatus: row.status || "Pending",
                id: String(row._id),
                type: row.taskType || "",
                extra1: row.description || row.taskName || "",
                extra2: "",
                extra3: "",
                targetEmployeeId: row.assigneeEmpId || "",
                subjectName: assigneeName,
                requestedBy: requesterName,
                requestedByName: requesterName,
                status: row.status || "Pending",
                requestedDate: requestedAt,
            });
        }

        const numbered = [...tasks].sort((a, b) => {
            const aTime = new Date(a.requestDate || 0).getTime();
            const bTime = new Date(b.requestDate || 0).getTime();
            if (aTime !== bTime) return aTime - bTime;
            return String(a.actionId).localeCompare(String(b.actionId));
        });
        const yearSequence = new Map();
        for (const task of numbered) {
            const year = dubaiDateKey(task.requestDate || new Date()).slice(0, 4) || "0000";
            const next = (yearSequence.get(year) || 0) + 1;
            yearSequence.set(year, next);
            task.taskNumber = `TSK-${year}-${String(next).padStart(3, "0")}`;
        }

        const statusRank = {
            "Pending Due": 0,
            Pending: 1,
            "In Progress": 2,
            "On Hold": 3,
            Completed: 4,
            Cancelled: 5,
            Rejected: 6,
            Dismissed: 7,
        };
        const priorityRank = { High: 0, Medium: 1, Low: 2 };
        tasks.sort((a, b) => {
            const priorityGap = (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9);
            if (priorityGap) return priorityGap;
            const statusGap = (statusRank[a.displayStatus] ?? 9) - (statusRank[b.displayStatus] ?? 9);
            if (statusGap) return statusGap;
            const aTime = new Date(a.requestDate || 0).getTime();
            const bTime = new Date(b.requestDate || 0).getTime();
            return bTime - aTime;
        });

        return res.status(200).json({
            summary: {
                ...summary,
                totalChange: percentChange(monthCounts.total.current, monthCounts.total.previous),
                pendingChange: percentChange(monthCounts.pending.current, monthCounts.pending.previous),
                pendingDueChange: percentChange(monthCounts.pendingDue.current, monthCounts.pendingDue.previous),
                completedChange: percentChange(monthCounts.completed.current, monthCounts.completed.previous),
            },
            tasks,
        });
    } catch (error) {
        console.error("Task Manager notifications error:", error);
        return res.status(500).json({ message: "Failed to load task manager notifications" });
    }
};
