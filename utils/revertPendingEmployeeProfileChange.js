import EmployeeMedicalInsurance from "../models/EmployeeMedicalInsurance.js";
import EmployeeDrivingLicense from "../models/EmployeeDrivingLicense.js";
import EmployeeEmiratesId from "../models/EmployeeEmiratesId.js";
import EmployeeLabourCard from "../models/EmployeeLabourCard.js";
import EmployeePassport from "../models/EmployeePassport.js";
import EmployeeVisa from "../models/EmployeeVisa.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import { saveEmployeeData } from "../services/employeeService.js";
import { documentStorageFingerprint } from "./purgeEmployeeOldDocuments.js";

const norm = (s) => String(s || "").toLowerCase().trim();

const archiveTypeMatchesSection = (rowType, section) => {
    const t = norm(rowType);
    const sec = norm(section);
    if (sec === "passport") return t.includes("passport");
    if (sec === "emiratesid") return t.includes("emirates");
    if (sec === "labourcard") return t.includes("labour");
    if (sec === "medicalinsurance") return t.includes("medical");
    if (sec === "drivinglicense") return t.includes("driving");
    if (sec === "visa") return t.includes("visa");
    if (sec === "signature") return t.includes("signature");
    return false;
};

/**
 * Remove a premature "Replaced" archive created when a renewal was queued but not HR-approved.
 * Keeps archives from completed renewals (live card already updated).
 */
export function removePrematureRenewalArchiveFromBasic(basicDoc, change, { appliedToLive = false } = {}) {
    if (!basicDoc || change?.isRenewal !== true || appliedToLive) return false;
    if (!Array.isArray(basicDoc.oldDocuments) || basicDoc.oldDocuments.length === 0) return false;

    const section = norm(change.section);
    const previousData = change.previousData && typeof change.previousData === "object" ? change.previousData : null;
    const prevFp = documentStorageFingerprint(previousData?.document);
    const prevContractFp = documentStorageFingerprint(previousData?.labourContractAttachment);

    const keep = [];
    let removedCard = false;
    let removedContract = false;

    for (const row of basicDoc.oldDocuments) {
        const reason = String(row?.archiveReason || "");
        const rowType = norm(row?.type || "");
        const rowFp = documentStorageFingerprint(row?.document);

        if (reason !== "Replaced" || !archiveTypeMatchesSection(rowType, section)) {
            keep.push(row);
            continue;
        }

        if (section === "labourcard" && rowType.includes("contract")) {
            if (!removedContract && prevContractFp && rowFp === prevContractFp) {
                removedContract = true;
                continue;
            }
            if (!removedContract && !prevContractFp && rowType.includes("labour contract")) {
                removedContract = true;
                continue;
            }
        } else if (!removedCard) {
            if (prevFp && rowFp === prevFp) {
                removedCard = true;
                continue;
            }
            if (!prevFp && !rowType.includes("contract")) {
                removedCard = true;
                continue;
            }
        }

        keep.push(row);
    }

    if (keep.length !== basicDoc.oldDocuments.length) {
        basicDoc.oldDocuments = keep;
        basicDoc.markModified("oldDocuments");
        return true;
    }
    return false;
}

/**
 * Restore live profile sections from a pending change's previousData (undo queue / HR decline).
 */
export async function revertSinglePendingEmployeeChange(employeeId, basicDoc, change) {
    if (!employeeId || !change) return { restored: false };

    const section = norm(change.section);
    const previousData = change.previousData;
    const changeType = norm(change.changeType);
    const targetIndex = Number.isInteger(change.targetIndex) ? change.targetIndex : null;

    if (section === "documents") {
        if (!basicDoc || !previousData) return { restored: false };
        if (changeType === "update" && targetIndex !== null && Array.isArray(basicDoc.documents)) {
            if (basicDoc.documents[targetIndex]) {
                basicDoc.documents[targetIndex] = previousData;
                basicDoc.markModified("documents");
                removePrematureRenewalArchiveFromBasic(basicDoc, change);
                return { restored: true };
            }
        }
        if (changeType === "add" && targetIndex !== null && Array.isArray(basicDoc.documents)) {
            basicDoc.documents.splice(targetIndex, 1);
            basicDoc.markModified("documents");
            return { restored: true };
        }
        if (changeType === "delete" && previousData && Array.isArray(basicDoc.documents)) {
            basicDoc.documents.splice(targetIndex ?? basicDoc.documents.length, 0, previousData);
            basicDoc.markModified("documents");
            return { restored: true };
        }
        return { restored: false };
    }

    if (!previousData || typeof previousData !== "object") {
        removePrematureRenewalArchiveFromBasic(basicDoc, change);
        return { restored: false };
    }

    if (section === "medicalinsurance") {
        await EmployeeMedicalInsurance.findOneAndUpdate(
            { employeeId },
            { $set: { medicalInsurance: previousData } },
            { upsert: true, new: true },
        );
    } else if (section === "drivinglicense") {
        await EmployeeDrivingLicense.findOneAndUpdate(
            { employeeId },
            { $set: { drivingLicenceDetails: previousData } },
            { upsert: true, new: true },
        );
    } else if (section === "emiratesid") {
        await EmployeeEmiratesId.findOneAndUpdate(
            { employeeId },
            { $set: { emiratesId: previousData } },
            { upsert: true, new: true },
        );
    } else if (section === "labourcard") {
        await EmployeeLabourCard.findOneAndUpdate(
            { employeeId },
            { $set: { labourCard: previousData } },
            { upsert: true, new: true },
        );
    } else if (section === "passport") {
        await EmployeePassport.findOneAndUpdate({ employeeId }, previousData, { upsert: true, new: true });
    } else if (section === "visa") {
        const visaType = String(previousData?.visaType || change.proposedData?.visaType || "").trim();
        if (visaType) {
            const visaPayload = { ...previousData };
            delete visaPayload.visaType;
            await EmployeeVisa.findOneAndUpdate(
                { employeeId },
                { $set: { [visaType]: visaPayload } },
                { upsert: true, new: true },
            );
        }
    } else if (section === "basicdetails" || section === "workdetails") {
        await saveEmployeeData(employeeId, previousData);
    } else if (section === "signature") {
        await EmployeeBasic.updateOne({ employeeId }, { $set: { signature: previousData } });
    } else {
        return { restored: false };
    }

    if (basicDoc) {
        removePrematureRenewalArchiveFromBasic(basicDoc, change);
    }

    return { restored: true };
}

export async function revertAllPendingEmployeeChanges(employeeId, basicDoc, changes = []) {
    const list = Array.isArray(changes) ? changes : [];
    let count = 0;
    for (const change of list) {
        const result = await revertSinglePendingEmployeeChange(employeeId, basicDoc, change);
        if (result.restored) count += 1;
    }
    if (basicDoc?.isModified?.("oldDocuments")) {
        await basicDoc.save();
    }
    return { revertedCount: count };
}
