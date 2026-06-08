import EmployeeBasic from "../models/EmployeeBasic.js";
import { EMPLOYEE_ACTIVATION_SECTION_KEYS } from "./profileFileChangeHrNotify.js";
import { shouldQueueProfileChange, triggerProfileReactivationIfNeeded } from "./triggerProfileReactivation.js";

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

/** Reactivation (ever active) OR submitted-for-activation: queue-only, no live writes. */
export function skipLiveProfileWritesPendingHr(employeeBasic) {
    if (!employeeBasic) return false;
    if (awaitingSubmittedHrOnly(employeeBasic)) return true;
    return shouldQueueProfileChange(employeeBasic);
}

/**
 * Progress-bar / HR-approval sections queue on active profiles; other cards save live
 * and trigger informative HR email only (no dashboard task).
 */
export function shouldSkipLiveEmployeeSection(employeeBasic, sectionKey = "") {
    if (!employeeBasic) return false;
    if (awaitingSubmittedHrOnly(employeeBasic)) return true;
    if (!shouldQueueProfileChange(employeeBasic)) return false;
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

/**
 * Submitted → push only (no workflow reset).
 * Reactivation draft → full trigger with optional changeEntry.
 * Otherwise → live path already ran; notify default profile edit tracking.
 */
export async function queueOrTriggerProfileChange({ employeeId, actor, reason, employeeBasic, changeEntry }) {
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
