import nodemailer from "nodemailer";
import Company from "../models/Company.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import { isActorDesignatedFlowchartHr } from "./isDesignatedFlowchartHr.js";
import { resolveFlowchartHrEmployee } from "./resolveFlowchartHrEmployee.js";
import { syncDashboardAction } from "./syncDashboard.js";
import { clearCompanyActivationHoldDashboardRows } from "./clearCompanyActivationHoldDashboardRows.js";
import { shortenUrlsInString } from "./shortenUrlsInString.js";

const hasValue = (v) => !(v === undefined || v === null || (typeof v === "string" && v.trim() === ""));
const hasAttachment = (v) => hasValue(v);

const isArchivedCompanyDocumentRow = (d) => {
    if (!d || typeof d !== "object") return false;
    const t = String(d?.type || "").toLowerCase();
    const desc = String(d?.description || "").toLowerCase();
    if (t.includes("previous")) return true;
    if (desc.includes("not renewed")) return true;
    if (d?.archivedAt) return true;
    if (String(d?.archiveReason || "").toLowerCase().includes("not renew")) return true;
    return false;
};

/** MOA row: explicit context (Add MOA flow) or legacy type match. */
const documentIsMoaForActivation = (d) => {
    if (!d || typeof d !== "object") return false;
    const ctx = String(d?.context || "").toLowerCase();
    if (ctx === "moa") return true;
    const t = String(d?.type || "").toLowerCase();
    return t.includes("moa");
};

/** Live MOA only — archived / not-renew rows in `oldDocuments` do not satisfy activation. */
const hasMoaDocument = (company = {}) => {
    const docs = Array.isArray(company.documents) ? company.documents : [];
    return docs.some((d) => {
        if (isArchivedCompanyDocumentRow(d)) return false;
        const docUrl = d?.document?.url;
        if (!hasValue(docUrl)) return false;
        return documentIsMoaForActivation(d);
    });
};

/** Same keys as activation progress checks — overlay queued HR proposals onto the snapshot. */
const ACTIVATION_PROGRESS_OVERLAY_KEYS = [
    "name",
    "nickName",
    "companyId",
    "email",
    "phone",
    "establishedDate",
    "tradeLicenseNumber",
    "tradeLicenseIssueDate",
    "tradeLicenseExpiry",
    "tradeLicenseAttachment",
    "establishmentCardNumber",
    "establishmentCardIssueDate",
    "establishmentCardExpiry",
    "establishmentCardAttachment",
    "documents",
];

const overlayProposedFieldsForActivation = (base, proposed) => {
    if (!proposed || typeof proposed !== "object") return base;
    const out = { ...base };
    for (const k of ACTIVATION_PROGRESS_OVERLAY_KEYS) {
        if (Object.prototype.hasOwnProperty.call(proposed, k)) {
            out[k] = proposed[k];
        }
    }
    return out;
};

export const mergePendingReactivationForActivationSnapshot = (company = {}) => {
    const co = typeof company.toObject === "function" ? company.toObject() : { ...company };
    const pending = Array.isArray(co.pendingReactivationChanges) ? co.pendingReactivationChanges : [];
    let merged = { ...co };
    for (const entry of pending) {
        merged = overlayProposedFieldsForActivation(merged, entry?.proposedData);
    }
    return merged;
};

