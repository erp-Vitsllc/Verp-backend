import nodemailer from "nodemailer";
import Company from "../models/Company.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import { resolveFlowchartHrEmployee } from "./resolveFlowchartHrEmployee.js";
import { syncDashboardAction } from "./syncDashboard.js";
import { shortenUrlsInString } from "./shortenUrlsInString.js";

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

const getActorCcEmails = async (actor, excludeLowerEmails = new Set()) => {
    if (!actor?.employeeObjectId) return [];
    const emp = await EmployeeBasic.findById(actor.employeeObjectId)
        .select("companyEmail")
        .lean();
    if (!emp) return [];
    const raw = [emp.companyEmail];
    return dedupeEmailList(raw).filter((e) => !excludeLowerEmails.has(e.toLowerCase()));
};

const hasValue = (v) => !(v === undefined || v === null || (typeof v === "string" && v.trim() === ""));
const hasAttachment = (v) => hasValue(v);

const hasMoaDocument = (company = {}) => {
    const docs = Array.isArray(company.documents) ? company.documents : [];
    return docs.some((d) => {
        const t = String(d?.type || "").toLowerCase();
        const looksLikeMoa = t.includes("moa");
        const docUrl = d?.document?.url;
        return looksLikeMoa && hasValue(docUrl);
    });
};

export const calculateCompanyActivationProgress = (company = {}) => {
    const checks = [
        {
            key: "basicDetails",
            label: "Basic details",
            completed: [
                company.name,
                company.nickName,
                company.companyId,
                company.email,
                company.phone,
                company.establishedDate,
            ].every(hasValue),
        },
        {
            key: "tradeLicense",
            label: "Trade License",
            completed: [
                company.tradeLicenseNumber,
                company.tradeLicenseIssueDate,
                company.tradeLicenseExpiry,
            ].every(hasValue) && hasAttachment(company.tradeLicenseAttachment),
        },
        {
            key: "establishmentCard",
            label: "Establishment Card Details",
            completed: [
                company.establishmentCardNumber,
                company.establishmentCardExpiry,
            ].every(hasValue) && hasAttachment(company.establishmentCardAttachment),
        },
        {
            key: "moa",
            label: "MOA",
            completed: hasMoaDocument(company),
        },
    ];

    const completed = checks.filter((c) => c.completed).length;
    const total = checks.length;
    const percentage = Math.round((completed / total) * 100);
    const missing = checks.filter((c) => !c.completed).map((c) => c.label);

    return { checks, completed, total, percentage, missing };
};

