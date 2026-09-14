import nodemailer from "nodemailer";
import mongoose from "mongoose";
import { resolveFrontendBaseUrl, emailFrontendUrl } from '../../utils/resolveFrontendBaseUrl.js';
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveFlowchartHrEmployee } from "../../utils/resolveFlowchartHrEmployee.js";
import { syncDashboardAction } from "../../utils/syncDashboard.js";
import { resolveProfileActivationSubmitterId } from "../../utils/resolveProfileActivationSubmitterId.js";
import { clearProfileActivationHoldDashboardRows } from "../../utils/clearProfileActivationHoldDashboardRows.js";
import { buildEmailAttachmentsFromRef } from "../../utils/emailAccessibleFiles.js";
import { formatActivationAttachmentLine } from "../../utils/shortenUrlsInString.js";
import {
    buildEmployeeActivationHrEmailHtml,
    buildEmployeeActivationHrEmailSubject,
    renderEmailAttachmentLineHtml,
} from "../../utils/buildEmployeeActivationHrEmail.js";
import {
    buildProfileActivationEntityLine,
    buildProfileActivationPendingMessage,
    employeeProfileDisplayName,
} from "../../utils/employeeProfileNotificationMessages.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { resolveFrontendHostLabel } from "../../utils/resolveFrontendBaseUrl.js";
import User from "../../models/User.js";
import {
    accessControlSetFromPendingEntry,
    isAccessControlOnlyPendingEntry,
    normalizeLoginThrough,
} from "../../utils/loginThrough.js";

/** Subdocument id fallback must match frontend (String(entry._id || index)). */
const pendingEntryId = (entry, idx) => String(entry?._id ?? idx);

async function loadEmployeeForActivationSubmit(id) {
    const query =
        typeof id === "string" && mongoose.Types.ObjectId.isValid(id) && id.length === 24
            ? { _id: id }
            : { employeeId: id };
    return EmployeeBasic.findOne(query)
        .select(
            "firstName lastName employeeId profileStatus profileWorkflow pendingReactivationChanges profileApprovalStatus profileSubmittedTo enablePortalAccess loginThrough",
        )
        .lean();
}