export const calculateCompanyActivationProgress = (company = {}) => {
    const co = mergePendingReactivationForActivationSnapshot(company);
    const checks = [
        {
            key: "basicDetails",
            label: "Basic details",
            completed: [
                co.name,
                co.nickName,
                co.companyId,
                co.email,
                co.phone,
                co.establishedDate,
            ].every(hasValue),
        },
        {
            key: "tradeLicense",
            label: "Trade License",
            completed: [
                co.tradeLicenseNumber,
                co.tradeLicenseIssueDate,
                co.tradeLicenseExpiry,
            ].every(hasValue) && hasAttachment(co.tradeLicenseAttachment),
        },
        {
            key: "establishmentCard",
            label: "Establishment Card Details",
            completed: [
                co.establishmentCardNumber,
                co.establishmentCardExpiry,
            ].every(hasValue) && hasAttachment(co.establishmentCardAttachment),
        },
        {
            key: "moa",
            label: "MOA",
            completed: hasMoaDocument(co),
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
    const isResubmission = String(activationTypeLabel).toLowerCase() === "reactivation";
    const typeForDisplay = isResubmission ? "Reactivation (Resubmission)" : "New Activation";
    const subject = `${typeForDisplay} request: ${company.name}`;

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
                <p>A company profile has been submitted for <strong>${typeForDisplay}</strong> and requires HR authorization.</p>
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin:16px 0;">
                    <p style="margin:0;"><strong>Company:</strong> ${company.name || "N/A"}</p>
                    <p style="margin:6px 0 0;"><strong>Company ID:</strong> ${company.companyId || "N/A"}</p>
                    <p style="margin:6px 0 0;"><strong>Type:</strong> ${typeForDisplay}</p>
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

    await transporter.sendMail({
        from: `"VeRP Portal" <${emailUser}>`,
        to: hrEmail,
        subject,
        html,
    });
};

const getActorName = (actor = {}) => {
    if (actor?.name) return String(actor.name).trim();
    const full = `${actor?.firstName || ""} ${actor?.lastName || ""}`.trim();
    return full || actor?.employeeId || "System";
};

/** Resolves `actor.employeeObjectId` or `actor._id` (User) to EmployeeBasic `_id` for DashboardAction.assignedTo. */
const resolveActorDashboardEmployeeBasicId = async (actor) => {
    if (!actor?.employeeObjectId && !actor?._id) return null;
    const rawId = actor.employeeObjectId || actor._id;
    const sid = String(rawId);
    let emp = await EmployeeBasic.findById(sid).select("_id").lean();
    if (emp?._id) return emp._id;
    if (!/^[0-9a-fA-F]{24}$/.test(sid)) return null;
    const User = (await import("../models/User.js")).default;
    const user = await User.findById(sid).select("employeeId").lean();
    if (!user?.employeeId) return null;
    emp = await EmployeeBasic.findOne({ employeeId: user.employeeId }).select("_id").lean();
    return emp?._id || null;
};

const companyPendingEntryId = (entry, idx) => String(entry?._id ?? idx);

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
    selectionProvided = false,
    includedChangeEntryIds = null,
}) => {
    const company = await Company.findById(companyId);
    if (!company) return { ok: false, message: "Company not found" };

    const progress = calculateCompanyActivationProgress(company.toObject());

    if (selectionProvided) {
        if (!Array.isArray(includedChangeEntryIds)) {
            return {
                ok: false,
                blocked: true,
                message: "includedChangeEntryIds array is required when selectionProvided is true.",
                progress,
            };
        }
        const pending = Array.isArray(company.pendingReactivationChanges) ? [...company.pendingReactivationChanges] : [];
        const allSet = new Set(pending.map((entry, idx) => companyPendingEntryId(entry, idx)));
        for (const wid of includedChangeEntryIds.map(String)) {
            if (!allSet.has(wid)) {
                return {
                    ok: false,
                    blocked: true,
                    message: `Change entry id is not in the pending queue: ${wid}`,
                    progress,
                };
            }
        }
        const keep = new Set(includedChangeEntryIds.map(String));
        company.pendingReactivationChanges = pending.filter((entry, idx) => keep.has(companyPendingEntryId(entry, idx)));
        company.markModified("pendingReactivationChanges");
    }
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
    if (isActorDesignatedFlowchartHr(actor, hr)) {
        return {
            ok: false,
            blocked: true,
            code: "HR_CANNOT_QUEUE_SELF_ACTIVATION",
            message:
                "The designated Flowchart HR cannot send an activation request to themselves. Activate the company directly instead.",
            progress,
        };
    }
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

    const resubmitAfterHold = Boolean(company.activationHold);

    company.status = "Inactive";
    company.activationStatus = "submitted";
    company.activationSubmittedTo = hr._id;
    company.activationSubmittedBy = actor?.employeeObjectId || null;
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

    await clearCompanyActivationHoldDashboardRows(company._id);

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
        if (resubmitAfterHold) {
            const actorEmpId = await resolveActorDashboardEmployeeBasicId(actor);
            if (actorEmpId) {
                const DashboardAction = (await import("../models/DashboardAction.js")).default;
                await DashboardAction.deleteMany({
                    requestId: company._id,
                    requestType: "Company Activation",
                    assignedTo: actorEmpId,
                    status: "Pending",
                });
            }
        } else {
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
    }

    try {
        const hrName = `${hr.firstName || ""} ${hr.lastName || ""}`.trim() || "HR";
        await sendCompanyActivationEmailToHr({
            company,
            hrEmail: hrResolved.email,
            hrName,
            requestedByName,
            reason,
            description,
            attachment,
            attachmentName,
            activationTypeLabel,
            requestedChanges,
        });
    } catch (e) {
        console.error("[submitCompanyActivation] Email failed:", e?.message || e);
    }

    return { ok: true, progress };
};

/**
 * Human-readable labels for which company "cards" an update touches (activation hold progress + queue card text).
 */
export const collectCompanyReactivationChangeLabels = (updateData = {}) => {
    const changes = [];
    const hasAny = (keys) => keys.some((k) => Object.prototype.hasOwnProperty.call(updateData, k));

    if (hasAny(["name", "nickName", "email", "phone", "establishedDate", "companyId"])) {
        changes.push("Basic Details");
    }
    if (
        hasAny([
            "tradeLicenseNumber",
            "tradeLicenseIssueDate",
            "tradeLicenseExpiry",
            "tradeLicenseAttachment",
            "tradeLicenseOwnerName",
            "owners",
        ])
    ) {
        changes.push("Trade License");
    }
    if (hasAny(["establishmentCardNumber", "establishmentCardIssueDate", "establishmentCardExpiry", "establishmentCardAttachment"])) {
        changes.push("Establishment Card");
    }
    if (Object.prototype.hasOwnProperty.call(updateData, "documents")) {
        const docs = Array.isArray(updateData.documents) ? updateData.documents : [];
        if (docs.some((d) => documentIsMoaForActivation(d))) {
            changes.push("MOA");
        }
    }
    if (Object.prototype.hasOwnProperty.call(updateData, "ejari")) {
        changes.push("Ejari");
    }
    if (Object.prototype.hasOwnProperty.call(updateData, "insurance")) {
        changes.push("Insurance");
    }

    return [...new Set(changes)];
};