const sendCompanyActivationEmailToHr = async ({
    company,
    hrEmail,
    hrName,
    requestedByName,
    reason,
    description = "",
    attachment = "",
    attachmentName = "",
    ccEmails = [],
    activationTypeLabel = "New Activation",
    requestedChanges = [],
}) => {
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
    const companyUrl = `${baseUrl}/Company/${company._id}`;
    const subject = `${activationTypeLabel} request: ${company.name}`;

    const reasonHtml = shortenUrlsInString(reason || "Activation request");
    const descriptionHtml = shortenUrlsInString(description || "");
    const attachmentUrl = attachment ? String(attachment).trim() : "";
    const attachmentLabel =
        attachmentName ||
        shortenUrlsInString(attachmentUrl) ||
        "View attachment";

    const changesHtml = Array.isArray(requestedChanges) && requestedChanges.length
        ? `<p style="margin:6px 0 0;"><strong>Requested Changes:</strong><br/>${requestedChanges.map((c) => `- ${c}`).join("<br/>")}</p>`
        : "";

    const html = `
        <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 640px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
            <div style="background:#1d4ed8;color:#fff;padding:18px 22px;">
                <h2 style="margin:0;">Company Activation Request</h2>
            </div>
            <div style="padding:22px;">
                <p>Hello <strong>${hrName}</strong>,</p>
                <p>A company has been submitted for <strong>${activationTypeLabel.toLowerCase()}</strong> and requires HR authorization.</p>
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin:16px 0;">
                    <p style="margin:0;"><strong>Company:</strong> ${company.name || "N/A"}</p>
                    <p style="margin:6px 0 0;"><strong>Company ID:</strong> ${company.companyId || "N/A"}</p>
                    <p style="margin:6px 0 0;"><strong>Type:</strong> ${activationTypeLabel}</p>
                    <p style="margin:6px 0 0;"><strong>Requested by:</strong> ${requestedByName || "System"}</p>
                    <p style="margin:6px 0 0;"><strong>Reason:</strong> ${reasonHtml}</p>
                    ${descriptionHtml ? `<p style="margin:6px 0 0;"><strong>Edited Details:</strong> ${descriptionHtml}</p>` : ""}
                    ${changesHtml}
                    ${attachmentUrl ? `<p style="margin:6px 0 0;"><strong>Attachment:</strong> <a href="${attachmentUrl}" target="_blank" rel="noopener noreferrer">${attachmentLabel}</a></p>` : ""}
                </div>
                <p style="margin-top:20px;">
                    <a href="${companyUrl}" style="background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600;display:inline-block;">Review Company</a>
                </p>
            </div>
        </div>
    `;

    const hrLower = (hrEmail || "").trim().toLowerCase();
    const exclude = new Set([hrLower]);
    const cc = dedupeEmailList(ccEmails).filter((e) => !exclude.has(e.toLowerCase()));

    await transporter.sendMail({
        from: `"VeRP Portal" <${emailUser}>`,
        to: hrEmail,
        ...(cc.length ? { cc: cc.join(", ") } : {}),
        subject,
        html,
    });
};

const getActorName = (actor = {}) => {
    if (actor?.name) return String(actor.name).trim();
    const full = `${actor?.firstName || ""} ${actor?.lastName || ""}`.trim();
    return full || actor?.employeeId || "System";
};

