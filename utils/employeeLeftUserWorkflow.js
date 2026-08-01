import nodemailer from "nodemailer";
import DashboardAction from "../models/DashboardAction.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import { getDepartmentHOD } from "./getDepartmentHOD.js";
import { resolveFlowchartHrEmployee } from "./resolveFlowchartHrEmployee.js";
import { resolveFrontendBaseUrl } from "./resolveFrontendBaseUrl.js";
import { resolveProfileActivationSubmitterId } from "./resolveProfileActivationSubmitterId.js";

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

/** Resolve flowchart HR for dashboard even when company email is missing. */
async function resolveHrForLeftUserNotify() {
    const hrResolved = await resolveFlowchartHrEmployee();
    if (hrResolved?.employee?._id) {
        return {
            employee: hrResolved.employee,
            email: hrResolved.email || null,
        };
    }
    const hr = await getDepartmentHOD("hr");
    if (!hr?._id) return { employee: null, email: null };
    return {
        employee: hr,
        email: (hr.companyEmail || hr.workEmail || hr.email || "").trim() || null,
    };
}

/**
 * Queue is not enough — HR only sees Accept/Reject after profileApprovalStatus = submitted.
 * Submit (or refresh) activation so flowchart HR can approve the Left User change.
 */
async function submitLeftUserChangeForHr({ req, employee, hr, previousStatus }) {
    if (!employee?._id || !hr?._id) return;

    const eb = await EmployeeBasic.findById(employee._id);
    if (!eb) return;

    const alreadySubmitted =
        String(eb.profileApprovalStatus || "").toLowerCase() === "submitted";
    const submitterEmployeeId =
        (await resolveProfileActivationSubmitterId(req)) ||
        req?.user?.employeeObjectId ||
        req?.user?._id ||
        null;
    const fromStatus = String(previousStatus || eb.status || "").trim() || "—";

    if (!alreadySubmitted) {
        eb.profileApprovalStatus = "submitted";
        eb.profileSubmittedTo = hr._id;
        if (submitterEmployeeId) {
            eb.profileActivationSubmittedBy = submitterEmployeeId;
        }
        eb.profileActivationHold = undefined;
        if (!Array.isArray(eb.profileWorkflow)) eb.profileWorkflow = [];
        eb.profileWorkflow.push({
            role: "HR",
            assignedTo: hr._id,
            status: "submitted",
            assignedAt: new Date(),
            comment: `Type: Reactivation | Reason: Mark as Left User | Requested Changes: Work Details`,
            reason: "Left User status requested",
            description: `Mark as Left User (from ${fromStatus}) — submitted for HR approval`,
            attachment: "",
            attachmentName: "",
        });
        eb.markModified("profileWorkflow");
        await eb.save();
        await EmployeeBasic.updateOne(
            { _id: eb._id },
            { $unset: { profileActivationHold: "", profileActivationDraftEditor: "" } },
        );
        return;
    }

    if (!eb.profileSubmittedTo || String(eb.profileSubmittedTo) !== String(hr._id)) {
        eb.profileSubmittedTo = hr._id;
        await eb.save();
    }
}

/** Email + dashboard task when a non-HR user requests Left User (queued for HR approval). */
export async function notifyLeftUserPendingHr({ req, employee, previousStatus }) {
    if (!employee?._id || !employee?.employeeId) return;

    const { employee: hr, email: hrEmail } = await resolveHrForLeftUserNotify();
    if (!hr?._id) {
        console.error(
            "[notifyLeftUserPendingHr] No active Flowchart HR — cannot create dashboard task or email.",
        );
        return;
    }

    const requesterName = await resolveRequesterName(req, employee);
    const subjectName =
        `${employee.firstName || ""} ${employee.lastName || ""}`.trim() || employee.employeeId;
    const fromStatus = String(previousStatus || employee.status || "").trim() || "—";
    const baseUrl = resolveFrontendBaseUrl(req).replace(/\/$/, "");
    const profileUrl = `${baseUrl}/emp/${encodeURIComponent(employee.employeeId)}?tab=work&subTab=work-details`;

    // Submit so HR can see the pending change and use Accept / Reject on the profile.
    try {
        await submitLeftUserChangeForHr({
            req,
            employee,
            hr,
            previousStatus,
        });
    } catch (submitErr) {
        console.error("[notifyLeftUserPendingHr] auto-submit for HR failed:", submitErr);
    }

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
            extra2: `Current status: ${fromStatus}. Open profile to Accept or Reject.`,
            extra3: JSON.stringify({
                leftUserRequest: true,
                activationViewerRole: "hr",
                detailsPath: `/emp/${employee.employeeId}?tab=work&subTab=work-details`,
            }),
        });
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
            <p>Open the employee profile and use <strong>Accept</strong> or <strong>Reject</strong> on the pending Work Details (Left User) change.</p>
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
