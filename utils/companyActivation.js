import nodemailer from "nodemailer";
import Company from "../models/Company.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import {
    companyPendingEntryId,
    loadCompanyFullProfile,
    clearCompanyWorkflowActivationHold,
    upsertCompanyPartitions,
} from "../services/companyPartitionService.js";
import { isActorDesignatedFlowchartHr } from "./isDesignatedFlowchartHr.js";
import { resolveFlowchartHrEmployee } from "./resolveFlowchartHrEmployee.js";
import { syncDashboardAction } from "./syncDashboard.js";
import {
    clearCompanyActivationHoldDashboardRows,
    clearStaleCompanyActivationOutcomeRows,
} from "./clearCompanyActivationHoldDashboardRows.js";
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
    "owners",
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

/** Only fully activated companies queue edits in pendingReactivationChanges. */
export const shouldOverlayPendingReactivationChanges = (company = {}) => {
    const status = String(company?.status || "").toLowerCase();
    const activationStatus = String(company?.activationStatus || "").toLowerCase();
    return status === "active" && activationStatus === "active";
};

/** Alias — company profile is live (status + activation both active). */
export const isCompanyFullyActivated = (company = {}) => shouldOverlayPendingReactivationChanges(company);

export const companyWasEverFullyActivated = (company = {}) => {
    const co = typeof company.toObject === "function" ? company.toObject() : company;
    if (isCompanyFullyActivated(co)) return true;
    const workflow = Array.isArray(co?.activationWorkflow) ? co.activationWorkflow : [];
    return workflow.some((w) => String(w?.status || "").toLowerCase() === "active");
};

export const mergePendingReactivationForActivationSnapshot = (company = {}) => {
    const co = typeof company.toObject === "function" ? company.toObject() : { ...company };
    if (!shouldOverlayPendingReactivationChanges(co)) {
        return { ...co };
    }
    const pending = Array.isArray(co.pendingReactivationChanges) ? co.pendingReactivationChanges : [];
    let merged = { ...co };
    for (const entry of pending) {
        merged = overlayProposedFieldsForActivation(merged, entry?.proposedData);
    }
    return merged;
};

