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
    clearCreatorCompanyActivationDashboardTasks,
    clearStaleCompanyActivationOutcomeRows,
} from "./clearCompanyActivationHoldDashboardRows.js";
import { shortenUrlsInString } from "./shortenUrlsInString.js";
import {
    getOwnerRowEmail,
    validateOwnerDetailsOwnersPayload,
    validateOwnerEmail,
    validateOwnerFullName,
    validateOwnerNationality,
    validateOwnerPhone,
} from "./ownerDetailsValidation.js";
import { validateOwnerSharePercentage } from "./tradeLicenseValidation.js";
import { validateOwnerPassportRow } from "./ownerPassportValidation.js";
import { validateOwnerEmiratesIdRow } from "./ownerEmiratesIdValidation.js";
import { mergeCompanyOwnersSnapshot, isTradeLicenseOwnersBundleUpdate } from "./mergeCompanyOwnersSnapshot.js";

const hasValue = (v) => !(v === undefined || v === null || (typeof v === "string" && v.trim() === ""));
const hasAttachment = (v) => hasValue(v);

const hasOwnerDocAttachment = (att) => {
    if (!hasValue(att)) return false;
    if (typeof att === "object" && att !== null) {
        return hasValue(att.url) || hasValue(att.publicId) || hasValue(att.data);
    }
    return true;
};

const companyOwnersList = (company = {}) =>
    Array.isArray(company.owners) ? company.owners : [];

const isOwnerPassportActivationComplete = (passport, owners, ownerIndex) => {
    if (!passport || typeof passport !== "object") return false;
    const check = validateOwnerPassportRow(passport, { owners, ownerIndex });
    if (!check.ok) return false;
    const hasContent =
        passport.number ||
        passport.nationality ||
        passport.countryOfIssue ||
        passport.issueDate ||
        passport.expiryDate ||
        passport.attachment;
    if (!hasContent) return false;
    return hasOwnerDocAttachment(passport.attachment);
};

const isOwnerEmiratesIdActivationComplete = (emiratesId, owners, ownerIndex) => {
    if (!emiratesId || typeof emiratesId !== "object") return false;
    const check = validateOwnerEmiratesIdRow(emiratesId, { owners, ownerIndex });
    if (!check.ok) return false;
    const hasContent =
        emiratesId.number ||
        emiratesId.issueDate ||
        emiratesId.expiryDate ||
        emiratesId.attachment;
    if (!hasContent) return false;
    return hasOwnerDocAttachment(emiratesId.attachment);
};

const areOwnersPassportsActivationComplete = (owners = []) => {
    if (!owners.length) return false;
    return owners.some((owner, i) =>
        isOwnerPassportActivationComplete(owner?.passport, owners, i),
    );
};

const areOwnersEmiratesIdsActivationComplete = (owners = []) => {
    if (!owners.length) return false;
    return owners.some((owner, i) =>
        isOwnerEmiratesIdActivationComplete(owner?.emiratesId, owners, i),
    );
};

const ownerActivationLabel = (owner, index, total) => {
    const name = String(owner?.name || "").trim();
    if (total <= 1) return name || "Owner";
    return name || `Owner ${index + 1}`;
};

const getOwnerEmiratesIdActivationBlockers = (owners = []) => {
    if (!owners.length) return ["Add an owner with a complete Emirates ID card"];
    if (owners.some((owner, i) => isOwnerEmiratesIdActivationComplete(owner?.emiratesId, owners, i))) {
        return [];
    }
    const blockers = [];
    owners.forEach((owner, i) => {
        const eid = owner?.emiratesId;
        if (!eid || typeof eid !== "object") return;
        const prefix = owners.length > 1 ? `${ownerActivationLabel(owner, i, owners.length)}: ` : "";
        const check = validateOwnerEmiratesIdRow(eid, { owners, ownerIndex: i });
        if (!check.ok && check.message) {
            blockers.push(`${prefix}${check.message}`);
            return;
        }
        if (!hasOwnerDocAttachment(eid.attachment)) {
            blockers.push(`${prefix}Emirates ID PDF attachment is required`);
        }
    });
    if (blockers.length) return blockers;
    return ["At least one owner needs a complete Emirates ID card (784…, dates, PDF attachment)"];
};

