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

export const approveProfile = async (req, res) => {
    const { id } = req.params;
    const approvedChangeIds = Array.isArray(req.body?.approvedChangeIds) ? req.body.approvedChangeIds.map(String) : [];
    const selectionProvided = req.body?.selectionProvided === true;

    try {
        // Get employeeId from employee record
        const employee = await getCompleteEmployee(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;
        const submittedToAssigneeId = employee.profileSubmittedTo;

        if (employee.profileApprovalStatus !== "submitted") {
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
        const hasExplicitSelection = selectionProvided;

        const sortedChanges = pendingChanges
            .map((entry, idx) => {
                const o = entry?.toObject ? entry.toObject() : entry;
                return { ...o, __applyId: String(o?._id || idx) };
            })
            .sort((a, b) => new Date(a?.changedAt || 0) - new Date(b?.changedAt || 0));

        const allApplyIds = sortedChanges.map((e) => e.__applyId);
        if (hasExplicitSelection) {
            const allApprovedPresent = allApplyIds.length > 0 && allApplyIds.every((xid) => approvedChangeIds.includes(xid));
            const countsMatch =
                approvedChangeIds.length === allApplyIds.length &&
                [...approvedChangeIds].sort().join(",") === [...allApplyIds].sort().join(",");
            if (!allApprovedPresent || !countsMatch) {
                return res.status(400).json({
                    message:
                        "Activation requires approving every pending change listed, or use Hold if only some sections are acceptable.",
                });
            }
        }

        const changesToApply = sortedChanges.filter((entry) => {
            if (!hasExplicitSelection) return true;
            return approvedChangeIds.includes(entry.__applyId);
        });

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
                    updated.oldDocuments = Array.isArray(updated.oldDocuments) ? updated.oldDocuments : [];
                    const currentDoc = updated.documents[targetIndex];
                    updated.oldDocuments.push({
                        ...currentDoc.toObject(),
                        archivedAt: new Date(),
                        archiveReason: "Replaced",
                        createdAt: currentDoc.createdAt || null,
                    });
                    updated.documents[targetIndex] = change.proposedData;
                }
                continue;
            }

            if (changeType === "delete" && targetIndex !== null) {
                const deletingDoc = updated.documents[targetIndex];
                if (deletingDoc) {
                    updated.oldDocuments = Array.isArray(updated.oldDocuments) ? updated.oldDocuments : [];
                    updated.oldDocuments.push({
                        ...deletingDoc.toObject(),
                        archivedAt: new Date(),
                        archiveReason: "Deleted",
                        createdAt: deletingDoc.createdAt || null,
                    });
                    updated.documents.splice(targetIndex, 1);
                }
            }
        }
        for (const change of changesToApply) {
            const section = String(change?.section || "").toLowerCase();
            if (!["medicalinsurance", "drivinglicense", "emiratesid", "labourcard", "passport", "visa", "basicdetails", "workdetails", "education", "experience", "training", "emergencycontact", "signature"].includes(section)) continue;
            const proposedData = change?.proposedData || null;
            if (!proposedData) continue;

            if (section === "medicalinsurance") {
                await EmployeeMedicalInsurance.findOneAndUpdate(
                    { employeeId },
                    { $set: { medicalInsurance: proposedData } },
                    { upsert: true, new: true }
                );
                continue;
            }
            if (section === "drivinglicense") {
                await EmployeeDrivingLicense.findOneAndUpdate(
                    { employeeId },
                    { $set: { drivingLicenceDetails: proposedData } },
                    { upsert: true, new: true }
                );
                continue;
            }
            if (section === "emiratesid") {
                await EmployeeEmiratesId.findOneAndUpdate(
                    { employeeId },
                    { $set: { emiratesId: proposedData } },
                    { upsert: true, new: true }
                );
                continue;
            }
            if (section === "labourcard") {
                await EmployeeLabourCard.findOneAndUpdate(
                    { employeeId },
                    { $set: { labourCard: proposedData } },
                    { upsert: true, new: true }
                );
                continue;
            }
            if (section === "passport") {
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
                    const visaPayload = { ...proposedData };
                    delete visaPayload.visaType;
                    await EmployeeVisa.findOneAndUpdate(
                        { employeeId },
                        { $set: { [visaType]: visaPayload } },
                        { upsert: true, new: true }
                    );
                }
                continue;
            }
            if (section === "basicdetails" || section === "workdetails") {
                await saveEmployeeData(employeeId, proposedData);
                if (section === "workdetails" && Object.prototype.hasOwnProperty.call(proposedData, "companyEmail")) {
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
                    await EmployeeBasic.updateOne({ employeeId }, { $set: { signature: proposedData } });
                }
            }
        }

        updated.profileApprovalStatus = "active";
        updated.profileStatus = "active";
        updated.pendingReactivationChanges = [];
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
            { $unset: { profileActivationHold: 1, profileActivationSubmittedBy: 1 } },
        );

        // === SYNC DASHBOARD ACTION ===
        try {
            const { syncDashboardAction } = await import("../../utils/syncDashboard.js");
            await syncDashboardAction({
                requestId: updated._id,
                requestType: "Profile Activation",
                status: "Approved",
                assignedTo: submittedToAssigneeId ? String(submittedToAssigneeId) : undefined,
                subjectEmployee: updated,
                requestedByName: req.user?.name || "",
                actionedBy: req.user?.employeeObjectId || req.user?._id,
            });
        } catch (syncErr) {
            console.error("[ApproveProfile] Dashboard Sync Error:", syncErr);
        }

        try {
            const DashboardAction = (await import("../../models/DashboardAction.js")).default;
            await DashboardAction.updateMany(
                { requestId: updated._id, requestType: "Profile Activation", status: "On Hold" },
                {
                    status: "Approved",
                    actionedDate: new Date(),
                    actionedBy: req.user?.employeeObjectId || req.user?._id,
                    comment: "",
                },
            );
        } catch (_clearErr) {
            /* non-fatal */
        }

        // Get complete employee data for response
        const completeEmployee = await getCompleteEmployee(employeeId);

        const recipientForActivationEmail = activationSubmitterId
            ? await EmployeeBasic.findById(activationSubmitterId)
                  .select("firstName lastName employeeId companyEmail workEmail email personalEmail")
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

        delete completeEmployee.password;

        return res.status(200).json({
            message: "Employee profile marked as approved.",
            employee: completeEmployee
        });
    } catch (error) {
        console.error("Failed to approve profile:", error);
        return res.status(500).json({ message: error.message || "Failed to approve profile." });
    }
};


