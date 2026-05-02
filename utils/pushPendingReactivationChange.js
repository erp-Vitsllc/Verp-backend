import EmployeeBasic from "../models/EmployeeBasic.js";
import { shouldQueueProfileChange, triggerProfileReactivationIfNeeded } from "./triggerProfileReactivation.js";

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
 * Submitted → push only (no workflow reset).
 * Reactivation draft → full trigger with optional changeEntry.
 * Otherwise → live path already ran; notify default profile edit tracking.
 */
export async function queueOrTriggerProfileChange({ employeeId, actor, reason, employeeBasic, changeEntry }) {
    const submitted = awaitingSubmittedHrOnly(employeeBasic);
    const needsReactivationQueue = shouldQueueProfileChange(employeeBasic);

    if (submitted) {
        if (changeEntry) await pushPendingReactivationChange(employeeId, changeEntry);
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
