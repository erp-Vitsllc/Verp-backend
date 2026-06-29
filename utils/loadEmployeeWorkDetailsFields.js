import EmployeeBasic from "../models/EmployeeBasic.js";
import User from "../models/User.js";
import Company from "../models/Company.js";

const populateOptions = [
    { path: "reportingAuthority", select: "firstName lastName employeeId email workEmail companyEmail" },
    { path: "primaryReportee", select: "firstName lastName employeeId email workEmail companyEmail" },
    { path: "secondaryReportee", select: "firstName lastName employeeId email workEmail companyEmail" },
    { path: "company", select: "name companyId logo" },
];

/** Lightweight work-details snapshot — avoids full getCompleteEmployee on save. */
export async function loadEmployeeWorkDetailsFields(employeeId) {
    if (!employeeId) return null;

    const doc = await EmployeeBasic.findOne({ employeeId })
        .select("-password -documents.document.data -trainingDetails.certificate.data")
        .populate(populateOptions)
        .lean();

    if (!doc) return null;

    const linkedUser = await User.findOne({ employeeId, status: "Active" }, "enablePortalAccess").lean();

    return {
        reportingAuthority: doc.reportingAuthority ?? null,
        primaryReportee: doc.primaryReportee ?? null,
        secondaryReportee: doc.secondaryReportee ?? null,
        overtime: doc.overtime,
        status: doc.status,
        probationPeriod: doc.probationPeriod,
        designation: doc.designation,
        department: doc.department,
        company: doc.company ?? null,
        contractJoiningDate: doc.contractJoiningDate ?? null,
        contractExpiryDate: doc.contractExpiryDate ?? null,
        dateOfJoining: doc.dateOfJoining ?? null,
        companyEmail: doc.companyEmail || "",
        enablePortalAccess: !!(linkedUser && linkedUser.enablePortalAccess),
        profileStatus: doc.profileStatus,
        profileApprovalStatus: doc.profileApprovalStatus,
        profileActivationHold: doc.profileActivationHold,
        profileActivationDraftEditor: doc.profileActivationDraftEditor,
        pendingReactivationChanges: doc.pendingReactivationChanges,
    };
}
