import nodemailer from "nodemailer";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { resolveFlowchartHrEmployee } from "../../utils/resolveFlowchartHrEmployee.js";
import { syncDashboardAction } from "../../utils/syncDashboard.js";
import { resolveProfileActivationSubmitterId } from "../../utils/resolveProfileActivationSubmitterId.js";
import { clearProfileActivationHoldDashboardRows } from "../../utils/clearProfileActivationHoldDashboardRows.js";

/** Subdocument id fallback must match frontend (String(entry._id || index)). */
const pendingEntryId = (entry, idx) => String(entry?._id ?? idx);

export const sendApprovalEmail = async (req, res) => {
    const { id } = req.params;
    const { reason, description, attachment, attachmentName } = req.body || {};
    const selectionProvided = req.body?.selectionProvided === true;
    const includedChangeEntryIds = Array.isArray(req.body?.includedChangeEntryIds)
        ? req.body.includedChangeEntryIds.map(String)
        : null;

    try {
        const employeeBasic = await getCompleteEmployee(id);
        if (!employeeBasic) {
            return res.status(404).json({ message: "Employee not found" });
        }
        if (!employeeBasic.companyEmail || !String(employeeBasic.companyEmail).trim()) {
            return res.status(400).json({
                message: "Employee company email is required. First add company email address."
            });
        }

        const submitterEmployeeId = await resolveProfileActivationSubmitterId(req);
        if (!submitterEmployeeId) {
            return res.status(400).json({
                message:
                    "Your portal login must be linked to an Employee record before you can send activation to HR. Check user → employee mapping or employee ID on your account.",
            });
        }

        const reasonText = reason && String(reason).trim() ? String(reason).trim() : "";
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

        const eb = await EmployeeBasic.findById(employeeBasic._id);
        if (!eb) {
            return res.status(404).json({ message: "Employee not found" });
        }

        if (selectionProvided) {
            if (includedChangeEntryIds === null) {
                return res.status(400).json({
                    message: "includedChangeEntryIds array is required when selectionProvided is true.",
                });
            }
            const pending = Array.isArray(eb.pendingReactivationChanges) ? [...eb.pendingReactivationChanges] : [];
            const allSet = new Set(pending.map((entry, idx) => pendingEntryId(entry, idx)));
            for (const wid of includedChangeEntryIds) {
                if (!allSet.has(wid)) {
                    return res.status(400).json({
                        message: `Change entry id is not in the pending queue: ${wid}`,
                    });
                }
            }
            const keep = new Set(includedChangeEntryIds);
            eb.pendingReactivationChanges = pending.filter((entry, idx) => keep.has(pendingEntryId(entry, idx)));
            eb.markModified("pendingReactivationChanges");
        }

        const employeeName = `${employeeBasic.firstName || ""} ${employeeBasic.lastName || ""}`.trim() || "Employee";
        const hrName = `${hrEmployee.firstName || ""} ${hrEmployee.lastName || ""}`.trim() || "HR";
        const wasPreviouslyActive = Array.isArray(employeeBasic.profileWorkflow)
            ? employeeBasic.profileWorkflow.some((w) => String(w?.status || "").toLowerCase() === "active")
            : false;
        const activationTypeLabel = wasPreviouslyActive ? "Reactivation" : "New Activation";
        const typeForDisplay = wasPreviouslyActive ? "Reactivation (Resubmission)" : "New Activation";
        const pendingCards = Array.isArray(eb.pendingReactivationChanges)
            ? [...new Set(eb.pendingReactivationChanges.map((x) => String(x?.card || "").trim()).filter(Boolean))]
            : [];
        const pendingCardsHtml = pendingCards.length
            ? `<p style="margin: 8px 0 0 0;"><strong>Requested Changes:</strong><br/>${pendingCards.map((c) => `- ${c}`).join("<br/>")}</p>`
            : "";
        const pendingCardsText = pendingCards.length ? ` | Requested Changes: ${pendingCards.join(", ")}` : "";
        const subject = `${typeForDisplay} request: ${employeeName}`;

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
                    <p>The following employee is requesting <strong>${typeForDisplay}</strong>. As the <strong>HR</strong> contact assigned in the company Flowchart, please review and grant approval if everything is in order.</p>
                    
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
                        <p style="margin: 0;"><strong>Type:</strong> ${typeForDisplay}</p>
                        ${reasonText ? `<p style="margin: 8px 0 0 0;"><strong>Reason:</strong> ${reasonText}</p>` : ""}
                        ${descriptionText ? `<p style="margin: 8px 0 0 0;"><strong>Description:</strong><br/>${descriptionText.replace(/\n/g, '<br/>')}</p>` : ""}
                        ${pendingCardsHtml}
                        ${attachmentText ? `<p style="margin: 8px 0 0 0;"><strong>Attachment:</strong> <a href="${attachmentText}" target="_blank" rel="noopener noreferrer">${attachmentNameText || 'View attachment'}</a></p>` : ''}
                    </div>
                </div>
            </div>
        `;

        console.log(`[sendApprovalEmail] To (HR): ${hrEmail}`);
        await transporter.sendMail({
            from: `"VeRP Portal" <${emailUser}>`,
            to: hrEmail,
            subject,
            html,
        });

        eb.profileApprovalStatus = "submitted";
        eb.profileSubmittedTo = hrEmployee._id;
        eb.profileActivationSubmittedBy = submitterEmployeeId;
        eb.profileActivationHold = undefined;
        if (!Array.isArray(eb.profileWorkflow)) eb.profileWorkflow = [];
        eb.profileWorkflow.push({
            role: "HR",
            assignedTo: hrEmployee._id,
            status: "submitted",
            assignedAt: new Date(),
            comment: `Type: ${activationTypeLabel}${reasonText ? ` | Reason: ${reasonText}` : ""}${descriptionText ? ` | Description: ${descriptionText}` : ""}${pendingCards.length ? ` | Requested Changes: ${pendingCards.join(", ")}` : ""}${attachmentText ? ` | Attachment: ${attachmentText}` : ""}`,
            reason: reasonText,
            description: descriptionText,
            attachment: attachmentText || "",
            attachmentName: attachmentNameText,
        });
        eb.markModified("profileWorkflow");
        await eb.save();
        await EmployeeBasic.updateOne({ _id: eb._id }, { $unset: { profileActivationHold: "" } });

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
            extra1: `[Employee profile] ${activationTypeLabel}${reasonText ? ` — ${reasonText}` : ""}${pendingCardsText}`,
            extra2: employeeBasic.designation || "",
            extra3: JSON.stringify({ activationSubject: "employee", activationViewerRole: "hr" }),
        });

        await clearProfileActivationHoldDashboardRows(employeeBasic._id);

        return res.status(200).json({
            message: "Approval request sent successfully.",
            notified: {
                hrEmail,
                ccEmails: [],
            },
        });
    } catch (error) {
        console.error("Failed to send approval email:", error);
        return res.status(500).json({ message: error.message || "Failed to send approval email." });
    }
};