const getOwnerPassportActivationBlockers = (owners = []) => {
    if (!owners.length) return ["Add an owner with a complete passport card"];
    if (owners.some((owner, i) => isOwnerPassportActivationComplete(owner?.passport, owners, i))) {
        return [];
    }
    const blockers = [];
    owners.forEach((owner, i) => {
        const passport = owner?.passport;
        if (!passport || typeof passport !== "object") return;
        const prefix = owners.length > 1 ? `${ownerActivationLabel(owner, i, owners.length)}: ` : "";
        const check = validateOwnerPassportRow(passport, { owners, ownerIndex: i });
        if (!check.ok && check.message) {
            blockers.push(`${prefix}${check.message}`);
            return;
        }
        if (!hasOwnerDocAttachment(passport.attachment)) {
            blockers.push(`${prefix}Passport PDF attachment is required`);
        }
    });
    if (blockers.length) return blockers;
    return ["At least one owner needs a complete passport card (number, dates, PDF attachment)"];
};

const isOwnerDetailsRowActivationComplete = (owner, owners, ownerIndex) => {
    const nameErr = validateOwnerFullName(owner?.name);
    if (nameErr) return false;
    const emailErr = validateOwnerEmail(getOwnerRowEmail(owner), { requireEmail: true });
    if (emailErr) return false;
    const phoneErr = validateOwnerPhone(owner?.phone);
    if (phoneErr) return false;
    const natErr = validateOwnerNationality(owner?.nationality);
    if (natErr) return false;
    const shareErr = validateOwnerSharePercentage(owner?.sharePercentage);
    if (shareErr) return false;
    return true;
};

const getOwnerDetailsActivationBlockers = (owners = []) => {
    if (!owners.length) return ["Add at least one owner"];
    const rosterCheck = validateOwnerDetailsOwnersPayload(owners, { profileActive: false });
    if (!rosterCheck.ok) return [rosterCheck.message];
    if (owners.some((owner, i) => isOwnerDetailsRowActivationComplete(owner, owners, i))) {
        return [];
    }
    const blockers = [];
    owners.forEach((owner, i) => {
        const prefix = owners.length > 1 ? `${ownerActivationLabel(owner, i, owners.length)}: ` : "";
        const nameErr = validateOwnerFullName(owner?.name);
        if (nameErr) {
            blockers.push(`${prefix}${nameErr}`);
            return;
        }
        const emailErr = validateOwnerEmail(getOwnerRowEmail(owner), { requireEmail: true });
        if (emailErr) {
            blockers.push(`${prefix}${emailErr}`);
            return;
        }
        const phoneErr = validateOwnerPhone(owner?.phone);
        if (phoneErr) {
            blockers.push(`${prefix}${phoneErr}`);
            return;
        }
        const natErr = validateOwnerNationality(owner?.nationality);
        if (natErr) {
            blockers.push(`${prefix}${natErr}`);
        }
    });
    if (blockers.length) return blockers;
    return ["At least one owner needs complete details (email, phone, nationality)"];
};

const areOwnerDetailsActivationComplete = (owners = []) => {
    if (!owners.length) return false;
    const rosterCheck = validateOwnerDetailsOwnersPayload(owners, { profileActive: false });
    if (!rosterCheck.ok) return false;
    return owners.some((owner, i) => isOwnerDetailsRowActivationComplete(owner, owners, i));
};

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
        if (!Object.prototype.hasOwnProperty.call(proposed, k)) continue;
        if (k === "owners" && Array.isArray(proposed.owners)) {
            out.owners = mergeCompanyOwnersSnapshot(out.owners || [], proposed.owners);
        } else {
            out[k] = proposed[k];
        }
    }
    return out;
};

/** Company status is Active (may still be in submitted/hold reactivation review). */
export const isActiveCompanyProfile = (company = {}) =>
    String(company?.status || "").toLowerCase() === "active";

/**
 * Merge queued patches for progress / eligibility only — not for live card display.
 * Active profiles keep pending edits in the queue until HR approves, even when activationStatus is submitted.
 */
export const shouldOverlayPendingReactivationChanges = (company = {}) => isActiveCompanyProfile(company);

