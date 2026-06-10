import EmployeePassport from "../models/EmployeePassport.js";
import EmployeeVisa from "../models/EmployeeVisa.js";
import EmployeeEmiratesId from "../models/EmployeeEmiratesId.js";
import EmployeeLabourCard from "../models/EmployeeLabourCard.js";
import EmployeeMedicalInsurance from "../models/EmployeeMedicalInsurance.js";
import EmployeeDrivingLicense from "../models/EmployeeDrivingLicense.js";
import { archiveEmployeeDocument } from "./archiveEmployeeDocument.js";

/** Archive superseded file only on explicit Renew (not on edit/add/delete). */
export function shouldArchiveEmployeeDocumentOnRenewal({
    isRenewal,
    hasExistingDocument,
    hasNewDocumentUpload,
}) {
    if (isRenewal !== true) return false;
    return Boolean(hasExistingDocument && hasNewDocumentUpload);
}

export async function clearLiveEmployeeDocumentSection({ employeeId, section, visaType }) {
    if (!employeeId) return;
    const sec = String(section || "").toLowerCase();
    if (sec === "passport") {
        await EmployeePassport.deleteOne({ employeeId });
        return;
    }
    if (sec === "visa") {
        const type = String(visaType || "").trim();
        if (!type) return;
        await EmployeeVisa.updateOne({ employeeId }, { $unset: { [type]: "" } });
        return;
    }
    if (sec === "emiratesid") {
        await EmployeeEmiratesId.updateOne({ employeeId }, { $unset: { emiratesId: "" } });
        return;
    }
    if (sec === "labourcard") {
        await EmployeeLabourCard.updateOne({ employeeId }, { $unset: { labourCard: "" } });
        return;
    }
    if (sec === "medicalinsurance") {
        await EmployeeMedicalInsurance.updateOne({ employeeId }, { $unset: { medicalInsurance: "" } });
        return;
    }
    if (sec === "drivinglicense") {
        await EmployeeDrivingLicense.updateOne({ employeeId }, { $unset: { drivingLicenceDetails: "" } });
    }
}

export async function archiveAndClearLiveEmployeeRenewal({
    employeeId,
    skipLive,
    isRenewal,
    hasExistingDocument,
    hasNewDocumentUpload,
    section,
    visaType,
    archiveParams,
}) {
    const shouldArchive = shouldArchiveEmployeeDocumentOnRenewal({
        isRenewal,
        hasExistingDocument,
        hasNewDocumentUpload,
    });
    if (shouldArchive && archiveParams?.document) {
        await archiveEmployeeDocument({ employeeId, ...archiveParams });
    }
    if (skipLive && isRenewal === true && hasExistingDocument) {
        await clearLiveEmployeeDocumentSection({ employeeId, section, visaType });
    }
    return shouldArchive;
}

const NOT_RENEW_KIND_TO_SECTION = {
    passport: "passport",
    visa: "visa",
    emiratesid: "emiratesid",
    labourcard: "labourcard",
    medicalinsurance: "medicalinsurance",
    drivinglicense: "drivinglicense",
};

/** Drop queued profile edits for a card that was not renewed (live data is removed). */
export function stripPendingReactivationForNotRenew(employee, entry) {
    if (!employee || !entry) return;
    const kind = String(entry.kind || "").toLowerCase();
    if (kind === "manualdocument") {
        const idx = typeof entry.documentIndex === "number" ? entry.documentIndex : -1;
        employee.pendingReactivationChanges = (employee.pendingReactivationChanges || []).filter((change) => {
            if (String(change?.section || "").toLowerCase() !== "documents") return true;
            if (String(change?.changeType || "").toLowerCase() === "delete" && change?.targetIndex === idx) {
                return false;
            }
            if (
                String(change?.changeType || "").toLowerCase() === "update" &&
                change?.targetIndex === idx
            ) {
                return false;
            }
            return true;
        });
        return;
    }
    const section = NOT_RENEW_KIND_TO_SECTION[kind];
    if (!section) return;
    employee.pendingReactivationChanges = (employee.pendingReactivationChanges || []).filter((change) => {
        const changeSection = String(change?.section || "").toLowerCase();
        if (changeSection !== section) return true;
        if (kind === "visa") {
            const entryVisa = String(entry.visaType || "").toLowerCase();
            const proposedVisa = String(change?.proposedData?.visaType || "").toLowerCase();
            return entryVisa && proposedVisa ? entryVisa !== proposedVisa : false;
        }
        return false;
    });
}

export function isEmployeeProfileLiveActive(employee = {}) {
    const profileStatus = String(employee?.profileStatus || "inactive").toLowerCase();
    const profileApprovalStatus = String(employee?.profileApprovalStatus || "draft").toLowerCase();
    return profileStatus === "active" && profileApprovalStatus === "active";
}
