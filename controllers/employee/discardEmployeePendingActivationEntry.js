import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { resolveProfileActivationSubmitterEmployee } from "../../utils/resolveProfileActivationSubmitterEmployee.js";
import { mapPendingReactivationEntriesWithIds } from "../../utils/pendingReactivationEntryId.js";
import { revertSinglePendingEmployeeChange } from "../../utils/revertPendingEmployeeProfileChange.js";
import { clearProfileActivationHoldDashboardRows } from "../../utils/clearProfileActivationHoldDashboardRows.js";
import { withdrawEmployeeActivationSubmissionIfQueueEmpty } from "../../utils/reconcileEmployeeActivationAfterEmptyQueue.js";

/**
 * Submitter removes one held pending change — restores live card from previousData when applicable
 * and drops premature renewal archives that were never HR-approved.
 */
export const discardEmployeePendingActivationEntry = async (req, res) => {
    try {
        const { id, entryId } = req.params;
        const entryIdStr = String(entryId || "").trim();
        if (!entryIdStr) {
            return res.status(400).json({ message: "Entry id is required." });
        }

        const employeeOverview = await getCompleteEmployee(id);
        if (!employeeOverview) {
            return res.status(404).json({ message: "Employee not found." });
        }

        const employeeId = employeeOverview.employeeId;
        const doc = await EmployeeBasic.findOne({ employeeId });
        if (!doc) {
            return res.status(404).json({ message: "Employee not found." });
        }

        const hold = doc.profileActivationHold;
        if (!hold?.unapprovedEntryIds?.length) {
            return res.status(400).json({ message: "No activation hold is active for this employee." });
        }

        const pending = mapPendingReactivationEntriesWithIds(doc.pendingReactivationChanges || []);
        const target = pending.find((row) => row.id === entryIdStr);
        if (!target) {
            return res.status(404).json({ message: "Pending change entry not found." });
        }

        const unapprovedSet = new Set((hold.unapprovedEntryIds || []).map(String));
        if (!unapprovedSet.has(entryIdStr)) {
            return res.status(400).json({ message: "This entry is not in the current hold list." });
        }

        const DashboardAction = (await import("../../models/DashboardAction.js")).default;
        const pendingRows = await DashboardAction.find({
            requestId: doc._id,
            requestType: "Profile Activation",
            status: { $in: ["Pending", "On Hold"] },
        })
            .lean()
            .maxTimeMS(6000);

        const submitterEmp = await resolveProfileActivationSubmitterEmployee(doc, pendingRows);
        const viewerEmpId = String(req.user?.employeeObjectId || "");
        const submitterId = String(doc.profileActivationSubmittedBy || "");
        const isSubmitter =
            (submitterEmp?._id && String(submitterEmp._id) === viewerEmpId) ||
            (submitterId && submitterId === viewerEmpId);
        if (!isSubmitter) {
            return res.status(403).json({ message: "Only the activation submitter can remove this pending update." });
        }

        const changePlain =
            typeof target.entry?.toObject === "function" ? target.entry.toObject() : { ...(target.entry || {}) };

        await revertSinglePendingEmployeeChange(employeeId, doc, changePlain);
        if (doc.isModified("oldDocuments") || doc.isModified("documents")) {
            await doc.save();
        }

        const nextPending = pending
            .filter((row) => row.id !== entryIdStr)
            .map(({ entry }) => (typeof entry?.toObject === "function" ? entry.toObject() : { ...entry }));

        unapprovedSet.delete(entryIdStr);
        const resolvedIds = (hold.resolvedEntryIds || []).map(String).filter((x) => x !== entryIdStr);
        const rowNotes =
            hold.rowNotesByEntryId && typeof hold.rowNotesByEntryId === "object"
                ? { ...hold.rowNotesByEntryId }
                : {};
        delete rowNotes[entryIdStr];

        doc.pendingReactivationChanges = nextPending;
        doc.markModified("pendingReactivationChanges");

        if (unapprovedSet.size === 0) {
            doc.profileActivationHold = undefined;
            doc.markModified("profileActivationHold");
            await doc.save();
            try {
                await clearProfileActivationHoldDashboardRows(doc._id);
            } catch (syncErr) {
                console.error("[discardEmployeePendingActivationEntry] clear hold rows:", syncErr);
            }
        } else {
            const remainingUnapproved = pending.filter((row) => unapprovedSet.has(row.id));
            const unapprovedCards = [
                ...new Set(remainingUnapproved.map((row) => String(row.entry?.card || "").trim()).filter(Boolean)),
            ];
            doc.profileActivationHold = {
                ...hold,
                unapprovedEntryIds: [...unapprovedSet],
                unapprovedCards: unapprovedCards.length
                    ? unapprovedCards
                    : [...unapprovedSet].map((_, i) => `Change ${i + 1}`),
                resolvedEntryIds: resolvedIds,
                rowNotesByEntryId: rowNotes,
            };
            doc.markModified("profileActivationHold");
            await doc.save();
        }

        const queueEmptyOnDoc =
            !Array.isArray(doc.pendingReactivationChanges) || doc.pendingReactivationChanges.length === 0;

        if (queueEmptyOnDoc) {
            await withdrawEmployeeActivationSubmissionIfQueueEmpty(doc, {
                actionedBy: req.user?.employeeObjectId || req.user?._id || null,
            });
        }

        let fresh = await getCompleteEmployee(employeeId);
        if (fresh) delete fresh.password;

        const queueEmpty =
            !Array.isArray(fresh?.pendingReactivationChanges) || fresh.pendingReactivationChanges.length === 0;

        return res.status(200).json({
            message: queueEmpty
                ? "Pending update removed. Live profile restored where applicable. Activation queue is empty."
                : "Pending update removed. Live profile restored where applicable.",
            employee: fresh,
            activationQueueEmpty: queueEmpty,
        });
    } catch (error) {
        console.error("discardEmployeePendingActivationEntry:", error);
        return res.status(500).json({ message: error.message || "Failed to remove pending update." });
    }
};
