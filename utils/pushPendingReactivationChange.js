import EmployeeBasic from "../models/EmployeeBasic.js";
import Company from "../models/Company.js";
import { isActiveCompanyProfile } from "./companyActivation.js";
import { isRequestUserDesignatedFlowchartHr } from "./isDesignatedFlowchartHr.js";
import { EMPLOYEE_ACTIVATION_SECTION_KEYS } from "./profileFileChangeHrNotify.js";
import { shouldQueueProfileChange, triggerProfileReactivationIfNeeded } from "./triggerProfileReactivation.js";
import { resolvePortalActorId } from "./resolvePortalActorId.js";

const norm = (s) => String(s || "").toLowerCase().trim();

/** One logical queue row per section (and per visa subtype). */
export function pendingChangeDedupeKey(entry) {
    if (!entry || typeof entry !== "object") return "";
    const sec = norm(entry.section);
    if (sec === "visa") {
        const pd = entry.proposedData && typeof entry.proposedData === "object" ? entry.proposedData : {};
        const prev = entry.previousData && typeof entry.previousData === "object" ? entry.previousData : {};
        const vt = norm(pd.visaType || prev.visaType);
        if (vt) return `visa::${vt}`;
    }
    if (sec) return `section::${sec}`;
    const card = norm(entry.card);
    const ct = norm(entry.changeType);
    return `card::${card}::${ct}`;
}

/** Employee is waiting on HR for activation / hold — edits must not touch live collections until HR checks rows on Activate/Hold. */
export function awaitingSubmittedHrOnly(employeeBasic) {
    return String(employeeBasic?.profileApprovalStatus || "").toLowerCase() === "submitted";
}

/** @deprecated Only designated Flowchart HR may bypass the activation queue — not admins. */
export function isActorHrOrAdmin() {
    return false;
}

/** Profile is live-active — mandatory card edits queue for HR instead of writing collections. */
export function isEmployeeProfileLiveActiveForHrQueue(employeeBasic = {}) {
    const profileStatus = String(employeeBasic?.profileStatus || "inactive").toLowerCase();
    const profileApprovalStatus = String(employeeBasic?.profileApprovalStatus || "draft").toLowerCase();
    return profileStatus === "active" && profileApprovalStatus === "active";
}

export async function isEmployeeCompanyActive(employeeBasic = {}) {
    const companyId = employeeBasic?.company;
    if (!companyId) return false;
    const company = await Company.findById(companyId).select("status").lean();
    return isActiveCompanyProfile(company || {});
}

/** Only the Flowchart HR contact may edit activation cards live on an active company. */
export async function shouldBypassEmployeeActivationHrQueue(req) {
    return isRequestUserDesignatedFlowchartHr(req);
}

function employeeProfileNeedsActivationHrQueue(employeeBasic = {}) {
    if (awaitingSubmittedHrOnly(employeeBasic)) return true;
    return isEmployeeProfileLiveActiveForHrQueue(employeeBasic);
}

/**
 * Active company + active/submitted employee profile: queue mandatory card edits for HR.
 * Admins follow the same queue — only designated Flowchart HR applies live.
 */
export async function skipLiveProfileWritesPendingHrAsync(req, employeeBasic) {
    if (!employeeBasic) return false;
    if (await shouldBypassEmployeeActivationHrQueue(req)) return false;
    if (!(await isEmployeeCompanyActive(employeeBasic))) return false;
    return employeeProfileNeedsActivationHrQueue(employeeBasic);
}

/**
 * Progress-bar / HR-approval sections queue on active company profiles; other cards save live.
 */
export async function shouldSkipLiveEmployeeSectionAsync(req, employeeBasic, sectionKey = "") {
    if (!employeeBasic) return false;
    if (await shouldBypassEmployeeActivationHrQueue(req)) return false;
    if (!(await isEmployeeCompanyActive(employeeBasic))) return false;
    if (!employeeProfileNeedsActivationHrQueue(employeeBasic)) return false;
    return EMPLOYEE_ACTIVATION_SECTION_KEYS.has(String(sectionKey || "").trim());
}

/** @deprecated Use skipLiveProfileWritesPendingHrAsync — sync path no longer bypasses admin. */
export function skipLiveProfileWritesPendingHr(employeeBasic) {
    if (!employeeBasic) return false;
    return employeeProfileNeedsActivationHrQueue(employeeBasic);
}

/** @deprecated Use shouldSkipLiveEmployeeSectionAsync. */
export function shouldSkipLiveEmployeeSection(employeeBasic, sectionKey = "") {
    if (!employeeBasic) return false;
    if (!employeeProfileNeedsActivationHrQueue(employeeBasic)) return false;
    return EMPLOYEE_ACTIVATION_SECTION_KEYS.has(String(sectionKey || "").trim());
}

/**
 * Append one pending change without changing profileApprovalStatus / profileStatus
 * (avoids demoting "submitted" → "draft" on every save while HR review is open).
 */
