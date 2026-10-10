import mongoose from "mongoose";

const attachmentSchema = new mongoose.Schema(
    {
        fileName: { type: String, default: "" },
        key: { type: String, default: "" },
        url: { type: String, default: "" },
    },
    { _id: false },
);

const taskManagerTaskSchema = new mongoose.Schema(
    {
        taskType: {
            type: String,
            enum: ["System Task", "Workflow Task", "Work Flow Task", "General Task"],
            required: true,
        },
        priority: {
            type: String,
            enum: ["High", "Medium", "Low"],
            required: true,
        },
        taskName: { type: String, required: true, trim: true },
        description: { type: String, default: "", trim: true },
        assignee: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeBasic", required: true },
        assigneeEmpId: { type: String, default: "" },
        assigneeName: { type: String, default: "" },
        completionDate: { type: Date, required: true },
        attachments: { type: [attachmentSchema], default: [] },
        requestedByName: { type: String, default: "" },
        requestedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        sourceDashboardActionId: { type: mongoose.Schema.Types.ObjectId, default: null },
        status: {
            type: String,
            enum: ["Pending", "In Progress", "Completed", "Cancelled"],
            default: "Pending",
        },
        comments: {
            type: [
                {
                    authorName: { type: String, default: "" },
                    authorRole: { type: String, default: "" },
                    text: { type: String, default: "" },
                    createdAt: { type: Date, default: Date.now },
                    emailSent: { type: Boolean, default: false },
                    assigneeNotified: { type: Boolean, default: false },
                    requesterNotified: { type: Boolean, default: false },
                    assigneeName: { type: String, default: "" },
                    requesterName: { type: String, default: "" },
                },
            ],
            default: [],
        },
        updates: {
            type: [
                {
                    authorName: { type: String, default: "" },
                    authorRole: { type: String, default: "" },
                    kind: { type: String, default: "Work Update" },
                    badge: { type: String, default: "" },
                    text: { type: String, default: "" },
                    createdAt: { type: Date, default: Date.now },
                    emailSent: { type: Boolean, default: false },
                    assigneeNotified: { type: Boolean, default: false },
                    requesterNotified: { type: Boolean, default: false },
                    assigneeName: { type: String, default: "" },
                    requesterName: { type: String, default: "" },
                },
            ],
            default: [],
        },
        notifications: {
            workUpdate: { type: Boolean, default: true },
            comment: { type: Boolean, default: true },
        },
        history: {
            type: [
                {
                    event: { type: String, default: "" },
                    detail: { type: String, default: "" },
                    actorName: { type: String, default: "" },
                    createdAt: { type: Date, default: Date.now },
                },
            ],
            default: [],
        },
        reminders: {
            dueDate: { type: Boolean, default: true },
            overdue: { type: Boolean, default: false },
        },
        closeRequest: {
            originalAssigneeId: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeBasic", default: null },
            originalAssigneeEmpId: { type: String, default: "" },
            originalAssigneeName: { type: String, default: "" },
            requestedAt: { type: Date, default: null },
            requestedByName: { type: String, default: "" },
            assigneeNotifiedAt: { type: Date, default: null },
            closedAt: { type: Date, default: null },
            closedByName: { type: String, default: "" },
            requesterNotifiedAt: { type: Date, default: null },
            requesterChannel: { type: String, default: "" },
        },
    },
    { timestamps: true },
);

taskManagerTaskSchema.index({ priority: 1, createdAt: -1 });
taskManagerTaskSchema.index({ assignee: 1, status: 1 });
taskManagerTaskSchema.index({ sourceDashboardActionId: 1 });

export default mongoose.model("TaskManagerTask", taskManagerTaskSchema);
