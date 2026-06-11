import nodemailer from "nodemailer";
import DashboardAction from "../models/DashboardAction.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import { resolveFlowchartHrEmployee } from "./resolveFlowchartHrEmployee.js";
import { resolveFrontendBaseUrl } from "./resolveFrontendBaseUrl.js";

export const LEFT_USER_REQUEST_TYPE = "Left User Request";

const escapeHtml = (value = "") =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

const createTransporter = () => {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) return null;
    return nodemailer.createTransport({
        host: "smtp.office365.com",
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });
};

async function resolveRequesterName(req, employee) {
    if (req?.user?.name) return String(req.user.name).trim();
    const actorId = req?.user?.employeeObjectId || req?.user?.employeeId;
    if (actorId) {
        const actor = await EmployeeBasic.findOne({
            $or: [{ _id: actorId }, { employeeId: actorId }],
        })
            .select("firstName lastName employeeId")
            .lean();
        if (actor) {
            const name = `${actor.firstName || ""} ${actor.lastName || ""}`.trim();
            return name || actor.employeeId || "User";
        }
    }
    const subjectName = `${employee?.firstName || ""} ${employee?.lastName || ""}`.trim();
    return subjectName || employee?.employeeId || "User";
}

/** Email + dashboard task when a non-HR user requests Left User (queued for HR approval). */
export async function notifyLeftUserPendingHr({ req, employee, previousStatus }) {
    if (!employee?._id || !employee?.employeeId) return;

    const hrResolved = await resolveFlowchartHrEmployee();
    const hr = hrResolved?.employee;
    const hrEmail = hrResolved?.email;
    const requesterName = await resolveRequesterName(req, employee);
    const subjectName = `${employee.firstName || ""} ${employee.lastName || ""}`.trim() || employee.employeeId;
    const fromStatus = String(previousStatus || employee.status || "").trim() || "—";
    const baseUrl = resolveFrontendBaseUrl(req).replace(/\/$/, "");
    const profileUrl = `${baseUrl}/emp/${encodeURIComponent(employee.employeeId)}?tab=work&subTab=work-details`;

    if (hr?._id) {
        const exists = await DashboardAction.findOne({
            assignedTo: hr._id,
            requestId: employee._id,
            requestType: LEFT_USER_REQUEST_TYPE,
            status: "Pending",
        }).lean();
        if (!exists) {
            await DashboardAction.create({
                assignedTo: hr._id,
                ...(hr.employeeId ? { assignedToEmpId: hr.employeeId } : {}),
                requestId: employee._id,
                requestType: LEFT_USER_REQUEST_TYPE,
                status: "Pending",
                subjectEmployeeId: employee.employeeId,
                subjectName,
                requestedByName: requesterName,
                extra1: `Mark as Left User — ${subjectName}`,
                extra2: `Current status: ${fromStatus}. Approve via profile activation review.`,
            });
        }
    }

    const transporter = createTransporter();
    const emailUser = process.env.EMAIL_USER?.trim();
    if (!transporter || !hrEmail || !emailUser) return;

    await transporter.sendMail({
        from: `"VeRP Notifications" <${emailUser}>`,
        to: hrEmail,
        subject: `Left User approval required — ${subjectName} (${employee.employeeId})`,
        html: `<div style="font-family:Arial,sans-serif;line-height:1.6;max-width:640px;">
            <p><strong>Flowchart HR</strong> — a user requested to mark an employee as <strong>Left User</strong>.</p>
            <p><strong>Employee:</strong> ${escapeHtml(subjectName)} (${escapeHtml(employee.employeeId)})</p>
            <p><strong>Requested by:</strong> ${escapeHtml(requesterName)}</p>
            <p><strong>Current work status:</strong> ${escapeHtml(fromStatus)}</p>
            <p>The change is queued for HR activation approval. Review the pending Work Details change and approve or reject the profile submission.</p>
            <p><a href="${profileUrl}">Open employee Work Details</a></p>
        </div>`,
    });
}

/** Close pending Left User dashboard rows after HR approves or rejects. */
export async function closeLeftUserDashboardTasks({
    employeeMongoId,
    status,
    actionedBy = null,
    comment = "",
}) {
    if (!employeeMongoId || !status) return;
    const pendingRows = await DashboardAction.find({
        requestId: employeeMongoId,
        requestType: LEFT_USER_REQUEST_TYPE,
        status: "Pending",
    })
        .select("_id")
        .lean();
    if (pendingRows.length === 0) return;

    const ids = pendingRows.map((row) => row._id);
    await DashboardAction.updateMany(
        { _id: { $in: ids } },
        {
            status,
            actionedDate: new Date(),
            comment: comment || "",
            ...(actionedBy ? { actionedBy } : {}),
        },
    );
    if (status !== "Pending") {
        await DashboardAction.deleteMany({ _id: { $in: ids } });
    }
}

export function pendingChangesIncludeLeftUser(pendingChanges = []) {
    return (Array.isArray(pendingChanges) ? pendingChanges : []).some(
        (change) =>
            String(change?.section || "").toLowerCase() === "workdetails" &&
            String(change?.proposedData?.status || "").trim() === "Left User",
    );
}