export async function pushPendingReactivationChange(employeeId, changeEntry) {
    if (!employeeId || !changeEntry || typeof changeEntry !== "object") return;

    const toSerializable = (value) => {
        if (value === undefined) return undefined;
        if (value === null) return null;
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (_e) {
            return value;
        }
    };

    const normalizedEntry = {
        ...changeEntry,
        previousData: toSerializable(changeEntry.previousData),
        proposedData: toSerializable(changeEntry.proposedData),
        changedAt: changeEntry.changedAt || new Date(),
    };

    await EmployeeBasic.updateOne({ employeeId }, { $push: { pendingReactivationChanges: normalizedEntry } });
}

/**
 * While profile is submitted for HR: append pending change but replace any existing queue row
 * with the same dedupe key (e.g. two "employment" visa rows → one after re-save).
 * Keeps profileActivationHold.unapprovedEntryIds in sync when pulled rows were on hold.
 */
export async function pushPendingReactivationChangeReplaceByDedupeKey(employeeId, changeEntry) {
    if (!employeeId || !changeEntry || typeof changeEntry !== "object") return;

    const toSerializable = (value) => {
        if (value === undefined) return undefined;
        if (value === null) return null;
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (_e) {
            return value;
        }
    };

    const normalizedEntry = {
        ...changeEntry,
        previousData: toSerializable(changeEntry.previousData),
        proposedData: toSerializable(changeEntry.proposedData),
        changedAt: changeEntry.changedAt || new Date(),
    };

    const newKey = pendingChangeDedupeKey(normalizedEntry);
    if (!newKey) {
        await pushPendingReactivationChange(employeeId, normalizedEntry);
        return;
    }

    if (newKey.startsWith("section::")) {
        const sectionToken = newKey.slice("section::".length);
        const escaped = sectionToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        await EmployeeBasic.updateOne(
            { employeeId },
            {
                $pull: {
                    pendingReactivationChanges: {
                        section: { $regex: `^${escaped}$`, $options: "i" },
                    },
                },
            },
        );
        await EmployeeBasic.updateOne(
            { employeeId },
            { $push: { pendingReactivationChanges: normalizedEntry } },
        );
        return;
    }

    const doc = await EmployeeBasic.findOne({ employeeId }).select("pendingReactivationChanges profileActivationHold");
    if (!doc) {
        await pushPendingReactivationChange(employeeId, normalizedEntry);
        return;
    }

    const pulledIdStrings = new Set();
    const subs = doc.pendingReactivationChanges || [];
    for (let i = subs.length - 1; i >= 0; i--) {
        const sub = subs[i];
        const plain = typeof sub.toObject === "function" ? sub.toObject() : { ...sub };
        if (pendingChangeDedupeKey(plain) !== newKey) continue;
        if (sub._id) pulledIdStrings.add(String(sub._id));
        subs.splice(i, 1);
    }

    doc.pendingReactivationChanges.push(normalizedEntry);
    doc.markModified("pendingReactivationChanges");
    const last = doc.pendingReactivationChanges[doc.pendingReactivationChanges.length - 1];
    const newIdStr = last?._id ? String(last._id) : "";

    const hold = doc.profileActivationHold;
    if (hold && Array.isArray(hold.unapprovedEntryIds) && newIdStr) {
        const holdSet = new Set(hold.unapprovedEntryIds.map(String));
        const affectedHold = [...pulledIdStrings].some((pid) => holdSet.has(pid));
        let nextUn = hold.unapprovedEntryIds.map(String).filter((id) => !pulledIdStrings.has(id));
        if (affectedHold && !nextUn.includes(newIdStr)) {
            nextUn.push(newIdStr);
        }
        hold.unapprovedEntryIds = [...new Set(nextUn)];
        if (Array.isArray(hold.resolvedEntryIds)) {
            hold.resolvedEntryIds = hold.resolvedEntryIds.map(String).filter((id) => !pulledIdStrings.has(id));
        }
        doc.markModified("profileActivationHold");
    }

    await doc.save();
}

export async function queueOrTriggerProfileChange({ employeeId, actor, reason, employeeBasic, changeEntry }) {
    // Check if profile is already active
    const isProfileActive = String(employeeBasic?.profileStatus || "").toLowerCase() === "active";

    if (isProfileActive) {
        // Active profile: mandatory cards queue in pendingReactivationChanges until Submit + HR approval.
        if (changeEntry) {
            await pushPendingReactivationChangeReplaceByDedupeKey(employeeId, changeEntry);
        }
        const editorId = resolvePortalActorId(actor);
        if (editorId) {
            await EmployeeBasic.updateOne(
                { employeeId },
                { $set: { profileActivationDraftEditor: editorId } },
            );
        }
        return;
    }

    const submitted = awaitingSubmittedHrOnly(employeeBasic);
    const needsReactivationQueue = shouldQueueProfileChange(employeeBasic);

    if (submitted) {
        if (changeEntry) await pushPendingReactivationChangeReplaceByDedupeKey(employeeId, changeEntry);
        return;
    }
    if (needsReactivationQueue) {
        await triggerProfileReactivationIfNeeded({
            employeeId,
            actor,
            reason,
            changeEntry: changeEntry || null,
        });
        return;
    }
    await triggerProfileReactivationIfNeeded({
        employeeId,
        actor,
        reason,
        changeEntry: changeEntry || null,
        trackDefaultChange: true,
    });
}