export const calculateCompanyActivationProgress = (company = {}, opts = {}) => {
    const usePendingOverlay =
        opts.usePendingOverlay !== false && shouldOverlayPendingReactivationChanges(company);
    const co = usePendingOverlay
        ? mergePendingReactivationForActivationSnapshot(company)
        : typeof company.toObject === "function"
          ? company.toObject()
          : { ...company };
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

    const merged = (await loadCompanyFullProfile(company)) || company.toObject();
    const progress = calculateCompanyActivationProgress(merged);

    let pendingAfterSelection = Array.isArray(merged.pendingReactivationChanges)
        ? [...merged.pendingReactivationChanges]
        : [];

    if (selectionProvided) {
        if (!Array.isArray(includedChangeEntryIds)) {
            return {
                ok: false,
                blocked: true,
                message: "includedChangeEntryIds array is required when selectionProvided is true.",
                progress,
            };
        }
        const allSet = new Set(pendingAfterSelection.map((entry, idx) => companyPendingEntryId(entry, idx)));
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
        pendingAfterSelection = pendingAfterSelection.filter((entry, idx) =>
            keep.has(companyPendingEntryId(entry, idx)),
        );
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
    const wasPreviouslyActive = Array.isArray(merged.activationWorkflow)
        ? merged.activationWorkflow.some((w) => String(w?.status || "").toLowerCase() === "active")
        : false;
    const activationTypeLabel = wasPreviouslyActive ? "Reactivation" : "New Activation";
    const requestedChanges = [...new Set(pendingAfterSelection.map((x) => String(x?.card || "").trim()).filter(Boolean))];
    const extra1ForDashboard = dashboardSummary != null
        ? `${activationTypeLabel} | ${dashboardSummary}${requestedChanges.length ? ` | Requested Changes: ${requestedChanges.join(", ")}` : ""}`
        : `${activationTypeLabel} | ${reason}${requestedChanges.length ? ` | Requested Changes: ${requestedChanges.join(", ")}` : ""}`;

    const resubmitAfterHold = Boolean(merged.activationHold);
    const profileWasFullyActive = isCompanyFullyActivated(merged);

    // First-time activation: Inactive until HR approves. Reactivation: status stays Active.
    if (!profileWasFullyActive) {
        company.status = "Inactive";
    }
    company.activationStatus = "submitted";
    company.activationSubmittedTo = hr._id;
    company.activationSubmittedBy = actor?.employeeObjectId || null;
    const activationWorkflow = Array.isArray(merged.activationWorkflow) ? [...merged.activationWorkflow] : [];
    activationWorkflow.push({
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
    await upsertCompanyPartitions(company._id, {
        pendingReactivationChanges: pendingAfterSelection,
        activationWorkflow,
    });
    if (merged.activationHold) {
        await clearCompanyWorkflowActivationHold(company._id);
    }

    await clearCompanyActivationHoldDashboardRows(company._id);
    await clearStaleCompanyActivationOutcomeRows(company._id);

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
 * When company is Active, only these cards use the HR approval queue.
 * All other cards (address, ejari, memo, certificate, owner docs, etc.) apply immediately.
 */
export const ACTIVE_COMPANY_HR_QUEUE_CARD_LABELS = [
    "Basic Details",
    "Trade License",
    "Establishment Card",
    "MOA",
    "Owner Passport",
    "Owner Emirates ID",
];

/**
 * Human-readable labels for HR-queued changes on an active company (pending queue + hold UI).
 */
/** Prior values for a queued edit — only keys present in the PATCH, not the full company profile. */
export const pickCompanyPendingPreviousSnapshot = (beforeCompany = {}, updateData = {}) => {
    const before =
        beforeCompany && typeof beforeCompany === "object"
            ? beforeCompany
            : {};
    const patch = updateData && typeof updateData === "object" ? updateData : {};
    const out = {};
    for (const key of Object.keys(patch)) {
        if (Object.prototype.hasOwnProperty.call(before, key)) {
            out[key] = before[key];
        }
    }
    return out;
};

export const collectCompanyReactivationChangeLabels = (updateData = {}, beforeCompany = {}) => {
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
    if (Object.prototype.hasOwnProperty.call(updateData, "owners")) {
        const beforeOwners = beforeCompany?.owners || [];
        if (isOwnersPassportModified(beforeOwners, updateData.owners)) {
            changes.push("Owner Passport");
        }
        if (isOwnersEmiratesIdModified(beforeOwners, updateData.owners)) {
            changes.push("Owner Emirates ID");
        }
    }

    return [...new Set(changes)].filter((label) => ACTIVE_COMPANY_HR_QUEUE_CARD_LABELS.includes(label));
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
        const newLabels = collectCompanyReactivationChangeLabels(pd, entry?.previousData);
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

/** Live document rows (MOA, memo, certificate, with/without expiry) for reactivation diff — excludes archived rows. */
const serializeActivationDocumentsSlice = (documents) => {
    const list = Array.isArray(documents) ? documents : [];
    const liveRows = list.filter((d) => !isArchivedCompanyDocumentRow(d));
    const iso = (v) => {
        if (v == null || v === "") return "";
        const d = v instanceof Date ? v : new Date(v);
        return Number.isNaN(d.getTime()) ? "" : d.toISOString();
    };
    const norm = (d) => ({
        id: d?._id != null ? String(d._id) : "",
        context: String(d?.context || ""),
        type: String(d?.type || ""),
        description: String(d?.description || ""),
        issueDate: iso(d?.issueDate),
        startDate: iso(d?.startDate),
        expiryDate: iso(d?.expiryDate),
        url: String(d?.document?.url || d?.attachment || "").split("?")[0],
    });
    try {
        return JSON.stringify(liveRows.map(norm).sort((a, b) => a.id.localeCompare(b.id)));
    } catch {
        return String(liveRows.length);
    }
};

/** @deprecated Use serializeActivationDocumentsSlice — kept for callers that only diff MOA. */
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

const ACTIVATION_INDEPENDENT_OWNER_DOC_KEYS = new Set(["visitVisa", "employmentVisa", "spouseVisa", "visa", "labourCard", "medical", "drivingLicense"]);

function ownerWithoutActivationIndependentDocs(owner) {
    if (!owner || typeof owner !== "object") return owner;
    const copy = JSON.parse(JSON.stringify(owner));
    for (const key of ACTIVATION_INDEPENDENT_OWNER_DOC_KEYS) {
        delete copy[key];
    }
    return copy;
}

export function ownersChangeIsVisaDocsOnly(beforeOwners = [], nextOwners = []) {
    const prev = Array.isArray(beforeOwners) ? beforeOwners : [];
    const next = Array.isArray(nextOwners) ? nextOwners : [];
    if (prev.length !== next.length) return false;
    try {
        if (JSON.stringify(prev) === JSON.stringify(next)) return false;
        for (let i = 0; i < prev.length; i++) {
            if (JSON.stringify(ownerWithoutActivationIndependentDocs(prev[i])) !== JSON.stringify(ownerWithoutActivationIndependentDocs(next[i]))) {
                return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}

const BASIC_DETAILS_HR_KEYS = ["name", "nickName", "email", "phone", "establishedDate", "companyId"];
const TRADE_LICENSE_HR_KEYS = [
    "tradeLicenseNumber",
    "tradeLicenseIssueDate",
    "tradeLicenseExpiry",
    "tradeLicenseAttachment",
    "tradeLicenseOwnerName",
];
const ESTABLISHMENT_HR_KEYS = [
    "establishmentCardNumber",
    "establishmentCardIssueDate",
    "establishmentCardExpiry",
    "establishmentCardAttachment",
];

const hasPayloadKey = (updateData, keys) =>
    keys.some((k) => Object.prototype.hasOwnProperty.call(updateData, k));

/**
 * True when a PATCH body changes Basic Details, Trade License, Establishment Card, or MOA
 * (add / edit / renew / not-renew via documents payload). Used for HR queue on active profiles.
 */
const serializeOwnerPassport = (owner) => {
    if (!owner || typeof owner !== "object") return "";
    const p = owner.passport || {};
    const passportData = {
        number: p.number || "",
        nationality: p.nationality || "",
        countryOfIssue: p.countryOfIssue || "",
        issueDate: p.issueDate ? new Date(p.issueDate).getTime() : "",
        expiryDate: p.expiryDate ? new Date(p.expiryDate).getTime() : "",
        attachment: typeof p.attachment === "object" ? p.attachment?.url || "" : p.attachment || "",
    };
    return JSON.stringify(passportData);
};

const serializeOwnerEmiratesId = (owner) => {
    if (!owner || typeof owner !== "object") return "";
    const e = owner.emiratesId || {};
    const emiratesIdData = {
        number: e.number || "",
        issueDate: e.issueDate ? new Date(e.issueDate).getTime() : "",
        expiryDate: e.expiryDate ? new Date(e.expiryDate).getTime() : "",
        attachment: typeof e.attachment === "object" ? e.attachment?.url || "" : e.attachment || "",
    };
    return JSON.stringify(emiratesIdData);
};

export const isOwnersPassportModified = (beforeOwners = [], nextOwners = []) => {
    const prev = Array.isArray(beforeOwners) ? beforeOwners : [];
    const next = Array.isArray(nextOwners) ? nextOwners : [];
    
    for (let i = 0; i < next.length; i++) {
        const nextOwner = next[i];
        const nextId = nextOwner?._id || nextOwner?.id;
        
        let prevOwner = null;
        if (nextId) {
            prevOwner = prev.find(o => String(o?._id || o?.id || "") === String(nextId));
        }
        if (!prevOwner) {
            const p = nextOwner?.passport;
            if (p && (p.number || p.attachment)) {
                return true;
            }
            continue;
        }
        
        if (serializeOwnerPassport(prevOwner) !== serializeOwnerPassport(nextOwner)) {
            return true;
        }
    }
    return false;
};

export const isOwnersEmiratesIdModified = (beforeOwners = [], nextOwners = []) => {
    const prev = Array.isArray(beforeOwners) ? beforeOwners : [];
    const next = Array.isArray(nextOwners) ? nextOwners : [];
    
    for (let i = 0; i < next.length; i++) {
        const nextOwner = next[i];
        const nextId = nextOwner?._id || nextOwner?.id;
        
        let prevOwner = null;
        if (nextId) {
            prevOwner = prev.find(o => String(o?._id || o?.id || "") === String(nextId));
        }
        if (!prevOwner) {
            const e = nextOwner?.emiratesId;
            if (e && (e.number || e.attachment)) {
                return true;
            }
            continue;
        }
        
        if (serializeOwnerEmiratesId(prevOwner) !== serializeOwnerEmiratesId(nextOwner)) {
            return true;
        }
    }
    return false;
};

export const updateDataTouchesHrApprovalCards = (beforeCompany = {}, updateData = {}) => {
    if (hasPayloadKey(updateData, BASIC_DETAILS_HR_KEYS)) {
        return true;
    }
    if (hasPayloadKey(updateData, TRADE_LICENSE_HR_KEYS)) {
        return true;
    }
    if (hasPayloadKey(updateData, ESTABLISHMENT_HR_KEYS)) {
        return true;
    }
    if (
        Object.prototype.hasOwnProperty.call(updateData, "documents") &&
        serializeMoaDocumentsSlice(beforeCompany.documents) !== serializeMoaDocumentsSlice(updateData.documents)
    ) {
        return true;
    }
    if (Object.prototype.hasOwnProperty.call(updateData, "owners")) {
        const beforeOwners = beforeCompany?.owners || [];
        if (
            isOwnersPassportModified(beforeOwners, updateData.owners) ||
            isOwnersEmiratesIdModified(beforeOwners, updateData.owners)
        ) {
            return true;
        }
    }
    return false;
};

/**
 * Active profile (status + activation both active): HR-queue card edits wait in pendingReactivationChanges.
 * Inactive / draft profile: returns false so updates apply immediately without HR approval.
 */
export const shouldTriggerCompanyReactivation = (beforeCompany = {}, updateData = {}) => {
    if (!isCompanyFullyActivated(beforeCompany)) {
        return false;
    }
    return updateDataTouchesHrApprovalCards(beforeCompany, updateData);
};