/** Status Active + activationStatus active (strict “fully activated” UI state). */
export const isCompanyFullyActivated = (company = {}) => {
    const activationStatus = String(company?.activationStatus || "").toLowerCase();
    return isActiveCompanyProfile(company) && activationStatus === "active";
};

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
        {
            key: "ownerDetails",
            label: "Owner Details Card",
            completed: areOwnerDetailsActivationComplete(companyOwnersList(co)),
            blockers: areOwnerDetailsActivationComplete(companyOwnersList(co))
                ? []
                : getOwnerDetailsActivationBlockers(companyOwnersList(co)),
        },
        {
            key: "ownerPassport",
            label: "Passport of Owner",
            completed: areOwnersPassportsActivationComplete(companyOwnersList(co)),
            blockers: areOwnersPassportsActivationComplete(companyOwnersList(co))
                ? []
                : getOwnerPassportActivationBlockers(companyOwnersList(co)),
        },
        {
            key: "ownerEmiratesId",
            label: "EID of Owner",
            completed: areOwnersEmiratesIdsActivationComplete(companyOwnersList(co)),
            blockers: areOwnersEmiratesIdsActivationComplete(companyOwnersList(co))
                ? []
                : getOwnerEmiratesIdActivationBlockers(companyOwnersList(co)),
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

    let submittingThisRequest = pendingAfterSelection;
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
        if (pendingAfterSelection.length > 0 && includedChangeEntryIds.length === 0) {
            return {
                ok: false,
                blocked: true,
                message: "Select at least one requested change to submit.",
                progress,
            };
        }
        const keep = new Set(includedChangeEntryIds.map(String));
        submittingThisRequest = pendingAfterSelection.filter((entry, idx) =>
            keep.has(companyPendingEntryId(entry, idx)),
        );
        // Keep the full queue in pendingReactivationChanges — unchecked rows stay until HR approves.
    }
    if (!force && !isActiveCompanyProfile(merged) && progress.percentage < 100) {
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
    const requestedChanges = [...new Set(submittingThisRequest.map((x) => String(x?.card || "").trim()).filter(Boolean))];
    const extra1ForDashboard = dashboardSummary != null
        ? `${activationTypeLabel} | ${dashboardSummary}${requestedChanges.length ? ` | Requested Changes: ${requestedChanges.join(", ")}` : ""}`
        : `${activationTypeLabel} | ${reason}${requestedChanges.length ? ` | Requested Changes: ${requestedChanges.join(", ")}` : ""}`;

    const profileWasFullyActive = isCompanyFullyActivated(merged);

    // First-time activation: Inactive until HR approves. Reactivation: status stays Active.
    const companyStatusLower = String(company?.status || "").toLowerCase();
    if (!profileWasFullyActive && companyStatusLower !== "active") {
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

    const actorEmpId = actor ? await resolveActorDashboardEmployeeBasicId(actor) : null;
    if (actorEmpId) {
        await clearCreatorCompanyActivationDashboardTasks(company._id, actorEmpId);
    }

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
 * Other cards (address, ejari, memo, certificate, owner visas, etc.) apply immediately.
 */
export const ACTIVE_COMPANY_HR_QUEUE_CARD_LABELS = [
    "Basic Details",
    "Trade License",
    "Establishment Card",
    "MOA",
    "Owner Details",
    "Owner Passport",
    "Owner Emirates ID",
];

/**
 * Human-readable labels for HR-queued changes on an active company (pending queue + hold UI).
 */
const normalizeSubmittedCardLabel = (label) =>
    String(label || "")
        .toLowerCase()
        .replace(/\s*\([^)]*\)\s*$/g, "")
        .trim();

/** Card labels from the latest workflow step still in `submitted` status. */
const parseRequestedChangesFromWorkflowStep = (step = {}) => {
    if (!step || typeof step !== "object") return [];
    const desc = String(step.description || "").trim();
    if (desc) {
        for (const segment of desc.split("|").map((s) => s.trim())) {
            const inline = segment.match(/^Requested Changes:\s*(.+)$/i);
            if (inline?.[1]) {
                return inline[1]
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
            }
        }
        const tail = desc.match(/Requested Changes:\s*(.+)$/i);
        if (tail?.[1]) {
            return tail[1]
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        }
    }
    const text = `${step.description || ""} ${step.reason || ""} ${step.comment || ""}`;
    const match = text.match(/Requested Changes:\s*([^|]+?)(?:\s*\||\s*Type:|$)/i);
    if (match?.[1]) {
        return match[1]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    }
    return [];
};

const submittedCardLabelMatchesPart = (part, submittedSet) => {
    if (!part || !submittedSet?.size) return false;
    if (submittedSet.has(part)) return true;
    for (const s of submittedSet) {
        if (s === part) return true;
        if (s.startsWith(`${part} `) || part.startsWith(`${s} `)) return true;
    }
    return false;
};

/** True when a pending row belongs to cards named in this HR submission (e.g. only Trade License). */
export function pendingEntryIncludedInSubmittedCards(entry, submittedCardLabels = []) {
    if (!entry || typeof entry !== "object") return false;
    if (!Array.isArray(submittedCardLabels) || submittedCardLabels.length === 0) return true;
    const submitted = new Set(submittedCardLabels.map(normalizeSubmittedCardLabel).filter(Boolean));
    if (!submitted.size) return true;
    const rawCard = String(entry?.card || entry?.reason || "").trim();
    const parts = rawCard
        .split(",")
        .map((s) => normalizeSubmittedCardLabel(s))
        .filter(Boolean);
    if (!parts.length) return false;
    return parts.some((part) => submittedCardLabelMatchesPart(part, submitted));
}

export function resolveLatestActivationSubmissionLabels(activationWorkflow = []) {
    const list = Array.isArray(activationWorkflow) ? activationWorkflow : [];
    for (let i = list.length - 1; i >= 0; i--) {
        const step = list[i];
        if (String(step?.status || "").toLowerCase() !== "submitted") continue;
        const labels = parseRequestedChangesFromWorkflowStep(step);
        if (labels.length) return labels;
    }
    return [];
}

/** Pending rows HR is reviewing in the current submission — excludes unsubmitted local drafts. */
export const filterPendingEntriesInCurrentSubmission = (pendingChanges = [], activationWorkflow = []) => {
    const list = Array.isArray(pendingChanges) ? pendingChanges : [];
    const labels = resolveLatestActivationSubmissionLabels(activationWorkflow);
    if (!labels.length) return list;
    return list.filter((entry) => pendingEntryIncludedInSubmittedCards(entry, labels));
};

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
        const tradeLicenseBundle = isTradeLicenseOwnersBundleUpdate(updateData);
        // Trade License modal owns roster/name/share edits — do not also queue Owner Details rows.
        if (!tradeLicenseBundle) {
            if (isOwnersPassportModified(beforeOwners, updateData.owners)) {
                changes.push("Owner Passport");
            }
            if (isOwnersEmiratesIdModified(beforeOwners, updateData.owners)) {
                changes.push("Owner Emirates ID");
            }
            if (isOwnersBasicDetailsModified(beforeOwners, updateData.owners)) {
                changes.push("Owner Details");
            }
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

const normCardLabel = (s) => String(s || "").toLowerCase().trim();

function labelsFromPendingEntryCard(card) {
    return String(card || "")
        .split(",")
        .map((s) => s.replace(/\([^)]*\)/g, "").trim())
        .filter(Boolean);
}

function pendingEntryMatchesChangedCards(entry, changedCards = []) {
    const changedNorm = new Set(changedCards.map(normCardLabel).filter(Boolean));
    if (!changedNorm.size) return false;
    const pd =
        entry?.proposedData && typeof entry.proposedData === "object" ? entry.proposedData : {};
    const fromPd = collectCompanyReactivationChangeLabels(pd, entry?.previousData);
    const entryLabels = fromPd.length ? fromPd : labelsFromPendingEntryCard(entry?.card);
    return entryLabels.some((l) => changedNorm.has(normCardLabel(l)));
}

const OWNER_NESTED_DOC_KEYS = [
    "passport",
    "emiratesId",
    "visitVisa",
    "employmentVisa",
    "spouseVisa",
    "labourCard",
    "medical",
    "drivingLicense",
    "visa",
];

const sliceOwnersPassportOnly = (owners = []) =>
    (Array.isArray(owners) ? owners : [])
        .map((o) => {
            if (!o || typeof o !== "object" || !o.passport) return null;
            const row = {};
            if (o._id != null) row._id = o._id;
            if (o.id != null) row.id = o.id;
            if (o.name) row.name = o.name;
            row.passport = o.passport;
            return row;
        })
        .filter(Boolean);

const sliceOwnersEmiratesIdOnly = (owners = []) =>
    (Array.isArray(owners) ? owners : [])
        .map((o) => {
            if (!o || typeof o !== "object" || !o.emiratesId) return null;
            const row = {};
            if (o._id != null) row._id = o._id;
            if (o.id != null) row.id = o.id;
            if (o.name) row.name = o.name;
            row.emiratesId = o.emiratesId;
            return row;
        })
        .filter(Boolean);

const stripOwnerNestedDocs = (owner = {}) => {
    const out = { ...owner };
    for (const k of OWNER_NESTED_DOC_KEYS) delete out[k];
    return out;
};

const sliceOwnersBasicOnly = (owners = []) =>
    (Array.isArray(owners) ? owners : []).map((o) => stripOwnerNestedDocs(o));

const pendingPayloadHasContent = (payload = {}) => {
    if (!payload || typeof payload !== "object") return false;
    if (Array.isArray(payload.owners)) return payload.owners.length > 0;
    return Object.keys(payload).length > 0;
};

/** Same path logic as company profile UI — signed URLs must not look like MOA edits. */
const documentAttachmentFingerprint = (d) => {
    const raw = String(
        d?.document?.url || d?.document?.publicId || d?.attachment || "",
    ).trim();
    if (!raw) return "";
    const noQuery = raw.split("?")[0].trim().toLowerCase();
    for (const marker of ["company-documents", "employee-documents"]) {
        const idx = noQuery.indexOf(marker);
        if (idx !== -1) return noQuery.slice(idx);
    }
    return noQuery;
};

const moaDocumentRowSignature = (d) => {
    if (!d || typeof d !== "object") return "";
    return JSON.stringify({
        type: String(d?.type || "").trim(),
        description: String(d?.description || "").trim(),
        issueDate: String(d?.issueDate || "").trim(),
        startDate: String(d?.startDate || "").trim(),
        expiryDate: String(d?.expiryDate || "").trim(),
        url: documentAttachmentFingerprint(d),
    });
};

const moaDocRowId = (d) => (d?._id != null ? String(d._id) : d?.id != null ? String(d.id) : "");

const filterMoaDocumentsForPending = (docs = []) =>
    (Array.isArray(docs) ? docs : []).filter((d) => documentIsMoaForActivation(d));

const collectPendingMoaDocumentChanges = (previousDocs = [], proposedDocs = []) => {
    const prevMoa = filterMoaDocumentsForPending(previousDocs);
    const propMoa = filterMoaDocumentsForPending(proposedDocs);
    const prevById = new Map();
    for (const doc of prevMoa) {
        const id = moaDocRowId(doc);
        if (id) prevById.set(id, doc);
    }
    const changedPropDocs = [];
    const changedPrevDocs = [];
    const seenPropIds = new Set();
    for (const doc of propMoa) {
        const id = moaDocRowId(doc);
        if (!id) {
            changedPropDocs.push(doc);
            continue;
        }
        const prev = prevById.get(id);
        if (!prev) {
            changedPropDocs.push(doc);
            continue;
        }
        if (moaDocumentRowSignature(prev) !== moaDocumentRowSignature(doc)) {
            if (!seenPropIds.has(id)) {
                seenPropIds.add(id);
                changedPropDocs.push(doc);
                changedPrevDocs.push(prev);
            }
        }
    }
    return { changedPropDocs, changedPrevDocs };
};

/** One pending row per HR card so Submit pending shows separate Passport / EID / Owner Details rows. */
const slicePendingEntryForCard = (entry, cardLabel) => {
    const proposed = entry?.proposedData && typeof entry.proposedData === "object" ? entry.proposedData : {};
    const previous = entry?.previousData && typeof entry.previousData === "object" ? entry.previousData : {};
    const label = normCardLabel(cardLabel);

    if (label === "owner passport") {
        return {
            ...entry,
            card: cardLabel,
            reason: cardLabel,
            proposedData: { owners: sliceOwnersPassportOnly(proposed.owners) },
            previousData: { owners: sliceOwnersPassportOnly(previous.owners) },
        };
    }
    if (label === "owner emirates id") {
        return {
            ...entry,
            card: cardLabel,
            reason: cardLabel,
            proposedData: { owners: sliceOwnersEmiratesIdOnly(proposed.owners) },
            previousData: { owners: sliceOwnersEmiratesIdOnly(previous.owners) },
        };
    }
    if (label === "owner details") {
        return {
            ...entry,
            card: cardLabel,
            reason: cardLabel,
            proposedData: {
                owners: sliceOwnersBasicOnly(proposed.owners),
                ...(proposed.__ownersReplaceRoster ? { __ownersReplaceRoster: true } : {}),
            },
            previousData: { owners: sliceOwnersBasicOnly(previous.owners) },
        };
    }
    if (label === "trade license") {
        const keys = [
            "tradeLicenseNumber",
            "tradeLicenseIssueDate",
            "tradeLicenseExpiry",
            "tradeLicenseAttachment",
            "tradeLicenseOwnerName",
        ];
        const pick = (src) => {
            const out = {};
            for (const k of keys) {
                if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
            }
            if (Array.isArray(src.owners)) out.owners = src.owners;
            return out;
        };
        return { ...entry, card: cardLabel, reason: cardLabel, proposedData: pick(proposed), previousData: pick(previous) };
    }
    if (label === "establishment card") {
        const keys = [
            "establishmentCardNumber",
            "establishmentCardIssueDate",
            "establishmentCardExpiry",
            "establishmentCardAttachment",
        ];
        const pick = (src) => {
            const out = {};
            for (const k of keys) {
                if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
            }
            return out;
        };
        return { ...entry, card: cardLabel, reason: cardLabel, proposedData: pick(proposed), previousData: pick(previous) };
    }
    if (label === "basic details") {
        const keys = ["name", "nickName", "email", "phone", "establishedDate", "companyId"];
        const pick = (src) => {
            const out = {};
            for (const k of keys) {
                if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
            }
            return out;
        };
        return { ...entry, card: cardLabel, reason: cardLabel, proposedData: pick(proposed), previousData: pick(previous) };
    }
    if (label === "moa") {
        const { changedPropDocs, changedPrevDocs } = collectPendingMoaDocumentChanges(
            previous.documents,
            proposed.documents,
        );
        const proposedData = changedPropDocs.length ? { documents: changedPropDocs } : {};
        const previousData = changedPrevDocs.length ? { documents: changedPrevDocs } : {};
        return {
            ...entry,
            card: cardLabel,
            reason: cardLabel,
            proposedData,
            previousData,
        };
    }
    return { ...entry, card: cardLabel, reason: cardLabel };
};

/**
 * Merge a new save into an existing queued row for the same card (e.g. Trade License edited twice).
 * Keeps the original previousData snapshot from the first queue.
 */
export const upsertPendingReactivationEntry = (existingPending = [], newEntry, changedCards = []) => {
    const list = Array.isArray(existingPending) ? [...existingPending] : [];
    const cards = [...new Set(changedCards)].filter(Boolean);
    if (cards.length > 1) {
        let result = list;
        for (const cardLabel of cards) {
            const sliced = slicePendingEntryForCard(newEntry, cardLabel);
            if (!pendingPayloadHasContent(sliced.proposedData)) continue;
            result = upsertPendingReactivationEntry(result, sliced, [cardLabel]);
        }
        return result;
    }
    if (!cards.length) {
        list.push(newEntry);
        return list;
    }
    newEntry = slicePendingEntryForCard(newEntry, cards[0]);
    if (!pendingPayloadHasContent(newEntry.proposedData)) {
        return list;
    }
    let merged = false;
    const next = list.map((entry) => {
        if (!pendingEntryMatchesChangedCards(entry, cards)) return entry;
        merged = true;
        const prevSnapshot = entry?.previousData ?? newEntry.previousData;
        let mergedProposed = {};
        try {
            const prior =
                entry?.proposedData && typeof entry.proposedData === "object"
                    ? JSON.parse(JSON.stringify(entry.proposedData))
                    : {};
            const patch =
                newEntry?.proposedData && typeof newEntry.proposedData === "object"
                    ? JSON.parse(JSON.stringify(newEntry.proposedData))
                    : {};
            mergedProposed = { ...prior, ...patch };
            if (Array.isArray(prior.owners) && Array.isArray(patch.owners)) {
                mergedProposed.owners = mergeCompanyOwnersSnapshot(prior.owners, patch.owners);
            }
        } catch {
            mergedProposed = newEntry.proposedData;
        }
        return {
            ...entry,
            ...newEntry,
            card: newEntry.card || entry.card,
            reason: newEntry.reason || entry.reason,
            previousData: prevSnapshot,
            proposedData: mergedProposed,
            changedAt: newEntry.changedAt || entry.changedAt,
            queuedByUserId: entry.queuedByUserId || newEntry.queuedByUserId || "",
            queuedByEmployeeId: entry.queuedByEmployeeId || newEntry.queuedByEmployeeId || "",
            queuedByEmployeeObjectId:
                entry.queuedByEmployeeObjectId || newEntry.queuedByEmployeeObjectId || "",
            queuedByName: entry.queuedByName || newEntry.queuedByName || "",
        };
    });
    if (!merged) next.push(newEntry);
    return next;
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
        url: documentAttachmentFingerprint(d),
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

const serializeOwnerBasicDetails = (owner = {}) =>
    JSON.stringify({
        name: String(owner?.name || "").trim(),
        email: String(owner?.email || "").trim().toLowerCase(),
        phone: String(owner?.phone || "").trim(),
        phoneCountryCode: String(owner?.phoneCountryCode || "").trim(),
        nationality: String(owner?.nationality || "").trim(),
        sharePercentage:
            owner?.sharePercentage != null && owner?.sharePercentage !== ""
                ? String(owner.sharePercentage)
                : "",
    });

const serializeOwnerContactDetails = (owner = {}) =>
    JSON.stringify({
        name: String(owner?.name || "").trim(),
        email: String(owner?.email || "").trim().toLowerCase(),
        phone: String(owner?.phone || "").trim(),
        phoneCountryCode: String(owner?.phoneCountryCode || "").trim(),
        nationality: String(owner?.nationality || "").trim(),
    });

/** Email / phone / nationality / name changed — not share-only or roster add/remove. */
export const isOwnersContactDetailsModified = (beforeOwners = [], nextOwners = []) => {
    const prev = Array.isArray(beforeOwners) ? beforeOwners : [];
    const next = Array.isArray(nextOwners) ? nextOwners : [];

    const findPrev = (nextOwner, idx) => {
        const nextId = nextOwner?._id || nextOwner?.id;
        if (nextId) {
            const found = prev.find((o) => String(o?._id || o?.id || "") === String(nextId));
            if (found) return found;
        }
        const profileId = nextOwner?.ownerProfileId;
        if (profileId) {
            const found = prev.find((o) => String(o?.ownerProfileId || "") === String(profileId));
            if (found) return found;
        }
        return prev[idx] || null;
    };

    if (prev.length !== next.length) {
        for (let i = 0; i < next.length; i++) {
            const nextOwner = next[i];
            const prevOwner = findPrev(nextOwner, i);
            if (!prevOwner) {
                const contact = serializeOwnerContactDetails(nextOwner);
                const nameOnly = serializeOwnerContactDetails({ name: nextOwner?.name });
                if (contact !== nameOnly) return true;
                continue;
            }
            if (serializeOwnerContactDetails(prevOwner) !== serializeOwnerContactDetails(nextOwner)) {
                return true;
            }
        }
        for (const prevOwner of prev) {
            const prevId = prevOwner?._id || prevOwner?.id;
            const prevPid = prevOwner?.ownerProfileId;
            const stillPresent = next.some(
                (o) =>
                    (prevId && String(o?._id || o?.id || "") === String(prevId)) ||
                    (prevPid && String(o?.ownerProfileId || "") === String(prevPid)),
            );
            if (!stillPresent) return false;
        }
        return false;
    }

    for (let i = 0; i < next.length; i++) {
        const nextOwner = next[i];
        const prevOwner = findPrev(nextOwner, i);
        if (!prevOwner) continue;
        if (serializeOwnerContactDetails(prevOwner) !== serializeOwnerContactDetails(nextOwner)) {
            return true;
        }
    }
    return false;
};

/** Share % or owner roster changed without contact-field edits (Trade License modal). */
export const isOwnersShareOrRosterOnlyModified = (beforeOwners = [], nextOwners = []) => {
    if (!isOwnersBasicDetailsModified(beforeOwners, nextOwners)) return false;
    return !isOwnersContactDetailsModified(beforeOwners, nextOwners);
};

/** Drop Owner Details queue rows that only mirror Trade License roster edits. */
export const stripOwnerDetailsPendingSupersededByTradeLicense = (pending = []) => {
    return (Array.isArray(pending) ? pending : []).filter((entry) => {
        const card = String(entry?.card || entry?.reason || "").toLowerCase();
        if (!card.includes("owner details")) return true;
        if (card.includes("trade license")) return false;
        const before = entry?.previousData?.owners || [];
        const after = entry?.proposedData?.owners || [];
        if (!Array.isArray(after) || after.length === 0) return true;
        return !isOwnersShareOrRosterOnlyModified(before, after);
    });
};

/** Name, email, phone, nationality, share % — not passport / Emirates ID sub-documents. */
export const isOwnersBasicDetailsModified = (beforeOwners = [], nextOwners = []) => {
    const prev = Array.isArray(beforeOwners) ? beforeOwners : [];
    const next = Array.isArray(nextOwners) ? nextOwners : [];

    const findPrev = (nextOwner, idx) => {
        const nextId = nextOwner?._id || nextOwner?.id;
        if (nextId) {
            const found = prev.find((o) => String(o?._id || o?.id || "") === String(nextId));
            if (found) return found;
        }
        return prev[idx] || null;
    };

    if (prev.length !== next.length) return true;

    for (let i = 0; i < next.length; i++) {
        const nextOwner = next[i];
        const prevOwner = findPrev(nextOwner, i);
        if (!prevOwner) {
            if (serializeOwnerBasicDetails(nextOwner) !== serializeOwnerBasicDetails({})) return true;
            continue;
        }
        if (serializeOwnerBasicDetails(prevOwner) !== serializeOwnerBasicDetails(nextOwner)) {
            return true;
        }
    }
    return false;
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
            isOwnersBasicDetailsModified(beforeOwners, updateData.owners) ||
            isOwnersPassportModified(beforeOwners, updateData.owners) ||
            isOwnersEmiratesIdModified(beforeOwners, updateData.owners)
        ) {
            return true;
        }
    }
    return false;
};

