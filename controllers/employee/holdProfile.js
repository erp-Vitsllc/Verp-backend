import EmployeeBasic from "../../models/EmployeeBasic.js";
import { sanitizeActivationHoldRowNotes } from "../../utils/sanitizeActivationHoldRowNotes.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { syncDashboardAction } from "../../utils/syncDashboard.js";
import { sendProfileActivationHoldEmail } from "../../utils/sendProfileActivationHoldEmail.js";
import { applyApprovedPendingProfileChanges } from "../../utils/applyApprovedPendingProfileChanges.js";

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

        const isAdminOrHR = req.user && (/admin|root/i.test(req.user.role || "") || req.user.isAdmin === true || /hr/i.test(req.user.role || "") || /hr|admin|root/i.test(req.user.groupName || ""));

        if (employeeOverview.profileApprovalStatus !== "submitted" && !isAdminOrHR) {
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

        const allIds = entriesWithIds.map((e) => e.__idStr);

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

        if (approvedChangeIds.length >= allIds.length) {
            return res.status(400).json({
                message:
                    "All pending changes are selected as accepted — use Activate instead of Hold. Uncheck at least one row to place those items back with the employee.",
            });
        }

        const approved = new Set(approvedChangeIds);
        const approvedEntries = entriesWithIds.filter((e) => approved.has(e.__idStr));
        const unapprovedEntries = entriesWithIds.filter((e) => !approved.has(e.__idStr));

        const unapprovedCards = [...new Set(unapprovedEntries.map((e) => String(e.sub?.card || "").trim()).filter(Boolean))];
        const rowNotesByEntryId = sanitizeActivationHoldRowNotes(
            req.body?.rowNotesByEntryId,
            unapprovedEntries.map((e) => e.__idStr),
        );

        /** Apply HR-approved queue rows immediately (live card data). */
        if (approvedEntries.length > 0) {
            const changesPlain = approvedEntries.map(({ sub }) =>
                typeof sub?.toObject === "function" ? sub.toObject() : { ...(sub || {}) },
            );
            await applyApprovedPendingProfileChanges(employeeId, doc, changesPlain);

            approvedEntries.forEach(({ sub }) => {
                if (sub?._id) {
                    doc.pendingReactivationChanges.pull(sub._id);
                }
            });
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

        const submitterForNotify = doc.profileActivationSubmittedBy
            ? await EmployeeBasic.findById(doc.profileActivationSubmittedBy)
                  .select("_id employeeId firstName lastName designation companyEmail workEmail email personalEmail")
                  .lean()
            : null;

        const outcomeExtra1 = `[Employee profile] On hold — update: ${(doc.profileActivationHold.unapprovedCards || []).join(", ")}`;

        await syncDashboardAction({
            requestId: doc._id,
            requestType: "Profile Activation",
            assignedTo: String(doc.profileSubmittedTo || ""),
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
            submitterEmployee: submitterForNotify,
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
