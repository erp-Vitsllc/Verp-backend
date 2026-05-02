import EmployeeMedicalInsurance from "../models/EmployeeMedicalInsurance.js";
import EmployeeDrivingLicense from "../models/EmployeeDrivingLicense.js";
import EmployeeEmiratesId from "../models/EmployeeEmiratesId.js";
import EmployeeLabourCard from "../models/EmployeeLabourCard.js";
import EmployeePassport from "../models/EmployeePassport.js";
import EmployeeVisa from "../models/EmployeeVisa.js";
import EmployeeEducation from "../models/EmployeeEducation.js";
import EmployeeExperience from "../models/EmployeeExperience.js";
import EmployeeTraining from "../models/EmployeeTraining.js";
import EmployeeEmergencyContact from "../models/EmployeeEmergencyContact.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import User from "../models/User.js";
import { saveEmployeeData } from "../services/employeeService.js";

/**
 * Applies a subset of pendingReactivationChanges (HR-checked rows during partial hold).
 * Does not touch profileApprovalStatus / pending clearance / dashboard — callers own that.
 * @param {string} employeeId
 * @param {import('mongoose').Document} basicDoc mutable EmployeeBasic document
 * @param {object[]} changesToApply queued change payloads (/plain objects like pending entries)
 */
export async function applyApprovedPendingProfileChanges(employeeId, basicDoc, changesToApply) {
    if (!employeeId || !basicDoc || !Array.isArray(changesToApply) || changesToApply.length === 0) {
        return;
    }

    const updated = basicDoc;

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
        if (
            ![
                "medicalinsurance",
                "drivinglicense",
                "emiratesid",
                "labourcard",
                "passport",
                "visa",
                "basicdetails",
                "workdetails",
                "education",
                "experience",
                "training",
                "emergencycontact",
                "signature",
            ].includes(section)
        ) {
            continue;
        }
        const proposedData = change?.proposedData || null;
        if (!proposedData) continue;

        if (section === "medicalinsurance") {
            await EmployeeMedicalInsurance.findOneAndUpdate(
                { employeeId },
                { $set: { medicalInsurance: proposedData } },
                { upsert: true, new: true },
            );
            continue;
        }
        if (section === "drivinglicense") {
            await EmployeeDrivingLicense.findOneAndUpdate(
                { employeeId },
                { $set: { drivingLicenceDetails: proposedData } },
                { upsert: true, new: true },
            );
            continue;
        }
        if (section === "emiratesid") {
            await EmployeeEmiratesId.findOneAndUpdate(
                { employeeId },
                { $set: { emiratesId: proposedData } },
                { upsert: true, new: true },
            );
            continue;
        }
        if (section === "labourcard") {
            await EmployeeLabourCard.findOneAndUpdate(
                { employeeId },
                { $set: { labourCard: proposedData } },
                { upsert: true, new: true },
            );
            continue;
        }
        if (section === "passport") {
            await EmployeePassport.findOneAndUpdate({ employeeId }, proposedData, { upsert: true, new: true });
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
                    { upsert: true, new: true },
                );
            }
            continue;
        }
        if (section === "basicdetails" || section === "workdetails") {
            await saveEmployeeData(employeeId, proposedData);
            if (section === "workdetails" && Object.prototype.hasOwnProperty.call(proposedData, "companyEmail")) {
                await User.findOneAndUpdate(
                    { employeeId },
                    { $set: { companyEmail: proposedData.companyEmail } },
                );
            }
            continue;
        }
        if (section === "education") {
            if (String(change?.changeType || "").toLowerCase() === "add") {
                await EmployeeEducation.findOneAndUpdate(
                    { employeeId },
                    { $push: { educationDetails: proposedData } },
                    { upsert: true, new: true },
                );
            } else {
                const educationId = proposedData?.educationId;
                if (educationId) {
                    const updateDoc = { ...proposedData };
                    delete updateDoc.educationId;
                    await EmployeeEducation.updateOne(
                        { employeeId, "educationDetails._id": educationId },
                        { $set: Object.fromEntries(Object.entries(updateDoc).map(([k, v]) => [`educationDetails.$.${k}`, v])) },
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
                    { upsert: true, new: true },
                );
            } else {
                const experienceId = proposedData?.experienceId;
                if (experienceId) {
                    const updateDoc = { ...proposedData };
                    delete updateDoc.experienceId;
                    await EmployeeExperience.updateOne(
                        { employeeId, "experienceDetails._id": experienceId },
                        { $set: Object.fromEntries(Object.entries(updateDoc).map(([k, v]) => [`experienceDetails.$.${k}`, v])) },
                    );
                }
            }
            continue;
        }
        if (section === "training") {
            const ct = String(change?.changeType || "").toLowerCase();
            if (ct === "add") {
                await EmployeeTraining.findOneAndUpdate(
                    { employeeId },
                    { $push: { trainingDetails: proposedData } },
                    { upsert: true, new: true },
                );
            } else if (ct === "update") {
                const trainingId = proposedData?.trainingId;
                if (trainingId) {
                    const updateDoc = { ...proposedData };
                    delete updateDoc.trainingId;
                    await EmployeeTraining.updateOne(
                        { employeeId, "trainingDetails._id": trainingId },
                        { $set: Object.fromEntries(Object.entries(updateDoc).map(([k, v]) => [`trainingDetails.$.${k}`, v])) },
                    );
                }
            } else if (ct === "delete") {
                const trainingId = proposedData?.trainingId;
                if (trainingId) {
                    await EmployeeTraining.updateOne(
                        { employeeId },
                        { $pull: { trainingDetails: { _id: trainingId } } },
                    );
                }
            }
            continue;
        }
        if (section === "emergencycontact") {
            const ct = String(change?.changeType || "").toLowerCase();
            if (ct === "add") {
                await EmployeeEmergencyContact.findOneAndUpdate(
                    { employeeId },
                    { $push: { emergencyContacts: proposedData } },
                    { upsert: true, new: true },
                );
            } else if (ct === "update") {
                const contactId = proposedData?.contactId;
                if (contactId) {
                    const updateDoc = { ...proposedData };
                    delete updateDoc.contactId;
                    await EmployeeEmergencyContact.updateOne(
                        { employeeId, "emergencyContacts._id": contactId },
                        { $set: Object.fromEntries(Object.entries(updateDoc).map(([k, v]) => [`emergencyContacts.$.${k}`, v])) },
                    );
                }
            } else if (ct === "delete") {
                const contactId = proposedData?.contactId;
                if (contactId) {
                    await EmployeeEmergencyContact.updateOne(
                        { employeeId },
                        { $pull: { emergencyContacts: { _id: contactId } } },
                    );
                }
            }
            const e = await EmployeeEmergencyContact.findOne({ employeeId });
            if (e) {
                const primary = e.emergencyContacts?.[0];
                e.emergencyContactName = primary?.name || "";
                e.emergencyContactRelation = primary?.relation || "";
                e.emergencyContactNumber = primary?.number || "";
                await e.save();
            }
            continue;
        }
        if (section === "signature") {
            const ct = String(change?.changeType || "").toLowerCase();
            if (ct === "delete") {
                await EmployeeBasic.updateOne({ employeeId }, { $set: { signature: null } });
            } else {
                await EmployeeBasic.updateOne({ employeeId }, { $set: { signature: proposedData } });
            }
        }
    }

    updated.markModified?.("documents");
    updated.markModified?.("oldDocuments");
}
