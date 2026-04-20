import nodemailer from "nodemailer";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { resolveFlowchartHrEmployee } from "../../utils/resolveFlowchartHrEmployee.js";
import { syncDashboardAction } from "../../utils/syncDashboard.js";

const dedupeEmailList = (emails = []) => {
    const seen = new Set();
    return emails
        .map((e) => (e || "").trim())
        .filter((e) => {
            if (!e) return false;
            const k = e.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
};

/** HR is To; employee + primary reportee are CC (same thread). */
const buildProfileActivationCc = (emp, hrEmail) => {
    const skip = new Set();
    const h = (hrEmail || "").trim().toLowerCase();
    if (h) skip.add(h);
    const raw = [];
    [emp.companyEmail, emp.workEmail, emp.personalEmail, emp.email].forEach((x) => raw.push(x));
    const pr = emp.primaryReportee;
    if (pr && typeof pr === "object") {
        [pr.companyEmail, pr.workEmail, pr.personalEmail, pr.email].forEach((x) => raw.push(x));
    }
    return dedupeEmailList(raw).filter((e) => !skip.has(e.toLowerCase()));
};

export const sendApprovalEmail = async (req, res) => {
    const { id } = req.params;
    const { reason, description, attachment, attachmentName } = req.body || {};

    try {
        const employeeBasic = await getCompleteEmployee(id);
        if (!employeeBasic) {
            return res.status(404).json({ message: "Employee not found" });
        }

        if (!reason || !String(reason).trim()) {
            return res.status(400).json({ message: "Reason is required for profile activation request." });
        }
        const reasonText = String(reason).trim();
        const descriptionText = description && String(description).trim() ? String(description).trim() : "";
        const attachmentText = attachment && String(attachment).trim() ? String(attachment).trim() : null;
        const attachmentNameText = attachmentName && String(attachmentName).trim() ? String(attachmentName).trim() : "";

        const hrResolved = await resolveFlowchartHrEmployee();
        if (hrResolved.error) {
            return res.status(400).json({
                message: hrResolved.message,
                code: hrResolved.error,
            });
        }

        const hrEmployee = hrResolved.employee;
        const hrEmail = hrResolved.email;

        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();

        if (!emailUser || !emailPass) {
            return res.status(500).json({ message: "Email credentials are not configured on the server." });
        }

        const transporter = nodemailer.createTransport({
            host: "smtp.office365.com",
            port: 587,
            secure: false,
            auth: {
                user: emailUser,
                pass: emailPass,
            },
        });

        const employeeName = `${employeeBasic.firstName || ""} ${employeeBasic.lastName || ""}`.trim() || "Employee";
        const hrName = `${hrEmployee.firstName || ""} ${hrEmployee.lastName || ""}`.trim() || "HR";
        const subject = `Profile activation request: ${employeeName}`;

        const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
        const baseUrl = process.env.FRONTEND_URL || origin || "http://localhost:3000";
        const profileUrl = `${baseUrl}/emp/${employeeBasic.employeeId}`;

        const html = `
            <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
                <div style="background-color: #2563eb; color: white; padding: 20px; text-align: center;">
                    <h2 style="margin: 0;">Profile Activation Request</h2>
                </div>
                <div style="padding: 30px;">
                    <p>Hello <strong>${hrName}</strong>,</p>
                    <p>Greetings from VeRP Portal.</p>
                    <p>The following employee has completed their profile and is requesting activation. As the <strong>HR</strong> contact assigned in the company Flowchart, please review the profile and grant activation if everything is in order.</p>
                    
                    <div style="background-color: #f8fafc; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0; margin: 25px 0;">
                        <p style="margin: 0;"><strong>Employee Name:</strong> ${employeeName}</p>
                        <p style="margin: 8px 0 0 0;"><strong>Employee ID:</strong> ${employeeBasic.employeeId || "N/A"}</p>
                        <p style="margin: 8px 0 0 0;"><strong>Department:</strong> ${employeeBasic.department || "N/A"}</p>
                        <p style="margin: 8px 0 0 0;"><strong>Designation:</strong> ${employeeBasic.designation || "N/A"}</p>
                    </div>
                    
                    <p style="text-align: center; margin: 35px 0;">
                        <a href="${profileUrl}" style="background-color: #2563eb; color: white; padding: 14px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; font-size: 16px;">View & Activate Profile</a>
                    </p>
                    <div style="background-color: #f8fafc; padding: 14px 16px; border-radius: 8px; border: 1px solid #e2e8f0; margin: 18px 0;">
                        <p style="margin: 0;"><strong>Reason:</strong> ${reasonText}</p>
                        ${descriptionText ? `<p style="margin: 8px 0 0 0;"><strong>Description:</strong> ${descriptionText}</p>` : ''}
                        ${attachmentText ? `<p style="margin: 8px 0 0 0;"><strong>Attachment:</strong> <a href="${attachmentText}" target="_blank" rel="noopener noreferrer">${attachmentNameText || 'View attachment'}</a></p>` : ''}
                    </div>
                </div>
            </div>
        `;

        const ccEmails = buildProfileActivationCc(employeeBasic, hrEmail);
        console.log(`[sendApprovalEmail] To (HR): ${hrEmail}`, ccEmails.length ? `CC: ${ccEmails.join(", ")}` : "");
        await transporter.sendMail({
            from: `"VeRP Portal" <${emailUser}>`,
            to: hrEmail,
            ...(ccEmails.length ? { cc: ccEmails.join(", ") } : {}),
            subject,
            html,
        });

        await EmployeeBasic.findByIdAndUpdate(employeeBasic._id, {
            profileApprovalStatus: "submitted",
            profileSubmittedTo: hrEmployee._id,
            $push: {
                profileWorkflow: {
                    role: "HR",
                    assignedTo: hrEmployee._id,
                    status: "submitted",
                    assignedAt: new Date(),
                    comment: `Reason: ${reasonText}${descriptionText ? ` | Description: ${descriptionText}` : ""}${attachmentText ? ` | Attachment: ${attachmentText}` : ""}`,
                    reason: reasonText,
                    description: descriptionText,
                    attachment: attachmentText || "",
                    attachmentName: attachmentNameText,
                },
            },
        });

        const subjectForDashboard = await EmployeeBasic.findById(employeeBasic._id)
            .select("firstName lastName employeeId designation department")
            .lean();

        const requestedByName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(" ").trim() ||
            "";

        await syncDashboardAction({
            requestId: employeeBasic._id,
            requestType: "Profile Activation",
            assignedTo: String(hrEmployee._id),
            status: "Pending",
            subjectEmployee: subjectForDashboard || employeeBasic,
            requestedByName,
            extra1: `Profile activation — ${reasonText}`,
            extra2: employeeBasic.designation || "",
        });

        return res.status(200).json({
            message: "Approval request sent successfully.",
            notified: {
                hrEmail,
                ccEmails,
            },
        });
    } catch (error) {
        console.error("Failed to send approval email:", error);
        return res.status(500).json({ message: error.message || "Failed to send approval email." });
    }
};
