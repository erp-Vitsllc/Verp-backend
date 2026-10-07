import nodemailer from "nodemailer";
import DashboardAction from "../models/DashboardAction.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import EmployeeContact from "../models/EmployeeContact.js";
import { emailFrontendUrl } from "./resolveFrontendBaseUrl.js";
import { resolveEmployeeEmailWithReporteeLoaded } from "./resolveEmployeeEmail.js";
import { isReqUserSystemSuperUser } from "./systemSuperUser.js";

const TASK_TYPE_LABELS = new Map([
    ["system", "System Task"],
    ["system task", "System Task"],
    ["workflow", "Workflow Task"],
    ["workflow task", "Workflow Task"],
    ["work flow task", "Workflow Task"],
    ["general", "General Task"],
    ["general task", "General Task"],
]);

export function canonicalTaskType(value) {
    const key = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
    return TASK_TYPE_LABELS.get(key) || "";
}

/** UI label. Keeps an unknown stored value so older rows still display. */
export function displayTaskType(value) {
    return canonicalTaskType(value) || String(value || "").trim();
}

export function personName(record) {
    if (!record) return "";
    if (record.name) return String(record.name).trim();
    return [record.firstName, record.lastName].filter(Boolean).join(" ").trim();
}

export function isObjectId(value) {
    const text = String(value || "");
    return /^[a-fA-F0-9]{24}$/.test(text);
}

export function moduleForText(...parts) {
    const blob = parts.filter(Boolean).join(" ").toLowerCase();
    if (blob.includes("vehicle") || blob.includes("fleet") || blob.includes("plate")) {
        return { module: "vehicle", label: "Vehicle", path: "/HRM/Asset/Vehicle" };
    }
    if (blob.includes("fine")) return { module: "fine", label: "Fine", path: "/HRM/Fine" };
    if (blob.includes("leave")) return { module: "leave", label: "Leave", path: "/HRM/Leave/annual-leave" };
    if (blob.includes("attendance")) return { module: "attendance", label: "Attendance", path: "/HRM/Attendance" };
    if (blob.includes("loan") || blob.includes("advance")) {
        return { module: "loan", label: "Loan and Advance", path: "/HRM/LoanAndAdvance" };
    }
    if (blob.includes("reward")) return { module: "reward", label: "Reward", path: "/HRM/Reward" };
    if (blob.includes("salary") || blob.includes("payroll")) {
        return { module: "salary", label: "Salary", path: "/HRM/Salary" };
    }
    if (blob.includes("utility")) return { module: "utility", label: "Utility Bills", path: "/HRM/Asset/UtilityBills" };
    if (blob.includes("tool") || blob.includes("asset")) {
        return { module: "tools", label: "Tools Asset", path: "/HRM/Asset" };
    }
    if (blob.includes("payment")) return { module: "payment", label: "Payments", path: "/Accounts/Payments" };
    if (blob.includes("company")) return { module: "company", label: "Company", path: "/Company" };
    return { module: "general", label: "Task Manager", path: "/task-manager" };
}

export function moduleForRequestType(requestType, extraText = "") {
    const type = String(requestType || "");
    const low = type.toLowerCase();
    if (low.startsWith("vehicle") || low.includes("vehicle")) {
        return { module: "vehicle", label: "Vehicle", path: "/HRM/Asset/Vehicle" };
    }
    if (low.includes("fine")) return { module: "fine", label: "Fine", path: "/HRM/Fine" };
    if (low.includes("leave")) return { module: "leave", label: "Leave", path: "/HRM/Leave/annual-leave" };
    if (low.includes("attendance")) return { module: "attendance", label: "Attendance", path: "/HRM/Attendance" };
    if (low.includes("loan") || low.includes("advance")) {
        return { module: "loan", label: "Loan and Advance", path: "/HRM/LoanAndAdvance" };
    }
    if (low.includes("reward")) return { module: "reward", label: "Reward", path: "/HRM/Reward" };
    if (low.includes("salary")) return { module: "salary", label: "Salary", path: "/HRM/Salary" };
    if (low.includes("utility")) return { module: "utility", label: "Utility Bills", path: "/HRM/Asset/UtilityBills" };
    if (low.includes("payment")) return { module: "payment", label: "Payments", path: "/Accounts/Payments" };
    if (low.includes("company")) return { module: "company", label: "Company", path: "/Company" };
    if (low.includes("asset") || low.includes("tool")) {
        return { module: "tools", label: "Tools Asset", path: "/HRM/Asset" };
    }
    if (low.includes("profile") || low.includes("probation") || low.includes("employee") || low.includes("notice")) {
        return { module: "employees", label: "Employees", path: "/emp" };
    }
    return moduleForText(type, extraText);
}

