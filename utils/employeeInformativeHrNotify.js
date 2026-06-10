import EmployeeBasic from "../models/EmployeeBasic.js";
import { isReqUserAdmin } from "./sendAdminDeletionNotificationEmails.js";
import {
    buildEmployeeProfileSectionUrl,
    isActiveEmployeeProfile,
    isInformativeEmployeeSectionKey,
    notifyFlowchartHrOfProfileFileChanges,
    resolveFileLinkEntries,
    scheduleFlowchartHrProfileFileChangeEmail,
} from "./profileFileChangeHrNotify.js";
import { shouldSkipLiveEmployeeSectionAsync } from "./pushPendingReactivationChange.js";

/** Map not-renew request kind → profile section key for HR email deep links. */
export const EMPLOYEE_NOT_RENEW_KIND_TO_SECTION = {
    passport: "passport",
    visa: "visa",
    emiratesId: "emiratesId",
    labourCard: "labourCard",
    medicalInsurance: "medicalInsurance",
    drivingLicense: "drivingLicense",
    manualDocument: "documents",
};

/**
 * Notify Flowchart HR when an admin changes an employee profile card on an active profile.
 * Includes activation/progress-bar cards (passport, visa, labour card, etc.) and informative sections.
 */
export async function notifyHrOfEmployeeProfileFileChange({
    employeeBasic = null,
    employeeId = "",
    sectionKey = "",
    sectionLabel = "",
    action = "modified",
    attachments = [],
    actor = {},
    skipLive = false,
    details = null,
    req = null,
    frontendBaseUrl = null,
}) {
    const eid = String(employeeId || employeeBasic?.employeeId || "").trim();
    const section = String(sectionKey || "").trim();
    if (!eid || !section) {
        return { sent: false, reason: "MISSING_CONTEXT" };
    }

    const isAdminActor = await isReqUserAdmin(actor);
    if (!isAdminActor) {
        if (!isInformativeEmployeeSectionKey(section)) {
            return { sent: false, reason: "SKIPPED_SECTION" };
        }
        if (skipLive) return { sent: false, reason: "QUEUED_FOR_ACTIVATION" };
    }

    let basic = employeeBasic;
    if (!basic?._id && eid) {
        basic = await EmployeeBasic.findOne({ employeeId: eid })
            .select("employeeId firstName lastName profileStatus profileApprovalStatus company")
            .lean();
    }
    if (!isActiveEmployeeProfile(basic)) return { sent: false, reason: "NOT_ACTIVE" };

    const base = frontendBaseUrl || req?.frontendBaseUrl || null;
    const profileUrl = buildEmployeeProfileSectionUrl(eid, section, base);
    const attachmentList = Array.isArray(attachments) ? attachments : [attachments].filter(Boolean);
    const files = await resolveFileLinkEntries(attachmentList);

    return notifyFlowchartHrOfProfileFileChanges({
        entityType: "employee",
        entityLabel: `${basic?.firstName || ""} ${basic?.lastName || ""}`.trim() || eid,
        entityCode: eid,
        profileUrl,
        changes: [
            {
                sectionKey: section,
                sectionLabel: sectionLabel || section,
                action,
                profileUrl,
                files,
                queuedForActivation: Boolean(skipLive),
                details: details && typeof details === "object" ? details : undefined,
            },
        ],
        actor: { ...actor, isAdmin: true },
        req,
        frontendBaseUrl: base,
    });
}

export function scheduleEmployeeProfileFileChangeHrEmail(params = {}) {
    scheduleFlowchartHrProfileFileChangeEmail(async () => notifyHrOfEmployeeProfileFileChange(params));
}

/** Load employee basic + derive skipLive when omitted. */
export async function scheduleEmployeeProfileFileChangeHrEmailForRequest({
    employeeId,
    sectionKey,
    sectionLabel,
    action = "modified",
    attachments = [],
    actor = {},
    employeeBasic = null,
    skipLive = null,
    isRenewal = false,
    details = null,
    req = null,
    frontendBaseUrl = null,
}) {
    let basic = employeeBasic;
    if (!basic && employeeId) {
        basic = await EmployeeBasic.findOne({ employeeId })
            .select("employeeId firstName lastName profileStatus profileApprovalStatus profileWorkflow company")
            .lean();
    }
    const liveSkipped =
        skipLive == null
            ? await shouldSkipLiveEmployeeSectionAsync(req, basic, sectionKey)
            : Boolean(skipLive);
    scheduleEmployeeProfileFileChangeHrEmail({
        employeeBasic: basic,
        employeeId: employeeId || basic?.employeeId,
        sectionKey,
        sectionLabel,
        action: isRenewal ? "renewed" : action,
        attachments,
        actor,
        skipLive: liveSkipped,
        details,
        req,
        frontendBaseUrl: frontendBaseUrl || req?.frontendBaseUrl || null,
    });
}

/** Notify HR when an administrator marks a card as not renewed (applied immediately). */
export function scheduleAdminEmployeeCardNotRenewHrEmail({
    employeeId,
    employeeBasic = null,
    kind = "",
    sectionLabel = "",
    reason = "",
    attachments = [],
    actor = {},
    req = null,
    frontendBaseUrl = null,
}) {
    const sectionKey = EMPLOYEE_NOT_RENEW_KIND_TO_SECTION[kind] || "documents";
    scheduleEmployeeProfileFileChangeHrEmail({
        employeeBasic,
        employeeId,
        sectionKey,
        sectionLabel: sectionLabel || kind || "Document",
        action: "not_renewed",
        attachments,
        actor,
        skipLive: false,
        details: reason ? { description: reason } : null,
        req,
        frontendBaseUrl: frontendBaseUrl || req?.frontendBaseUrl || null,
    });
}
