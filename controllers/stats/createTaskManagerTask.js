import mongoose from "mongoose";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import TaskManagerTask from "../../models/TaskManagerTask.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import { canonicalTaskType, sendTaskActivityEmail, syncManualTaskNotification } from "../../utils/taskManagerModule.js";
import { viewerMaySeeAllNotifications } from "./getTaskManagerNotifications.js";

const PRIORITIES = new Set(["High", "Medium", "Low"]);
const MAX_ATTACHMENTS = 5;

function isObjectId(value) {
    const text = String(value || "");
    return /^[a-fA-F0-9]{24}$/.test(text) && mongoose.Types.ObjectId.isValid(text);
}

function personName(record) {
    return [record?.firstName, record?.lastName].filter(Boolean).join(" ").trim();
}

function parseCompletionDate(value) {
    const text = String(value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const date = new Date(`${text}T12:00:00+04:00`);
    return Number.isNaN(date.getTime()) ? null : date;
}

export const getTaskManagerAssignees = async (req, res) => {
    try {
        if (!(await viewerMaySeeAllNotifications(req))) {
            return res.status(403).json({ message: "Access denied. HRM view permission is required." });
        }

        const employees = await EmployeeBasic.find({
            employeeId: { $ne: "VEGA-HR-0000" },
            status: { $ne: "Left User" },
            profileStatus: "active",
        })
            .select("firstName lastName employeeId")
            .sort({ firstName: 1, lastName: 1 })
            .lean();

        return res.status(200).json({
            employees: employees.map((employee) => ({
                id: String(employee._id),
                name: personName(employee) || employee.employeeId,
                employeeId: employee.employeeId || "",
            })),
        });
    } catch (error) {
        console.error("Task Manager assignees error:", error);
        return res.status(500).json({ message: "Failed to load assignees" });
    }
};

export const createTaskManagerTask = async (req, res) => {
    try {
        if (!(await viewerMaySeeAllNotifications(req))) {
            return res.status(403).json({ message: "Access denied. HRM view permission is required." });
        }

        const taskType = canonicalTaskType(req.body?.taskType);
        const priority = taskType === "System Task" ? "High" : String(req.body?.priority || "").trim();
        const taskName = String(req.body?.taskName || "").trim();
        const description = String(req.body?.description || "").trim();
        const assigneeId = String(req.body?.assigneeId || "").trim();
        const completionDate = parseCompletionDate(req.body?.completionDate);
        const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];

        if (!taskType) {
            return res.status(400).json({ message: "Choose a task type." });
        }
        if (!PRIORITIES.has(priority)) {
            return res.status(400).json({ message: "Choose a task priority." });
        }
        if (!taskName) {
            return res.status(400).json({ message: "Task name is required." });
        }
        if (taskName.length > 200) {
            return res.status(400).json({ message: "Task name must be 200 characters or less." });
        }
        if (description.length > 2000) {
            return res.status(400).json({ message: "Description must be 2000 characters or less." });
        }
        if (!isObjectId(assigneeId)) {
            return res.status(400).json({ message: "Select an assignee." });
        }
        if (!completionDate) {
            return res.status(400).json({ message: "Completion date is required." });
        }
        if (attachments.length > MAX_ATTACHMENTS) {
            return res.status(400).json({ message: `You can attach up to ${MAX_ATTACHMENTS} files.` });
        }

        const assignee = await EmployeeBasic.findOne({
            _id: assigneeId,
            status: { $ne: "Left User" },
        })
            .select("firstName lastName employeeId companyEmail workEmail")
            .lean();
        if (!assignee) {
            return res.status(400).json({ message: "Selected assignee was not found." });
        }

        const storedFiles = [];
        for (const file of attachments) {
            const data = String(file?.data || "");
            const name = String(file?.name || "attachment").trim() || "attachment";
            if (!data) continue;
            const uploaded = await uploadDocumentToS3(data, "task-manager", name, "raw");
            storedFiles.push({
                fileName: name,
                key: uploaded.publicId || "",
                url: uploaded.url || "",
            });
        }

        const created = await TaskManagerTask.create({
            taskType,
            priority,
            taskName,
            description,
            assignee: assignee._id,
            assigneeEmpId: assignee.employeeId || "",
            assigneeName: personName(assignee) || assignee.employeeId || "Unassigned",
            completionDate,
            attachments: storedFiles,
            requestedByName: String(req.user?.name || "").trim() || "System",
            requestedByUserId: isObjectId(req.user?.id) ? req.user.id : undefined,
            status: "Pending",
            history: [
                {
                    event: "Created",
                    detail: `Created and assigned to ${personName(assignee) || assignee.employeeId || "Unassigned"}.`,
                    actorName: String(req.user?.name || "").trim() || "System",
                    createdAt: new Date(),
                },
            ],
            updates: [
                {
                    authorName: String(req.user?.name || "").trim() || "System",
                    authorRole: "",
                    kind: "Status Changed",
                    badge: "Created",
                    text: `Task created and assigned to ${personName(assignee) || "the assignee"} for processing.`,
                    createdAt: new Date(),
                    assigneeName: personName(assignee) || "",
                    requesterName: String(req.user?.name || "").trim() || "System",
                },
            ],
        });
        try {
            await syncManualTaskNotification(created);
        } catch (syncError) {
            console.error("Task notification sync failed:", syncError);
        }
        const assigneeEmail = assignee.companyEmail || assignee.workEmail || "";
        if (assigneeEmail && created.updates?.[0]) {
            try {
                const sent = await sendTaskActivityEmail({
                    to: [assigneeEmail],
                    subject: `Task Updated: ${created.taskName}`,
                    html: `<p>Task created and assigned to you.</p><p><strong>${created.taskName}</strong></p>`,
                });
                if (sent.sent) {
                    created.updates[0].emailSent = true;
                    created.updates[0].assigneeNotified = true;
                    created.markModified("updates");
                    await created.save();
                }
            } catch (mailError) {
                console.error("Task created email failed:", mailError);
            }
        }

        return res.status(201).json({
            message: "Task created",
            task: {
                id: String(created._id),
                taskType: created.taskType,
                priority: created.priority,
                taskName: created.taskName,
            },
        });
    } catch (error) {
        console.error("Create task manager task error:", error);
        const message = String(error?.message || "");
        if (/Only PDF|upload|JPEG|PNG|file/i.test(message)) {
            return res.status(400).json({ message: message.replace(/^Failed to upload to storage:\s*/i, "") });
        }
        return res.status(500).json({ message: "Failed to create task" });
    }
};