/** Opens the record behind a task. Falls back to the module list when there is no record id. */
export function accessPathFor(destination, requestId, subjectEmployeeId) {
    const id = String(requestId || "").trim();
    const employeeCode = String(subjectEmployeeId || "").trim();
    const moduleName = destination?.module || "";
    const base = destination?.path || "/task-manager";
    if (moduleName === "fine" && id) return `/HRM/Fine/${id}`;
    if (moduleName === "loan" && id) return `/HRM/LoanAndAdvance/${id}`;
    if (moduleName === "reward" && id) return `/HRM/Reward/${id}`;
    if (moduleName === "vehicle" && id) return `/HRM/Asset/Vehicle/details/${id}`;
    if (moduleName === "tools" && id) return `/HRM/Asset/details/${id}`;
    if (moduleName === "employees" && employeeCode) return `/emp/${encodeURIComponent(employeeCode)}`;
    if (moduleName === "company" && id) return `/Company/${id}`;
    return base;
}

export async function resolveTaskViewer(req) {
    const superUser = await isReqUserSystemSuperUser(req.user);
    let employeeObjectId = req.user?.employeeObjectId ? String(req.user.employeeObjectId) : "";
    if (!employeeObjectId && req.user?.actor === "employee" && isObjectId(req.user.id)) {
        employeeObjectId = String(req.user.id);
    }
    if (!employeeObjectId && req.user?.employeeId) {
        const emp = await EmployeeBasic.findOne({ employeeId: req.user.employeeId }).select("_id").lean();
        if (emp?._id) employeeObjectId = String(emp._id);
    }
    return {
        superUser,
        name: String(req.user?.name || "").trim() || "User",
        employeeId: String(req.user?.employeeId || "").trim(),
        employeeObjectId,
        userId: String(req.user?.id || ""),
    };
}

export function viewerCanReassign(viewer, assigneeId, assigneeEmpId) {
    if (viewer?.superUser) return true;
    const assignee = String(assigneeId || "");
    if (assignee && viewer?.employeeObjectId && viewer.employeeObjectId === assignee) return true;
    if (assignee && viewer?.userId && viewer.userId === assignee) return true;
    if (
        assigneeEmpId &&
        viewer?.employeeId &&
        String(viewer.employeeId) === String(assigneeEmpId)
    ) {
        return true;
    }
    return false;
}

export async function loadPeopleDetails(ids = [], codes = []) {
    const objectIds = [...new Set(ids.map((id) => String(id || "")).filter(isObjectId))];
    const empCodes = [...new Set(codes.map((code) => String(code || "").trim()).filter(Boolean))];
    const or = [];
    if (objectIds.length) or.push({ _id: { $in: objectIds } });
    if (empCodes.length) or.push({ employeeId: { $in: empCodes } });
    const employees = or.length
        ? await EmployeeBasic.find({ $or: or })
              .select("firstName lastName employeeId designation department companyEmail workEmail profilePicture")
              .lean()
        : [];
    const contactKeys = [
        ...employees.map((emp) => String(emp._id)),
        ...employees.map((emp) => String(emp.employeeId || "")).filter(Boolean),
    ];
    const contacts = contactKeys.length
        ? await EmployeeContact.find({ employeeId: { $in: contactKeys } }).select("employeeId contactNumber").lean()
        : [];
    const phoneByKey = new Map(contacts.map((row) => [String(row.employeeId), row.contactNumber || ""]));
    return employees.map((emp) => ({
        ...emp,
        phone: phoneByKey.get(String(emp._id)) || phoneByKey.get(String(emp.employeeId || "")) || "",
    }));
}

export function peopleIndex(employees = []) {
    const byId = new Map();
    const byCode = new Map();
    for (const emp of employees) {
        byId.set(String(emp._id), emp);
        if (emp.employeeId) byCode.set(String(emp.employeeId), emp);
    }
    return { byId, byCode };
}