export const sendApprovalEmail = async (req, res) => {
    const { id } = req.params;
    const { reason, description, attachment, attachmentName } = req.body || {};
    const selectionProvided = req.body?.selectionProvided === true;
    const includedChangeEntryIds = Array.isArray(req.body?.includedChangeEntryIds)
        ? req.body.includedChangeEntryIds.map(String)
        : null;

    try {
        const employeeBasic = await loadEmployeeForActivationSubmit(id);
        if (!employeeBasic) {
            return res.status(404).json({ message: "Employee not found" });
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

        const pendingForAccess = Array.isArray(employeeBasic.pendingReactivationChanges)
            ? [...employeeBasic.pendingReactivationChanges]
            : [];
        let selectedForAccess = pendingForAccess;
        if (selectionProvided) {
            if (includedChangeEntryIds === null) {
                return res.status(400).json({
                    message: "includedChangeEntryIds array is required when selectionProvided is true.",
                });
            }
            const allSet = new Set(pendingForAccess.map((entry, idx) => pendingEntryId(entry, idx)));
            for (const wid of includedChangeEntryIds) {
                if (!allSet.has(wid)) {
                    return res.status(400).json({
                        message: `Change entry id is not in the pending queue: ${wid}`,
                    });
                }
            }
            if (pendingForAccess.length > 0 && includedChangeEntryIds.length === 0) {
                return res.status(400).json({
                    message: "Select at least one requested change to submit.",
                });
            }
            const keep = new Set(includedChangeEntryIds.map(String));
            selectedForAccess = pendingForAccess.filter((entry, idx) => keep.has(pendingEntryId(entry, idx)));
        }
        const earlyAccessOnly = selectedForAccess.filter((entry) => isAccessControlOnlyPendingEntry(entry));
        const earlyRemaining = selectedForAccess.filter((entry) => !isAccessControlOnlyPendingEntry(entry));
        if (earlyAccessOnly.length > 0 && earlyRemaining.length === 0) {
            const liveSet = {};
            for (const change of earlyAccessOnly) {
                Object.assign(liveSet, accessControlSetFromPendingEntry(change));
            }
            if (Object.keys(liveSet).length > 0) {
                await EmployeeBasic.updateOne({ _id: employeeBasic._id }, { $set: liveSet });
                if (typeof liveSet.enablePortalAccess === "boolean") {
                    await User.findOneAndUpdate(
                        { employeeId: employeeBasic.employeeId },
                        { $set: { enablePortalAccess: liveSet.enablePortalAccess } },
                    );
                }
            }
            const pullIds = earlyAccessOnly.map((entry) => entry?._id).filter(Boolean);
            if (pullIds.length > 0) {
                await EmployeeBasic.updateOne(
                    { _id: employeeBasic._id },
                    { $pull: { pendingReactivationChanges: { _id: { $in: pullIds } } } },
                );
            }
            return res.status(200).json({
                message: "Access settings applied.",
                appliedLive: true,
                employee: {
                    loginThrough: liveSet.loginThrough || normalizeLoginThrough(employeeBasic),
                    enablePortalAccess:
                        liveSet.enablePortalAccess !== undefined
                            ? liveSet.enablePortalAccess
                            : employeeBasic.enablePortalAccess,
                },
            });
        }

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

        const eb = await EmployeeBasic.findById(employeeBasic._id)
            .select(
                "firstName lastName employeeId profileStatus profileWorkflow pendingReactivationChanges profileApprovalStatus enablePortalAccess loginThrough",
            )
            .lean();
        if (!eb) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const pending = Array.isArray(eb.pendingReactivationChanges) ? [...eb.pendingReactivationChanges] : [];
        const wasPreviouslyActive = Array.isArray(employeeBasic.profileWorkflow)
            ? employeeBasic.profileWorkflow.some((w) => String(w?.status || "").toLowerCase() === "active")
            : false;
        const profileAlreadyLive =
            String(employeeBasic.profileStatus || "").toLowerCase() === "active" ||
            wasPreviouslyActive;
        if (profileAlreadyLive && pending.length === 0) {
            return res.status(400).json({
                message: "No pending changes to submit. The activation queue is empty.",
            });
        }

        let submittingThisRequest = pending;
        if (selectionProvided) {
            if (includedChangeEntryIds === null) {
                return res.status(400).json({
                    message: "includedChangeEntryIds array is required when selectionProvided is true.",
                });
            }
            const allSet = new Set(pending.map((entry, idx) => pendingEntryId(entry, idx)));
            for (const wid of includedChangeEntryIds) {
                if (!allSet.has(wid)) {
                    return res.status(400).json({
                        message: `Change entry id is not in the pending queue: ${wid}`,
                    });
                }
            }
            if (pending.length > 0 && includedChangeEntryIds.length === 0) {
                return res.status(400).json({
                    message: "Select at least one requested change to submit.",
                });
            }
            const keep = new Set(includedChangeEntryIds.map(String));
            submittingThisRequest = pending.filter((entry, idx) => keep.has(pendingEntryId(entry, idx)));
            // Keep full queue — unchecked rows stay until a later submission (matches Company).
        }

        const accessOnlyChanges = submittingThisRequest.filter((entry) => isAccessControlOnlyPendingEntry(entry));
        const remainingForHr = submittingThisRequest.filter((entry) => !isAccessControlOnlyPendingEntry(entry));
        if (accessOnlyChanges.length > 0) {
            const liveSet = {};
            for (const change of accessOnlyChanges) {
                Object.assign(liveSet, accessControlSetFromPendingEntry(change));
            }
            if (Object.keys(liveSet).length > 0) {
                await EmployeeBasic.updateOne({ _id: eb._id }, { $set: liveSet });
                if (typeof liveSet.enablePortalAccess === "boolean") {
                    await User.findOneAndUpdate(
                        { employeeId: employeeBasic.employeeId },
                        { $set: { enablePortalAccess: liveSet.enablePortalAccess } },
                    );
                }
            }
            const pullIds = accessOnlyChanges.map((entry) => entry?._id).filter(Boolean);
            if (pullIds.length > 0) {
                await EmployeeBasic.updateOne(
                    { _id: eb._id },
                    { $pull: { pendingReactivationChanges: { _id: { $in: pullIds } } } },
                );
            }
            if (remainingForHr.length === 0) {
                return res.status(200).json({
                    message: "Access settings applied.",
                    appliedLive: true,
                    employee: {
                        loginThrough: liveSet.loginThrough || normalizeLoginThrough(eb),
                        enablePortalAccess:
                            liveSet.enablePortalAccess !== undefined
                                ? liveSet.enablePortalAccess
                                : eb.enablePortalAccess,
                    },
                });
            }
            submittingThisRequest = remainingForHr;
        }

        const employeeName = `${employeeBasic.firstName || ""} ${employeeBasic.lastName || ""}`.trim() || "Employee";
        const hrName = `${hrEmployee.firstName || ""} ${hrEmployee.lastName || ""}`.trim() || "HR";
        const submitterName =
            `${req.user?.firstName || ""} ${req.user?.lastName || ""}`.trim() ||
            req.user?.name ||
            "VeRP Portal";
        const activationTypeLabel = wasPreviouslyActive ? "Reactivation" : "New Activation";
        const typeForDisplay = wasPreviouslyActive ? "Reactivation (Resubmission)" : "New Activation";
        const pendingCards = [...new Set(submittingThisRequest.map((x) => String(x?.card || "").trim()).filter(Boolean))];
        const workflowDescription = `${descriptionText || "Submitted for activation review"}${pendingCards.length ? `${descriptionText ? " | " : ""}Requested Changes: ${pendingCards.join(", ")}` : ""}`;
        const pendingCardsText = pendingCards.length ? ` | Requested Changes: ${pendingCards.join(", ")}` : "";
        const isAdminSubmitter = await isReqUserAdmin(req.user);
        const submitterDisplayName =
            submitterName && submitterName !== "VeRP Portal"
                ? `${submitterName}${isAdminSubmitter ? " (Administrator)" : ""}`
                : isAdminSubmitter
                  ? "Administrator"
                  : "VeRP Portal";

        const baseUrl = resolveFrontendBaseUrl(req);
        const profileUrl = `${baseUrl}/emp/${employeeBasic.employeeId}`;
        const siteHost = resolveFrontendHostLabel(req);
        const subject = buildEmployeeActivationHrEmailSubject({
            employeeName,
            typeForDisplay,
            isAdminSubmitter,
        });
        const emailAttachments = attachmentText
            ? await buildEmailAttachmentsFromRef(attachmentText, attachmentNameText)
            : [];
        const attachmentHtml = attachmentText
            ? renderEmailAttachmentLineHtml(
                  attachmentNameText ||
                      formatActivationAttachmentLine(attachmentText, attachmentNameText)?.replace(/^Attachment:\s*/i, "") ||
                      "Attachment",
                  { attached: emailAttachments.length > 0 },
              )
            : "";

        const html = buildEmployeeActivationHrEmailHtml({
            hrName,
            employeeName,
            employeeId: employeeBasic.employeeId,
            profileUrl,
            typeForDisplay,
            submitterName: submitterDisplayName,
            isAdminSubmitter,
            reason: reasonText,
            description: descriptionText,
            pendingChanges: submittingThisRequest,
            attachmentHtml,
            siteHost,
        });

        const workflowEntry = {
            role: "HR",
            assignedTo: hrEmployee._id,
            status: "submitted",
            assignedAt: new Date(),
            comment: `Type: ${activationTypeLabel}${reasonText ? ` | Reason: ${reasonText}` : ""}${descriptionText ? ` | Description: ${descriptionText}` : ""}${pendingCards.length ? ` | Requested Changes: ${pendingCards.join(", ")}` : ""}${attachmentText ? ` | Attachment: ${attachmentText}` : ""}`,
            reason: reasonText || "Employee profile submitted for activation",
            description: workflowDescription,
            attachment: attachmentText || "",
            attachmentName: attachmentNameText,
        };
        await EmployeeBasic.updateOne(
            { _id: eb._id },
            {
                $set: {
                    profileApprovalStatus: "submitted",
                    profileSubmittedTo: hrEmployee._id,
                    profileActivationSubmittedBy: submitterEmployeeId,
                },
                $unset: { profileActivationHold: "", profileActivationDraftEditor: "" },
                $push: { profileWorkflow: workflowEntry },
            },
        );

        const subjectForDashboard = await EmployeeBasic.findById(employeeBasic._id)
            .select("firstName lastName employeeId designation department")
            .lean();

        const requestedByName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(" ").trim() ||
            "";

        const dashboardEmployeeName = employeeProfileDisplayName(subjectForDashboard || employeeBasic);
        const activationExtra1 = buildProfileActivationPendingMessage({
            employeeName: dashboardEmployeeName,
            employeeId: employeeBasic.employeeId,
            activationType: activationTypeLabel,
            submittedBy: submitterDisplayName,
            pendingCards,
            reason: reasonText,
        });

        await syncDashboardAction({
            requestId: employeeBasic._id,
            requestType: "Profile Activation",
            assignedTo: String(hrEmployee._id),
            status: "Pending",
            subjectEmployee: subjectForDashboard || employeeBasic,
            requestedByName,
            extra1: activationExtra1,
            extra2: buildProfileActivationEntityLine(dashboardEmployeeName, employeeBasic.employeeId),
            extra3: JSON.stringify({ activationSubject: "employee", activationViewerRole: "hr" }),
        });

        await clearProfileActivationHoldDashboardRows(employeeBasic._id);

        res.status(200).json({
            message: "Approval request sent successfully.",
            notified: {
                hrEmail,
                ccEmails: [],
            },
        });

        void (async () => {
            try {
                console.log(`[sendApprovalEmail] To (HR): ${hrEmail}`);
                await transporter.sendMail({
                    fromName: submitterName,
                    to: hrEmail,
                    subject,
                    html,
                    ...(emailAttachments.length ? { attachments: emailAttachments } : {}),
                });
            } catch (mailErr) {
                console.error("Failed to send activation approval email (background):", mailErr);
            }
        })();
    } catch (error) {
        console.error("Failed to send approval email:", error);
        return res.status(500).json({ message: error.message || "Failed to send approval email." });
    }
};