export const submitCompanyActivation = async ({
    companyId,
    actor = null,
    reason = "Company submitted for activation",
    workflowComment = "",
    description = "",
    attachment = "",
    attachmentName = "",
    /** Shorter text for dashboard / notifications (full URL kept only in `reason` / workflow when provided). */
    dashboardSummary = null,
    force = false,
}) => {
    const company = await Company.findById(companyId);
    if (!company) return { ok: false, message: "Company not found" };

    const progress = calculateCompanyActivationProgress(company.toObject());
    if (!force && progress.percentage < 100) {
        return {
            ok: false,
            blocked: true,
            message: "Company profile is not 100% complete for activation.",
            progress,
        };
    }

    const hrResolved = await resolveFlowchartHrEmployee();
    if (hrResolved.error) {
        return { ok: false, message: hrResolved.message, code: hrResolved.error };
    }

    const hr = hrResolved.employee;
    const requestedByName = getActorName(actor);
    const wasPreviouslyActive = Array.isArray(company.activationWorkflow)
        ? company.activationWorkflow.some((w) => String(w?.status || "").toLowerCase() === "active")
        : false;
    const activationTypeLabel = wasPreviouslyActive ? "Reactivation" : "New Activation";
    const requestedChanges = Array.isArray(company.pendingReactivationChanges)
        ? [...new Set(company.pendingReactivationChanges.map((x) => String(x?.card || "").trim()).filter(Boolean))]
        : [];
    const extra1ForDashboard = dashboardSummary != null
        ? `${activationTypeLabel} | ${dashboardSummary}${requestedChanges.length ? ` | Requested Changes: ${requestedChanges.join(", ")}` : ""}`
        : `${activationTypeLabel} | ${reason}${requestedChanges.length ? ` | Requested Changes: ${requestedChanges.join(", ")}` : ""}`;

    company.status = "Inactive";
    company.activationStatus = "submitted";
    company.activationSubmittedTo = hr._id;
    company.activationHold = undefined;
    if (!Array.isArray(company.activationWorkflow)) company.activationWorkflow = [];
    company.activationWorkflow.push({
        role: "HR",
        assignedTo: hr._id,
        status: "submitted",
        assignedAt: new Date(),
        comment: workflowComment || reason,
        reason: `Type: ${activationTypeLabel}${reason ? ` | ${reason}` : ""}`,
        description: `${description || ""}${requestedChanges.length ? `${description ? " | " : ""}Requested Changes: ${requestedChanges.join(", ")}` : ""}`,
        attachment: attachment || "",
        attachmentName: attachmentName || "",
    });
    await company.save();

    await syncDashboardAction({
        requestId: company._id,
        requestType: "Company Activation",
        assignedTo: String(hr._id),
        status: "Pending",
        subjectEmployee: {
            employeeId: company.companyId,
            firstName: company.name,
            lastName: "",
            designation: company.nickName || "",
        },
        requestedByName,
        extra1: `[Company profile] ${extra1ForDashboard}`,
        extra2: company.companyId || "",
        extra3: JSON.stringify({
            companyActivationViewerRole: "approver",
            activationSubject: "company",
        }),
    });

    if (actor?.employeeObjectId || actor?._id) {
        await syncDashboardAction({
            requestId: company._id,
            requestType: "Company Activation",
            assignedTo: String(actor.employeeObjectId || actor._id),
            status: "Pending",
            subjectEmployee: {
                employeeId: company.companyId,
                firstName: company.name,
                lastName: "",
                designation: company.nickName || "",
            },
            requestedByName,
            extra1: `[Company profile] ${extra1ForDashboard}`,
            extra2: company.companyId || "",
            extra3: JSON.stringify({
                companyActivationViewerRole: "requester",
                activationSubject: "company",
            }),
        });
    }

    try {
        const hrName = `${hr.firstName || ""} ${hr.lastName || ""}`.trim() || "HR";
        const hrMailLower = (hrResolved.email || "").trim().toLowerCase();
        const actorCc = await getActorCcEmails(actor, new Set(hrMailLower ? [hrMailLower] : []));
        await sendCompanyActivationEmailToHr({
            company,
            hrEmail: hrResolved.email,
            hrName,
            requestedByName,
            reason,
            description,
            attachment,
            attachmentName,
            ccEmails: actorCc,
            activationTypeLabel,
            requestedChanges,
        });
    } catch (e) {
        console.error("[submitCompanyActivation] Email failed:", e?.message || e);
    }

    return { ok: true, progress };
};

export const shouldTriggerCompanyReactivation = (beforeCompany = {}, updateData = {}) => {
    if (String(beforeCompany?.status || "").toLowerCase() !== "active") return false;

    // Critical sections that require reactivation when changed after activation
    const hasTradeLicenseChange = [
        "tradeLicenseNumber",
        "tradeLicenseIssueDate",
        "tradeLicenseExpiry",
        "tradeLicenseAttachment",
    ].some((k) => Object.prototype.hasOwnProperty.call(updateData, k));

    const hasEstablishmentCardChange = [
        "establishmentCardNumber",
        "establishmentCardIssueDate",
        "establishmentCardExpiry",
        "establishmentCardAttachment",
    ].some((k) => Object.prototype.hasOwnProperty.call(updateData, k));

    const hasBasicDetailsChange = [
        "name", "nickName", "email", "phone", "establishedDate"
    ].some((k) => Object.prototype.hasOwnProperty.call(updateData, k));

    const hasMoaChange = Array.isArray(updateData.documents) && updateData.documents.some((d) => {
        const t = String(d?.type || "").toLowerCase();
        return t.includes("moa");
    });

    return hasBasicDetailsChange || hasTradeLicenseChange || hasEstablishmentCardChange || hasMoaChange;
};