export function contactCard(emp) {
    if (!emp) {
        return { name: "", role: "", email: "", phone: "", photo: "", employeeId: "", id: "" };
    }
    return {
        id: String(emp._id || ""),
        name: personName(emp),
        role: emp.designation || "",
        email: emp.companyEmail || emp.workEmail || "",
        phone: emp.phone || "",
        photo: emp.profilePicture || "",
        employeeId: emp.employeeId || "",
    };
}

function mailTransport() {
    const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
    const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;
    if (!emailUser || !emailPass) return null;
    const host =
        emailUser.includes("@gmail.com") || process.env.GMAIL_USER ? "smtp.gmail.com" : "smtp.office365.com";
    return {
        from: emailUser,
        transporter: nodemailer.createTransport({
            host,
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        }),
    };
}

export async function sendTaskReassignedEmail({ toEmp, taskName, taskNumber, reason, modulePath, requesterName }) {
    const mail = mailTransport();
    const resolved = await resolveEmployeeEmailWithReporteeLoaded(toEmp);
    const to = resolved?.email;
    if (!mail || !to) return { sent: false };
    const base = emailFrontendUrl();
    const path = modulePath || "/task-manager";
    const link = path.startsWith("http") ? path : `${base}${path.startsWith("/") ? path : `/${path}`}`;
    const escapeHtml = (value) =>
        String(value || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    const who = escapeHtml(personName(toEmp) || "there");
    await mail.transporter.sendMail({
        from: mail.from,
        to,
        subject: `Task reassigned to you: ${taskName || taskNumber || "Task"}`,
        html: `
            <p>Hello ${who},</p>
            <p>This task has been reassigned to you.</p>
            <p><strong>${escapeHtml(taskNumber || "Task")}</strong> — ${escapeHtml(taskName || "Task")}</p>
            ${reason ? `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : ""}
            ${requesterName ? `<p><strong>Requested by:</strong> ${escapeHtml(requesterName)}</p>` : ""}
            <p><a href="${escapeHtml(link)}">Open the task</a></p>
        `,
    });
    return { sent: true, to };
}

export async function sendTaskActivityEmail({ to = [], subject, html }) {
    const mail = mailTransport();
    const recipients = [...new Set(to.map((item) => String(item || "").trim()).filter(Boolean))];
    if (!mail || !recipients.length) return { sent: false, to: [] };
    await mail.transporter.sendMail({
        from: mail.from,
        to: recipients.join(", "),
        subject: subject || "Task update",
        html,
    });
    return { sent: true, to: recipients };
}

export async function loadTaskManagerInboxItems(assigneeClauses, moduleName) {
    const moduleKey = String(moduleName || "").trim();
    if (!Array.isArray(assigneeClauses) || !assigneeClauses.length || !moduleKey) return [];
    const rows = await DashboardAction.find({
        status: "Pending",
        requestType: "Task Manager",
        extra3: new RegExp(`"module":"${moduleKey}"`),
        $or: assigneeClauses,
    })
        .sort({ requestedDate: -1 })
        .limit(50)
        .lean();
    return rows.map((da) => ({
        dashboardActionId: da._id,
        requestType: da.requestType,
        requestedDate: da.requestedDate,
        requestedByName: da.requestedByName,
        subjectName: da.subjectName,
        extra1: da.extra1,
        extra2: da.extra2,
        extra3: da.extra3,
        requestObjectId: da.requestId,
        primaryAssetId: "",
        asset: null,
    }));
}

export async function syncManualTaskNotification(task) {
    if (!task?._id || !task.assignee) return null;
    const destination = moduleForText(task.taskName, task.description, task.taskType, task.requestType);
    const closed = task.status === "Completed" || task.status === "Cancelled";
    const extra3 = JSON.stringify({
        taskManager: true,
        module: destination.module,
        path: destination.path,
        taskManagerId: String(task._id),
    });
    return DashboardAction.findOneAndUpdate(
        { requestId: task._id, requestType: "Task Manager" },
        {
            assignedTo: task.assignee,
            assignedToEmpId: task.assigneeEmpId || "",
            requestId: task._id,
            requestType: "Task Manager",
            status: closed ? (task.status === "Cancelled" ? "Dismissed" : "Approved") : "Pending",
            subjectEmployeeId: task.assigneeEmpId || "",
            subjectName: task.assigneeName || "",
            requestedByName: task.requestedByName || "",
            requestedDate: task.createdAt || new Date(),
            extra1: task.taskName || "Task",
            extra2: task.description || "",
            extra3,
            actionedDate: closed ? new Date() : null,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}