/**
 * Remove given top-level keys from each queued `proposedData`. Drops entries that become empty
 * so admin hard-deletes (e.g. establishment card) are not resurrected by activation-progress merge.
 */
export const stripProposedDataKeysFromPendingReactivationEntries = (entries = [], keysToRemove = []) => {
    if (!Array.isArray(entries) || !Array.isArray(keysToRemove) || keysToRemove.length === 0) return Array.isArray(entries) ? [...entries] : [];
    const drop = new Set(keysToRemove);
    const out = [];
    for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        let pd;
        try {
            pd =
                entry.proposedData && typeof entry.proposedData === "object"
                    ? JSON.parse(JSON.stringify(entry.proposedData))
                    : null;
        } catch {
            out.push(entry);
            continue;
        }
        if (!pd) {
            out.push(entry);
            continue;
        }
        let touched = false;
        for (const k of drop) {
            if (Object.prototype.hasOwnProperty.call(pd, k)) {
                delete pd[k];
                touched = true;
            }
        }
        if (!touched) {
            out.push(entry);
            continue;
        }
        if (Object.keys(pd).length === 0) {
            continue;
        }
        const newLabels = collectCompanyReactivationChangeLabels(pd);
        const cardLabel = newLabels.length ? newLabels.join(", ") : "Company Profile";
        out.push({
            ...entry,
            proposedData: pd,
            card: cardLabel,
            reason: cardLabel,
        });
    }
    return out;
};

/** Compare only MOA rows so deleting e.g. "Document with expiry" does not queue reactivation just because MOA still exists in the payload. */
const serializeMoaDocumentsSlice = (documents) => {
    const list = Array.isArray(documents) ? documents : [];
    const moaRows = list.filter((d) => documentIsMoaForActivation(d));
    const iso = (v) => {
        if (v == null || v === "") return "";
        const d = v instanceof Date ? v : new Date(v);
        return Number.isNaN(d.getTime()) ? "" : d.toISOString();
    };
    const norm = (d) => ({
        id: d?._id != null ? String(d._id) : "",
        type: String(d?.type || ""),
        description: String(d?.description || ""),
        issueDate: iso(d?.issueDate),
        startDate: iso(d?.startDate),
        expiryDate: iso(d?.expiryDate),
        url: String(d?.document?.url || d?.attachment || "").split("?")[0],
    });
    try {
        return JSON.stringify(moaRows.map(norm).sort((a, b) => a.id.localeCompare(b.id)));
    } catch {
        return String(moaRows.length);
    }
};

export const shouldTriggerCompanyReactivation = (beforeCompany = {}, updateData = {}) => {
    const status = String(beforeCompany?.status || "").toLowerCase();
    const activationStatus = String(beforeCompany?.activationStatus || "").toLowerCase();
    const workflow = Array.isArray(beforeCompany?.activationWorkflow) ? beforeCompany.activationWorkflow : [];
    const hasEverBeenActive = workflow.some((w) => String(w?.status || "").toLowerCase() === "active");

    // Keep queuing reactivation changes not only when currently active, but also while
    // an already-active company is in submitted/draft reactivation flow.
    const canQueueReactivation =
        status === "active" ||
        (hasEverBeenActive && (activationStatus === "submitted" || activationStatus === "draft"));
    if (!canQueueReactivation) return false;

    let ownersStructuralChange = false;
    if (Object.prototype.hasOwnProperty.call(updateData, "owners")) {
        try {
            const prev = JSON.parse(JSON.stringify(beforeCompany?.owners ?? []));
            const next = JSON.parse(JSON.stringify(updateData?.owners ?? []));
            ownersStructuralChange = JSON.stringify(prev) !== JSON.stringify(next);
        } catch {
            ownersStructuralChange = true;
        }
    }

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

    const hasMoaChange =
        Object.prototype.hasOwnProperty.call(updateData, "documents") &&
        serializeMoaDocumentsSlice(beforeCompany.documents) !== serializeMoaDocumentsSlice(updateData.documents);

    const hasEjariChange = Object.prototype.hasOwnProperty.call(updateData, "ejari");
    const hasInsuranceChange = Object.prototype.hasOwnProperty.call(updateData, "insurance");

    return (
        ownersStructuralChange ||
        hasBasicDetailsChange ||
        hasTradeLicenseChange ||
        hasEstablishmentCardChange ||
        hasMoaChange ||
        hasEjariChange ||
        hasInsuranceChange
    );
};
