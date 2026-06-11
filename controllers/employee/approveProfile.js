import EmployeeBasic from "../../models/EmployeeBasic.js";
import EmployeeMedicalInsurance from "../../models/EmployeeMedicalInsurance.js";
import EmployeeDrivingLicense from "../../models/EmployeeDrivingLicense.js";
import EmployeeEmiratesId from "../../models/EmployeeEmiratesId.js";
import EmployeeLabourCard from "../../models/EmployeeLabourCard.js";
import EmployeePassport from "../../models/EmployeePassport.js";
import EmployeeVisa from "../../models/EmployeeVisa.js";
import EmployeeEducation from "../../models/EmployeeEducation.js";
import EmployeeExperience from "../../models/EmployeeExperience.js";
import EmployeeTraining from "../../models/EmployeeTraining.js";
import EmployeeEmergencyContact from "../../models/EmployeeEmergencyContact.js";
import User from "../../models/User.js";
import { getCompleteEmployee, saveEmployeeData } from "../../services/employeeService.js";
import { sendProfileNotification } from "../../utils/sendProfileNotification.js";
import {
    archiveQueuedEmployeeSectionPreviousIfNeeded,
    archiveEmployeeSignaturePreviousIfNeeded,
    employeeDocumentWasSuperseded,
} from "../../utils/archiveEmployeeDocument.js";
import { shouldArchiveEmployeeDocumentOnRenewal } from "../../utils/employeeDocumentRenewal.js";
import {
    documentStorageFingerprint,
    purgeEmployeeOldDocuments,
    PURGE_TYPES,
} from "../../utils/purgeEmployeeOldDocuments.js";
import {
    archiveSalaryIncrementIfNeeded,
    purgeSalaryOldDocumentsUnlessIncrement,
} from "../../utils/archiveSupersededSalaryOnIncrement.js";
import { archiveSupersededBankIfNeeded, bankUpdateTouchesFields } from "../../utils/archiveSupersededBankIfNeeded.js";
import { isEmployeeProfileActivationDesignatedHr } from "../../utils/isEmployeeProfileActivationDesignatedHr.js";
import { applyEmployeeLeftUserStatus, isLeftUserStatus } from "../../utils/applyEmployeeLeftUserStatus.js";
import { closeLeftUserDashboardTasks } from "../../utils/employeeLeftUserWorkflow.js";
import {
    pendingEntryIncludedInSubmittedCards,
    resolveLatestActivationSubmissionLabels,
} from "../../utils/companyActivation.js";
import { mapPendingReactivationEntriesWithIds } from "../../utils/pendingReactivationEntryId.js";
import { resolveFlowchartHrEmployee } from "../../utils/resolveFlowchartHrEmployee.js";
import { notifyHrProfileActivationRequestEmail } from "../../utils/notifyHrProfileActivationRequestEmail.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import {
    removePrematureRenewalArchiveFromBasic,
    revertAllPendingEmployeeChanges,
    revertSinglePendingEmployeeChange,
} from "../../utils/revertPendingEmployeeProfileChange.js";
import { withdrawEmployeeActivationSubmissionIfQueueEmpty } from "../../utils/reconcileEmployeeActivationAfterEmptyQueue.js";

