import nodemailer from "nodemailer";
import EmployeeBasic from "../models/EmployeeBasic.js";
import { resolveFlowchartHrEmployee } from "./resolveFlowchartHrEmployee.js";
import { syncDashboardAction } from "./syncDashboard.js";

const getRequestedByName = (actor = {}) => {
    if (actor?.name && String(actor.name).trim()) return String(actor.name).trim();
    const full = `${actor?.firstName || ""} ${actor?.lastName || ""}`.trim();
    if (full) return full;
    return actor?.employeeId || "System";
};

const sendReactivationEmailToHr = async ({ hrEmail, hrName, employee, requestedByName, reason }) => {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass || !hrEmail) return;

    const transporter = nodemailer.createTransport({
        host: "smtp.office365.com",
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });

    const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const profileUrl = `${baseUrl}/emp/${employee.employeeId}`;
    const employeeName = `${employee.firstName || ""} ${employee.lastName || ""}`.trim() || employee.employeeId;
    const subject = `Profile reactivation required: ${employeeName}`;

    const html = `
        <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 640px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
            <div style="background:#b91c1c;color:#fff;padding:18px 22px;">
                <h2 style="margin:0;">Profile Reactivation Required</h2>
            </div>
            <div style="padding:22px;">
                <p>Hello <strong>${hrName}</strong>,</p>
                <p>An already active employee profile was edited after activation and has been automatically moved to <strong>inactive</strong> pending HR authorization.</p>
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin:16px 0;">
                    <p style="margin:0;"><strong>Employee:</strong> ${employeeName}</p>
                    <p style="margin:6px 0 0;"><strong>Employee ID:</strong> ${employee.employeeId || "N/A"}</p>
                    <p style="margin:6px 0 0;"><strong>Updated by:</strong> ${requestedByName}</p>
                    <p style="margin:6px 0 0;"><strong>Change:</strong> ${reason}</p>
                </div>
                <p style="margin-top:20px;">
                    <a href="${profileUrl}" style="background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600;display:inline-block;">Review & Reactivate</a>
                </p>
            </div>
        </div>
    `;

    await transporter.sendMail({
        from: `"VeRP Portal" <${emailUser}>`,
        to: hrEmail,
        subject,
        html,
    });
};

/**
 * After an active profile is edited, automatically mark it inactive and submit to HR.
 * Only applies when the employee has a company assigned.
 */
export const triggerProfileReactivationIfNeeded = async ({
    employeeId,
    actor = null,
    reason = "Profile data edited",
}) => {
    if (!employeeId) return { triggered: false };

    const employee = await EmployeeBasic.findOne({ employeeId })
        .select("_id employeeId firstName lastName designation company profileStatus profileApprovalStatus")
        .lean();
    if (!employee) return { triggered: false };

    // Applies only after profile/company activation.
    if (!employee.company || employee.profileStatus !== "active") {
        return { triggered: false };
    }

    const hrResolved = await resolveFlowchartHrEmployee();
    if (hrResolved.error) {
        // Keep profile active if routing to HR is impossible.
        return { triggered: false, error: hrResolved.error, message: hrResolved.message };
    }

    const hrEmployee = hrResolved.employee;
    const requestedByName = getRequestedByName(actor);

    await EmployeeBasic.updateOne(
        { employeeId },
        {
            $set: {
                profileStatus: "inactive",
                profileApprovalStatus: "submitted",
                profileSubmittedTo: hrEmployee._id,
            },
            $push: {
                profileWorkflow: {
                    role: "HR",
                    assignedTo: hrEmployee._id,
                    status: "submitted",
                    assignedAt: new Date(),
                    comment: `Auto-submitted for reactivation: ${reason}`,
                },
            },
        }
    );

    await syncDashboardAction({
        requestId: employee._id,
        requestType: "Profile Activation",
        assignedTo: String(hrEmployee._id),
        status: "Pending",
        subjectEmployee: employee,
        requestedByName,
        extra1: "Profile reactivation — edited after activation",
        extra2: employee.designation || "",
    });

    try {
        const hrName = `${hrEmployee.firstName || ""} ${hrEmployee.lastName || ""}`.trim() || "HR";
        await sendReactivationEmailToHr({
            hrEmail: hrResolved.email,
            hrName,
            employee,
            requestedByName,
            reason,
        });
    } catch (emailErr) {
        console.error("[triggerProfileReactivationIfNeeded] Email failed:", emailErr?.message || emailErr);
    }

    return { triggered: true };
};
