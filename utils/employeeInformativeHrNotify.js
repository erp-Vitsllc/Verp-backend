import EmployeeBasic from "../models/EmployeeBasic.js";
import {
    buildEmployeeProfileSectionUrl,
    isActiveEmployeeProfile,
    isInformativeEmployeeSectionKey,
    notifyFlowchartHrOfProfileFileChanges,
    resolveFileLinkEntries,
    scheduleFlowchartHrProfileFileChangeEmail,
} from "./profileFileChangeHrNotify.js";
import { shouldSkipLiveEmployeeSection } from "./pushPendingReactivationChange.js";

/**
 * Notify Flowchart HR when a non-activation employee file section changes on an active profile
 * and the change was saved live (not queued for activation HR review).
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
}) {
    const eid = String(employeeId || employeeBasic?.employeeId || "").trim();
    const section = String(sectionKey || "").trim();
    if (!eid || !section || !isInformativeEmployeeSectionKey(section)) {
        return { sent: false, reason: "SKIPPED_SECTION" };
    }
    if (skipLive) return { sent: false, reason: "QUEUED_FOR_ACTIVATION" };

    let basic = employeeBasic;
    if (!basic?._id && eid) {
        basic = await EmployeeBasic.findOne({ employeeId: eid })
            .select("employeeId firstName lastName profileStatus company")
            .lean();
    }
    if (!isActiveEmployeeProfile(basic)) return { sent: false, reason: "NOT_ACTIVE" };

    const profileUrl = buildEmployeeProfileSectionUrl(eid, section);
    const files = await resolveFileLinkEntries(attachments);

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
            },
        ],
        actor,
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
}) {
    let basic = employeeBasic;
    if (!basic && employeeId) {
        basic = await EmployeeBasic.findOne({ employeeId })
            .select("employeeId firstName lastName profileStatus profileApprovalStatus profileWorkflow company")
            .lean();
    }
    const liveSkipped =
        skipLive == null ? shouldSkipLiveEmployeeSection(basic, sectionKey) : Boolean(skipLive);
    scheduleEmployeeProfileFileChangeHrEmail({
        employeeBasic: basic,
        employeeId: employeeId || basic?.employeeId,
        sectionKey,
        sectionLabel,
        action: isRenewal ? "renewed" : action,
        attachments,
        actor,
        skipLive: liveSkipped,
    });
}