/**
 * Active profile (status Active): HR-queue card edits wait in pendingReactivationChanges.
 * Inactive / draft profile: returns false so updates apply immediately without HR approval.
 */
export const shouldTriggerCompanyReactivation = (beforeCompany = {}, updateData = {}) => {
    if (!isActiveCompanyProfile(beforeCompany)) {
        return false;
    }
    return updateDataTouchesHrApprovalCards(beforeCompany, updateData);
};

export const syncCompanyStatus = async (companyId) => {
    const Company = (await import("../models/Company.js")).default;
    const { loadCompanyFullProfile } = await import("../services/companyPartitionService.js");
    const company = await Company.findById(companyId);
    if (!company) return;

    const full = await loadCompanyFullProfile(company);

    // Active profile or previously HR-approved: never demote to Inactive when cards are edited.
    // Status stays Active through reactivation / hold / pending-queue cycles.
    const keepActiveProfile =
        isActiveCompanyProfile(full) ||
        isCompanyFullyActivated(full) ||
        companyWasEverFullyActivated(full);

    if (keepActiveProfile) {
        if (company.status !== "Active") {
            company.status = "Active";
            await company.save();
        }
        return;
    }

    // Draft / not yet HR-approved: never promote to Active from card progress alone.
    // First-time activation requires Submit + HR approval (approveCompanyActivationRequest).
    if (company.status !== "Inactive") {
        company.status = "Inactive";
        await company.save();
    }
};