export const approveProfile = async (req, res) => {
    const { id } = req.params;
    const approvedChangeIds = Array.isArray(req.body?.approvedChangeIds) ? req.body.approvedChangeIds.map(String) : [];
    const selectionProvided = req.body?.selectionProvided === true;
    /** HR “Review Activation” direct path: any approval status; apply every queued card then set profile active (server checks designated HR). */
    const directHrBypass = req.body?.directHrBypass === true;
    /** Admin only: clear the pending queue without applying any proposed changes. */
    const rejectAllPending = req.body?.rejectAllPending === true;

    try {
        // Get employeeId from employee record
        const employee = await getCompleteEmployee(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;
        const isAdminUser = await isReqUserAdmin(req.user);

        if (rejectAllPending) {
            if (!directHrBypass || !isAdminUser) {
                return res.status(403).json({
                    message: "Only an administrator can reject all pending changes without applying them.",
                });
            }

            const basicDoc = await EmployeeBasic.findOne({ employeeId });
            if (!basicDoc) {
                return res.status(404).json({ message: "Employee not found" });
            }

            if (Array.isArray(basicDoc.pendingReactivationChanges) && basicDoc.pendingReactivationChanges.length > 0) {
                const pendingPlain = basicDoc.pendingReactivationChanges.map((entry) =>
                    typeof entry?.toObject === "function" ? entry.toObject() : { ...entry }
                );
                await revertAllPendingEmployeeChanges(employeeId, basicDoc, pendingPlain);
            }

            basicDoc.pendingReactivationChanges = [];
            basicDoc.markModified("pendingReactivationChanges");

            const profileStatus = String(basicDoc.profileStatus || "inactive").toLowerCase();
            const profileWasActive = profileStatus === "active";
            const approvalWasSubmitted = String(basicDoc.profileApprovalStatus || "").toLowerCase() === "submitted";
            const hasSubmissionMeta = Boolean(
                approvalWasSubmitted ||
                    basicDoc.profileSubmittedTo ||
                    basicDoc.profileActivationSubmittedBy ||
                    basicDoc.profileActivationDraftEditor ||
                    basicDoc.profileActivationHold,
            );

            if (hasSubmissionMeta) {
                basicDoc.profileApprovalStatus = profileWasActive ? "active" : "draft";
                basicDoc.profileSubmittedTo = undefined;
                basicDoc.profileActivationSubmittedBy = undefined;
                basicDoc.profileActivationDraftEditor = undefined;
                basicDoc.profileActivationHold = undefined;
                basicDoc.markModified("profileActivationHold");
                if (Array.isArray(basicDoc.profileWorkflow)) {
                    let workflowTouched = false;
                    for (const step of basicDoc.profileWorkflow) {
                        if (String(step?.status || "").toLowerCase() === "submitted") {
                            step.status = "rejected";
                            step.actionedAt = new Date();
                            step.comment = "Administrator rejected all pending changes without applying updates.";
                            workflowTouched = true;
                        }
                    }
                    if (workflowTouched) {
                        basicDoc.markModified("profileWorkflow");
                    }
                }
            }

            await basicDoc.save();

            await withdrawEmployeeActivationSubmissionIfQueueEmpty(basicDoc, {
                actionedBy: req.user?.employeeObjectId || req.user?._id || null,
            });

            const completeEmployee = await getCompleteEmployee(employeeId);
            delete completeEmployee.password;

            return res.status(200).json({
                message: "All pending changes were rejected and removed from the queue. No profile updates were applied.",
                employee: completeEmployee,
            });
        }

        const canActAsHr = await isEmployeeProfileActivationDesignatedHr(req, employee);
        if (directHrBypass) {
            if (!canActAsHr) {
                return res.status(403).json({
                    message:
                        "Only designated HR (Flowchart HR or the assigned reviewer), an administrator, or a user with Employees (Edit) can activate before Send for Activation. Others must use Send for Activation so HR receives the request.",
                });
            }
        } else if (employee.profileApprovalStatus === "submitted") {
            if (!canActAsHr) {
                return res.status(403).json({
                    message:
                        "Only designated HR or an administrator can approve this activation request after it has been submitted for review.",
                });
            }
        }

        if (!directHrBypass && employee.profileApprovalStatus !== "submitted") {
            return res.status(400).json({
                message:
                    "Profile must be submitted for HR review before it can be activated. Use Send for Activation first.",
            });
        }

        const updated = await EmployeeBasic.findOne({ employeeId });

        if (!updated) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const pendingChanges = Array.isArray(updated.pendingReactivationChanges)
            ? updated.pendingReactivationChanges
            : [];
        const hasExplicitSelection = selectionProvided === true;

        const sortedChanges = mapPendingReactivationEntriesWithIds(pendingChanges).map(({ entry, id }) => {
            const o = entry?.toObject ? entry.toObject() : entry;
            return { ...o, __applyId: id };
        });

        const submissionLabels = resolveLatestActivationSubmissionLabels(updated.profileWorkflow || []);
        const reviewRows =
            directHrBypass || submissionLabels.length === 0
                ? sortedChanges
                : sortedChanges.filter((entry) =>
                      pendingEntryIncludedInSubmittedCards(entry, submissionLabels),
                  );
        const reviewRowIds = reviewRows.map((entry) => entry.__applyId);
        const selectionScopeRows = directHrBypass ? sortedChanges : reviewRows;
        const approvedIdSet = new Set(approvedChangeIds.map(String));

        if (directHrBypass && hasExplicitSelection && sortedChanges.length > 0 && approvedIdSet.size === 0) {
            return res.status(400).json({
                message: "Select at least one change to apply.",
            });
        }

        /** HR full activation after submission: every row in this submission must be approved or sent back via hold. */
        if (hasExplicitSelection && reviewRowIds.length > 0 && !directHrBypass) {
            const missingScopeIds = reviewRowIds.filter((rowId) => !approvedIdSet.has(String(rowId)));
            if (missingScopeIds.length > 0) {
                return res.status(400).json({
                    message:
                        "Activation requires approving every pending change in this submission, or send corrections back when only some sections are acceptable.",
                });
            }
        }

        const changesToApply = hasExplicitSelection
            ? selectionScopeRows.filter((entry) => approvedIdSet.has(String(entry.__applyId)))
            : directHrBypass
              ? []
              : sortedChanges;

        for (const change of changesToApply) {
            if (String(change?.section || "").toLowerCase() !== "documents") continue;
            const changeType = String(change?.changeType || "").toLowerCase();
            const targetIndex = Number.isInteger(change?.targetIndex) ? change.targetIndex : null;

            if (!Array.isArray(updated.documents)) updated.documents = [];

            if (changeType === "add" && change?.proposedData) {
                updated.documents.push(change.proposedData);
                continue;
            }

            if (changeType === "update" && targetIndex !== null && change?.proposedData) {
                if (updated.documents[targetIndex]) {
                    const currentDoc = updated.documents[targetIndex];
                    const plainCurrent = currentDoc?.toObject ? currentDoc.toObject() : { ...currentDoc };
                    const hasExistingDocument = Boolean(
                        plainCurrent?.document?.url ||
                            plainCurrent?.document?.data ||
                            plainCurrent?.expiryDate,
                    );
                    const shouldArchivePrevious =
                        change?.isRenewal === true &&
                        Boolean(plainCurrent?.expiryDate) &&
                        shouldArchiveEmployeeDocumentOnRenewal({
                            isRenewal: true,
                            hasExistingDocument,
                        });
                    if (shouldArchivePrevious) {
                        updated.oldDocuments = Array.isArray(updated.oldDocuments) ? updated.oldDocuments : [];
                        updated.oldDocuments.push({
                            ...plainCurrent,
                            archivedAt: new Date(),
                            archiveReason: "Replaced",
                            createdAt: plainCurrent.createdAt || null,
                        });
                    }
                    updated.documents[targetIndex] = change.proposedData;
                }
                continue;
            }

            if (changeType === "delete" && targetIndex !== null) {
                const deletingDoc = updated.documents[targetIndex];
                if (deletingDoc) {
                    const docType = deletingDoc.type || "Document";
                    const fp = documentStorageFingerprint(deletingDoc.document);
                    updated.documents.splice(targetIndex, 1);
                    await purgeEmployeeOldDocuments(employeeId, {
                        types: [docType],
                        documentFingerprints: [fp],
                        purgeDeletedArchiveReason: true,
                    });
                }
            }
        }
        for (const change of changesToApply) {
            const section = String(change?.section || "").toLowerCase();
            if (!["medicalinsurance", "drivinglicense", "emiratesid", "labourcard", "passport", "visa", "basicdetails", "workdetails", "education", "experience", "training", "emergencycontact", "signature"].includes(section)) continue;
            const proposedData = change?.proposedData || null;
            if (!proposedData) continue;

            if (section === "medicalinsurance") {
                await archiveQueuedEmployeeSectionPreviousIfNeeded({
                    employeeId,
                    section,
                    previousData: change.previousData,
                    proposedData,
                    isRenewal: change?.isRenewal === true,
                });
                await EmployeeMedicalInsurance.findOneAndUpdate(
                    { employeeId },
                    { $set: { medicalInsurance: proposedData } },
                    { upsert: true, new: true }
                );
                continue;
            }
            if (section === "drivinglicense") {
                await archiveQueuedEmployeeSectionPreviousIfNeeded({
                    employeeId,
                    section,
                    previousData: change.previousData,
                    proposedData,
                    isRenewal: change?.isRenewal === true,
                });
                await EmployeeDrivingLicense.findOneAndUpdate(
                    { employeeId },
                    { $set: { drivingLicenceDetails: proposedData } },
                    { upsert: true, new: true }
                );
                continue;
            }
            if (section === "emiratesid") {
                await archiveQueuedEmployeeSectionPreviousIfNeeded({
                    employeeId,
                    section,
                    previousData: change.previousData,
                    proposedData,
                    isRenewal: change?.isRenewal === true,
                });
                await EmployeeEmiratesId.findOneAndUpdate(
                    { employeeId },
                    { $set: { emiratesId: proposedData } },
                    { upsert: true, new: true }
                );
                continue;
            }
            if (section === "labourcard") {
                await archiveQueuedEmployeeSectionPreviousIfNeeded({
                    employeeId,
                    section,
                    previousData: change.previousData,
                    proposedData,
                    isRenewal: change?.isRenewal === true,
                });
                await EmployeeLabourCard.findOneAndUpdate(
                    { employeeId },
                    { $set: { labourCard: proposedData } },
                    { upsert: true, new: true }
                );
                if (proposedData?.issueDate) {
                    const contractDate = new Date(proposedData.issueDate);
                    if (!Number.isNaN(contractDate.getTime())) {
                        await EmployeeBasic.updateOne(
                            { employeeId },
                            { $set: { contractJoiningDate: contractDate } },
                        );
                    }
                }
                continue;
            }
            if (section === "passport") {
                await archiveQueuedEmployeeSectionPreviousIfNeeded({
                    employeeId,
                    section,
                    previousData: change.previousData,
                    proposedData,
                    isRenewal: change?.isRenewal === true,
                });
                await EmployeePassport.findOneAndUpdate(
                    { employeeId },
                    proposedData,
                    { upsert: true, new: true }
                );
                continue;
            }
            if (section === "visa") {
                const visaType = String(proposedData?.visaType || "").trim();
                if (visaType) {
                    await archiveQueuedEmployeeSectionPreviousIfNeeded({
                        employeeId,
                        section,
                        previousData: change.previousData,
                        proposedData,
                        isRenewal: change?.isRenewal === true,
                    });
                    const visaPayload = { ...proposedData };
                    delete visaPayload.visaType;
                    await EmployeeVisa.findOneAndUpdate(
                        { employeeId },
                        { $set: { [visaType]: visaPayload } },
                        { upsert: true, new: true }
                    );
                    const replacedVisaType = String(
                        change?.replacedVisaType || change?.previousData?.visaType || "",
                    ).trim();
                    if (replacedVisaType && replacedVisaType !== visaType) {
                        await EmployeeVisa.updateOne({ employeeId }, { $unset: { [replacedVisaType]: "" } });
                    }
                }
                continue;
            }
            if (section === "basicdetails" || section === "workdetails") {
                let salaryIncrementResult = { isIncrement: false };
                if (
                    section === "basicdetails" &&
                    Object.prototype.hasOwnProperty.call(proposedData, "salaryHistory")
                ) {
                    salaryIncrementResult = await archiveSalaryIncrementIfNeeded(employeeId, proposedData);
                }
                if (section === "basicdetails" && bankUpdateTouchesFields(proposedData)) {
                    await archiveSupersededBankIfNeeded(
                        employeeId,
                        proposedData,
                        change?.previousData || null,
                    );
                }
                await saveEmployeeData(employeeId, proposedData);
                if (
                    section === "basicdetails" &&
                    (Object.prototype.hasOwnProperty.call(proposedData, "salaryHistory") ||
                        Object.prototype.hasOwnProperty.call(proposedData, "basic") ||
                        Object.prototype.hasOwnProperty.call(proposedData, "offerLetter"))
                ) {
                    await purgeSalaryOldDocumentsUnlessIncrement(employeeId, {
                        isIncrement: salaryIncrementResult.isIncrement,
                    });
                }
                if (section === "workdetails" && isLeftUserStatus(proposedData?.status)) {
                    const basicDoc = await EmployeeBasic.findOne({ employeeId });
                    if (basicDoc) await applyEmployeeLeftUserStatus(basicDoc);
                    try {
                        await closeLeftUserDashboardTasks({
                            employeeMongoId: updated._id,
                            status: "Approved",
                            actionedBy: req.user?.employeeObjectId || req.user?._id,
                        });
                    } catch (syncErr) {
                        console.error("[ApproveProfile] Left User dashboard sync:", syncErr);
                    }
                } else if (section === "workdetails" && Object.prototype.hasOwnProperty.call(proposedData, "companyEmail")) {
                    await User.findOneAndUpdate(
                        { employeeId },
                        { $set: { companyEmail: proposedData.companyEmail } }
                    );
                }
                continue;
            }
            if (section === "education") {
                if (String(change?.changeType || "").toLowerCase() === "add") {
                    await EmployeeEducation.findOneAndUpdate(
                        { employeeId },
                        { $push: { educationDetails: proposedData } },
                        { upsert: true, new: true }
                    );
                } else {
                    const educationId = proposedData?.educationId;
                    if (educationId) {
                        const updateDoc = { ...proposedData };
                        delete updateDoc.educationId;
                        await EmployeeEducation.updateOne(
                            { employeeId, "educationDetails._id": educationId },
                            { $set: Object.fromEntries(Object.entries(updateDoc).map(([k, v]) => [`educationDetails.$.${k}`, v])) }
                        );
                    }
                }
                continue;
            }
            if (section === "experience") {
                if (String(change?.changeType || "").toLowerCase() === "add") {
                    await EmployeeExperience.findOneAndUpdate(
                        { employeeId },
                        { $push: { experienceDetails: proposedData } },
                        { upsert: true, new: true }
                    );
                } else {
                    const experienceId = proposedData?.experienceId;
                    if (experienceId) {
                        const updateDoc = { ...proposedData };
                        delete updateDoc.experienceId;
                        await EmployeeExperience.updateOne(
                            { employeeId, "experienceDetails._id": experienceId },
                            { $set: Object.fromEntries(Object.entries(updateDoc).map(([k, v]) => [`experienceDetails.$.${k}`, v])) }
                        );
                    }
                }
                continue;
            }
            if (section === "training") {
                const changeType = String(change?.changeType || "").toLowerCase();
                if (changeType === "add") {
                    await EmployeeTraining.findOneAndUpdate(
                        { employeeId },
                        { $push: { trainingDetails: proposedData } },
                        { upsert: true, new: true }
                    );
                } else if (changeType === "update") {
                    const trainingId = proposedData?.trainingId;
                    if (trainingId) {
                        const updateDoc = { ...proposedData };
                        delete updateDoc.trainingId;
                        await EmployeeTraining.updateOne(
                            { employeeId, "trainingDetails._id": trainingId },
                            { $set: Object.fromEntries(Object.entries(updateDoc).map(([k, v]) => [`trainingDetails.$.${k}`, v])) }
                        );
                    }
                } else if (changeType === "delete") {
                    const trainingId = proposedData?.trainingId;
                    if (trainingId) {
                        await EmployeeTraining.updateOne(
                            { employeeId },
                            { $pull: { trainingDetails: { _id: trainingId } } }
                        );
                    }
                }
                continue;
            }
            if (section === "emergencycontact") {
                const changeType = String(change?.changeType || "").toLowerCase();
                if (changeType === "add") {
                    await EmployeeEmergencyContact.findOneAndUpdate(
                        { employeeId },
                        { $push: { emergencyContacts: proposedData } },
                        { upsert: true, new: true }
                    );
                } else if (changeType === "update") {
                    const contactId = proposedData?.contactId;
                    if (contactId) {
                        const updateDoc = { ...proposedData };
                        delete updateDoc.contactId;
                        await EmployeeEmergencyContact.updateOne(
                            { employeeId, "emergencyContacts._id": contactId },
                            { $set: Object.fromEntries(Object.entries(updateDoc).map(([k, v]) => [`emergencyContacts.$.${k}`, v])) }
                        );
                    }
                } else if (changeType === "delete") {
                    const contactId = proposedData?.contactId;
                    if (contactId) {
                        await EmployeeEmergencyContact.updateOne(
                            { employeeId },
                            { $pull: { emergencyContacts: { _id: contactId } } }
                        );
                    }
                }
                const e = await EmployeeEmergencyContact.findOne({ employeeId });
                if (e) {
                    const primary = e.emergencyContacts?.[0];
                    e.emergencyContactName = primary?.name || '';
                    e.emergencyContactRelation = primary?.relation || '';
                    e.emergencyContactNumber = primary?.number || '';
                    await e.save();
                }
                continue;
            }
            if (section === "signature") {
                const changeType = String(change?.changeType || "").toLowerCase();
                if (changeType === "delete") {
                    await EmployeeBasic.updateOne({ employeeId }, { $set: { signature: null } });
                } else {
                    await archiveEmployeeSignaturePreviousIfNeeded({
                        employeeId,
                        previousSignature: change.previousData,
                    });
                    await EmployeeBasic.updateOne({ employeeId }, { $set: { signature: proposedData } });
                }
            }
        }

        const appliedIds = new Set(changesToApply.map((entry) => entry.__applyId));
        const scopedIdSet = new Set(selectionScopeRows.map((entry) => String(entry.__applyId)));

        if (directHrBypass && hasExplicitSelection) {
            for (const entry of selectionScopeRows) {
                if (!appliedIds.has(String(entry.__applyId))) {
                    await revertSinglePendingEmployeeChange(employeeId, updated, entry);
                }
            }
        }

        updated.pendingReactivationChanges = sortedChanges
            .filter((entry) => {
                const entryId = String(entry.__applyId);
                if (appliedIds.has(entryId)) return false;
                if (directHrBypass && hasExplicitSelection && scopedIdSet.has(entryId)) return false;
                return true;
            })
            .map(({ __applyId, ...rest }) => rest);
        updated.markModified("pendingReactivationChanges");

        updated.profileApprovalStatus = "active";
        updated.profileStatus = "active";
        if (!Array.isArray(updated.profileWorkflow)) updated.profileWorkflow = [];
        updated.profileWorkflow = updated.profileWorkflow.map((step) => {
            if (String(step?.status || "").toLowerCase() === "submitted") {
                step.status = "active";
                step.actionedAt = new Date();
            }
            return step;
        });
        const activationSubmitterId = updated.profileActivationSubmittedBy || null;

        await updated.save();
        await EmployeeBasic.updateOne(
            { employeeId },
            {
                $unset: {
                    profileActivationHold: 1,
                    profileActivationSubmittedBy: 1,
                    profileActivationDraftEditor: 1,
                },
            },
        );

        // Close every open dashboard row for this activation (HR Pending + submitter On Hold, any assignee).
        try {
            const DashboardAction = (await import("../../models/DashboardAction.js")).default;
            await DashboardAction.updateMany(
                {
                    requestId: updated._id,
                    requestType: "Profile Activation",
                    status: { $in: ["Pending", "On Hold"] },
                },
                {
                    status: "Approved",
                    actionedDate: new Date(),
                    actionedBy: req.user?.employeeObjectId || req.user?._id,
                    comment: "",
                },
            );
        } catch (syncErr) {
            console.error("[ApproveProfile] Dashboard Sync Error:", syncErr);
        }

        // Get complete employee data for response
        const completeEmployee = await getCompleteEmployee(employeeId);

        const recipientForActivationEmail = activationSubmitterId
            ? await EmployeeBasic.findById(activationSubmitterId)
                  .select("firstName lastName employeeId companyEmail workEmail email personalEmail primaryReportee")
                  .populate("primaryReportee", "firstName lastName companyEmail workEmail email")
                  .lean()
            : null;

        // Trigger Email Notification (Background)
        const manager = req.user; // The person who approved
        sendProfileNotification({
            employee: completeEmployee,
            recipientEmployee: recipientForActivationEmail,
            manager: manager,
            status: 'active'
        }).catch(err => console.error("Async Email Error:", err));

        if (directHrBypass && (await isReqUserAdmin(req.user))) {
            const hrResolved = await resolveFlowchartHrEmployee();
            if (!hrResolved.error && hrResolved.email) {
                const appliedCards = [...new Set(changesToApply.map((x) => String(x?.card || "").trim()).filter(Boolean))];
                const employeeName =
                    `${completeEmployee.firstName || ""} ${completeEmployee.lastName || ""}`.trim() || "Employee";
                const hrName =
                    `${hrResolved.employee?.firstName || ""} ${hrResolved.employee?.lastName || ""}`.trim() || "HR";
                const submitterName =
                    req.user?.name ||
                    [req.user?.firstName, req.user?.lastName].filter(Boolean).join(" ").trim() ||
                    "Administrator";
                const wasPreviouslyActive = Array.isArray(completeEmployee.profileWorkflow)
                    ? completeEmployee.profileWorkflow.some((w) => String(w?.status || "").toLowerCase() === "active")
                    : false;
                notifyHrProfileActivationRequestEmail({
                    hrEmail: hrResolved.email,
                    hrName,
                    employeeName,
                    employeeId: completeEmployee.employeeId,
                    activationTypeLabel: wasPreviouslyActive ? "Reactivation" : "New Activation",
                    pendingCardsText: appliedCards.join(", "),
                    pendingChanges: changesToApply,
                    submitterName,
                    isAdminSubmitter: true,
                    adminDirectApplied: true,
                    reason: "Administrator applied profile changes directly",
                    description: "Changes are now live on the employee profile. No HR approval action is required.",
                    req,
                }).catch((err) => console.error("[ApproveProfile] Admin direct HR notify error:", err));
            }
        }

        delete completeEmployee.password;

        return res.status(200).json({
            message: directHrBypass
                ? "Profile changes applied successfully."
                : "Employee profile marked as approved.",
            employee: completeEmployee
        });
    } catch (error) {
        console.error("Failed to approve profile:", error);
        return res.status(500).json({ message: error.message || "Failed to approve profile." });
    }
};


