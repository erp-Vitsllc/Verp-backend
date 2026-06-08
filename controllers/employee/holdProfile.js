import EmployeeBasic from "../../models/EmployeeBasic.js";
import { sanitizeActivationHoldRowNotes } from "../../utils/sanitizeActivationHoldRowNotes.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { syncDashboardAction } from "../../utils/syncDashboard.js";
import { sendProfileActivationHoldEmail } from "../../utils/sendProfileActivationHoldEmail.js";
import { resolveProfileActivationSubmitterEmployee } from "../../utils/resolveProfileActivationSubmitterEmployee.js";
import { applyApprovedPendingProfileChanges } from "../../utils/applyApprovedPendingProfileChanges.js";
import { isEmployeeProfileActivationDesignatedHr } from "../../utils/isEmployeeProfileActivationDesignatedHr.js";
import {
    pendingEntryIncludedInSubmittedCards,
    resolveLatestActivationSubmissionLabels,
} from "../../utils/companyActivation.js";

const idStrSub = (sub, idx) => String(sub._id ?? idx);

/**
 * Partial HR review: keep profile submitted + inactive; record which change cards need employee fixes.
 * HR-checked rows are applied immediately; unchecked rows stay in pending + profileActivationHold.
 */
export const holdProfile = async (req, res) => {
    const { id } = req.params;
    const approvedChangeIds = Array.isArray(req.body?.approvedChangeIds) ? req.body.approvedChangeIds.map(String) : [];
    const selectionProvided = req.body?.selectionProvided === true;
    const comment = String(req.body?.comment || "").trim();

    try {
        const employeeOverview = await getCompleteEmployee(id);
        if (!employeeOverview) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employeeOverview.employeeId;

        if (!(await isEmployeeProfileActivationDesignatedHr(req, employeeOverview))) {
            return res.status(403).json({
                message: "Only designated HR or an administrator can place activation on hold.",
            });
        }

        if (employeeOverview.profileApprovalStatus !== "submitted") {
            return res.status(400).json({
                message: "Profile must be submitted for HR review before it can be placed on hold.",
            });
        }

        const doc = await EmployeeBasic.findOne({ employeeId });
        if (!doc) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const sortedSubs = [...(doc.pendingReactivationChanges || [])].sort(
            (a, b) => new Date(a?.changedAt || 0) - new Date(b?.changedAt || 0),
        );

        const entriesWithIds = sortedSubs.map((sub, idx) => ({
            sub,
            __idStr: idStrSub(sub, idx),
        }));

        const submissionLabels = resolveLatestActivationSubmissionLabels(doc.profileWorkflow || []);
        const reviewEntries =
            submissionLabels.length > 0
                ? entriesWithIds.filter(({ sub }) =>
                      pendingEntryIncludedInSubmittedCards(sub, submissionLabels),
                  )
                : entriesWithIds;

        const allIds = reviewEntries.map((e) => e.__idStr);

        if (!selectionProvided) {
            return res.status(400).json({
                message: "Provide which queued changes HR accepts now (checked rows); unchecked rows return to the employee.",
            });
        }

        /** Empty — entire queue stays with employee after hold metadata. */
        if (approvedChangeIds.length > 0) {
            const invalid = [...approvedChangeIds].filter((x) => !allIds.includes(String(x)));
            if (invalid.length) {
                return res.status(400).json({ message: "Approved selection contains unknown change ids." });
            }
        }

        if (allIds.length > 0 && approvedChangeIds.length >= allIds.length) {
            return res.status(400).json({
                message:
                    "All changes in this submission are selected as accepted — use OK with every row checked to fully approve. Uncheck at least one row to send corrections back to the submitter.",
            });
        }

        const approved = new Set(approvedChangeIds);
        const approvedEntries = reviewEntries.filter((e) => approved.has(e.__idStr));
        const unapprovedEntries = reviewEntries.filter((e) => !approved.has(e.__idStr));

        const unapprovedCards = [...new Set(unapprovedEntries.map((e) => String(e.sub?.card || "").trim()).filter(Boolean))];

        const rawRowNotes = req.body?.rowNotesByEntryId;
        for (const { __idStr } of unapprovedEntries) {
            const t =
                rawRowNotes && typeof rawRowNotes === "object"
                    ? String(rawRowNotes[__idStr] ?? rawRowNotes[String(__idStr)] ?? "").trim()
                    : "";
            if (!t) {
                return res.status(400).json({
                    message:
                        "Instructions are required for every unchecked change row before activation can be placed on hold.",
                });
            }
        }

        const rowNotesByEntryId = sanitizeActivationHoldRowNotes(
            rawRowNotes,
            unapprovedEntries.map((e) => e.__idStr),
        );

        /** Apply HR-approved queue rows immediately (live card data). */
        if (approvedEntries.length > 0) {
            const changesPlain = approvedEntries.map(({ sub }) =>
                typeof sub?.toObject === "function" ? sub.toObject() : { ...(sub || {}) },
            );
            await applyApprovedPendingProfileChanges(employeeId, doc, changesPlain);

            const approvedIdStrSet = new Set(approvedEntries.map((e) => e.__idStr));
            doc.pendingReactivationChanges = (doc.pendingReactivationChanges || []).filter(
                (sub, idx) => !approvedIdStrSet.has(idStrSub(sub, idx)),
            );
            doc.markModified("pendingReactivationChanges");
        }

        doc.profileApprovalStatus = "submitted";
        doc.profileStatus = "inactive";

        const nextUnapprovedIds = [...(doc.pendingReactivationChanges || [])].map((e, idx) =>
            String(e._id ?? idx),
        );

        doc.profileActivationHold = {
            heldAt: new Date(),
            unapprovedEntryIds: nextUnapprovedIds,
            unapprovedCards:
                unapprovedCards.length ? unapprovedCards : unapprovedEntries.map((_, i) => `Change ${i + 1}`),
            resolvedEntryIds: [],
            comment: comment || "",
            ...(rowNotesByEntryId ? { rowNotesByEntryId } : {}),
        };

        await doc.save();

        const subjectLean = await EmployeeBasic.findOne({ employeeId })
            .select("_id employeeId firstName lastName designation companyEmail workEmail email personalEmail")
            .lean();

        const DashboardAction = (await import("../../models/DashboardAction.js")).default;
        const pendingRowsForSubmitter = await DashboardAction.find({
            requestId: doc._id,
            requestType: "Profile Activation",
            status: { $in: ["Pending", "On Hold"] },
        })
            .lean()
            .maxTimeMS(6000);

        const submitterForNotify = await resolveProfileActivationSubmitterEmployee(
            doc,
            pendingRowsForSubmitter,
        );

        let submitterForEmail = submitterForNotify;
        if (submitterForNotify?._id) {
            submitterForEmail = await EmployeeBasic.findById(submitterForNotify._id)
                .select("_id employeeId firstName lastName designation companyEmail workEmail email personalEmail primaryReportee")
                .populate("primaryReportee", "firstName lastName companyEmail workEmail email")
                .lean();
        }

        const outcomeExtra1 = `[Employee profile] On hold — update: ${(doc.profileActivationHold.unapprovedCards || []).join(", ")}`;

        await syncDashboardAction({
            requestId: doc._id,
            requestType: "Profile Activation",
            assignedTo: String(submitterForNotify?._id || doc.profileSubmittedTo || ""),
            status: "On Hold",
            skipPendingCompletion: true,
            subjectEmployee: subjectLean || doc,
            profileActivationNotifyAssignee: submitterForNotify || undefined,
            requestedByName: req.user?.name || "",
            actionedBy: req.user?.employeeObjectId || req.user?._id,
            comment: comment || unapprovedCards.join(", "),
            extra1: outcomeExtra1,
            extra3: JSON.stringify({ activationSubject: "employee", activationViewerRole: "submitter" }),
        });

        if (doc.profileSubmittedTo) {
            try {
                const DashboardAction = (await import("../../models/DashboardAction.js")).default;
                await DashboardAction.deleteMany({
                    requestId: doc._id,
                    requestType: "Profile Activation",
                    status: "Pending",
                    assignedTo: doc.profileSubmittedTo,
                });
            } catch (_e) {
                /* non-fatal */
            }
        }

        const completeForEmail = await getCompleteEmployee(employeeId);

        const holdNotesMap = rowNotesByEntryId || {};
        const holdLineItems = unapprovedEntries.map(({ __idStr, sub }) => ({
            cardLabel: String(sub?.card || "").trim() || `Change (${__idStr})`,
            note: holdNotesMap[__idStr] || "",
        }));
        sendProfileActivationHoldEmail({
            subjectEmployee: completeForEmail,
            submitterEmployee: submitterForEmail,
            hrManager: req.user,
            unapprovedCards: doc.profileActivationHold.unapprovedCards || [],
            holdLineItems,
            comment: doc.profileActivationHold.comment || "",
        }).catch(() => {});

        const fresh = await getCompleteEmployee(employeeId);
        if (fresh) delete fresh.password;

        return res.status(200).json({
            message:
                "Profile activation placed on hold. Checked rows were saved; unchecked items remain for the employee. Notifications were sent.",
            employee: fresh,
        });
    } catch (error) {
        console.error("holdProfile:", error);
        return res.status(500).json({ message: error.message || "Failed to hold profile activation." });
    }
};
