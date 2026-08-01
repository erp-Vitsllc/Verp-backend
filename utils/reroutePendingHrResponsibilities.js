import mongoose from "mongoose";
import DashboardAction from "../models/DashboardAction.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import Company from "../models/Company.js";
import Fine from "../models/Fine.js";
import Loan from "../models/Loan.js";
import AssetItem from "../models/AssetItem.js";
import User from "../models/User.js";
import { rerouteAllPendingAssetCreationApprovals } from "./assetApprovalHelpers.js";

/** Pending dashboard rows that belong to the Flowchart HR inbox. */
export const HR_DASHBOARD_REQUEST_TYPES = [
    "Profile Activation",
    "Company Activation",
    "Fine",
    "Group Fine Request",
    "Loan",
    "Notice Request",
    "Left User Request",
    "Vehicle Service Request",
    "Vehicle Profile Activation",
    "Vehicle Disposition Request",
    "Document Expiry Reminder",
    "Employee Document Expiry Reminder",
    "Vehicle Document Expiry Reminder",
    "Company Document Not Renew",
    "Employee Document Not Renew",
    // Vehicle handover assignment inbox (HR stage)
    "Asset Assignment",
];

const toObjectId = (value) => {
    if (!value) return null;
    const s = String(value);
    if (!mongoose.Types.ObjectId.isValid(s)) return null;
    return new mongoose.Types.ObjectId(s);
};

const resolveActivePortalUserId = async (employeeBasicDoc) => {
    const employeeId = String(employeeBasicDoc?.employeeId || "").trim();
    if (!employeeId) return null;
    const user = await User.findOne({ employeeId, status: "Active" }).select("_id").lean();
    return user?._id || null;
};

/**
 * When Flowchart HR changes, move in-flight HR work from the previous holder to the new one.
 * New emails already resolve via getDepartmentHOD('hr'); this heals stale assignee snapshots.
 */
export async function reroutePendingHrResponsibilities({ oldHrEmpObjectId, newHrEmployee }) {
    const oldId = toObjectId(oldHrEmpObjectId);
    const newId = toObjectId(newHrEmployee?._id);
    const newEmpId = String(newHrEmployee?.employeeId || "").trim();

    if (!oldId || !newId) {
        return { skipped: true, reason: "missing_hr_ids" };
    }
    if (oldId.equals(newId)) {
        return { skipped: true, reason: "same_hr_holder" };
    }

    const counts = {
        dashboardActions: 0,
        profileSubmissions: 0,
        companyActivations: 0,
        fines: 0,
        loans: 0,
        vehicleServicePendingHr: 0,
        vehicleProfileSubmitted: 0,
        fleetAssetApprovals: 0,
        vehicleHandoverPendingHr: 0,
    };

    const dash = await DashboardAction.updateMany(
        {
            assignedTo: oldId,
            status: "Pending",
            requestType: { $in: HR_DASHBOARD_REQUEST_TYPES },
        },
        { $set: { assignedTo: newId, ...(newEmpId ? { assignedToEmpId: newEmpId } : {}) } },
    );
    counts.dashboardActions = dash.modifiedCount || 0;

    const oldEmp = await EmployeeBasic.findById(oldId).select("employeeId").lean();
    if (oldEmp?.employeeId && newEmpId) {
        const legacyDash = await DashboardAction.updateMany(
            {
                assignedToEmpId: oldEmp.employeeId,
                status: "Pending",
                requestType: { $in: HR_DASHBOARD_REQUEST_TYPES },
            },
            { $set: { assignedTo: newId, assignedToEmpId: newEmpId } },
        );
        counts.dashboardActions += legacyDash.modifiedCount || 0;
    }

    const profile = await EmployeeBasic.updateMany(
        { profileSubmittedTo: oldId, profileApprovalStatus: "submitted" },
        { $set: { profileSubmittedTo: newId } },
    );
    counts.profileSubmissions = profile.modifiedCount || 0;

    await EmployeeBasic.updateMany(
        {
            profileWorkflow: {
                $elemMatch: { role: "HR", assignedTo: oldId, status: "submitted" },
            },
        },
        { $set: { "profileWorkflow.$[step].assignedTo": newId } },
        { arrayFilters: [{ "step.role": "HR", "step.assignedTo": oldId, "step.status": "submitted" }] },
    );

    const companies = await Company.updateMany(
        { activationSubmittedTo: oldId, activationStatus: "submitted" },
        { $set: { activationSubmittedTo: newId } },
    );
    counts.companyActivations = companies.modifiedCount || 0;

    await EmployeeBasic.updateMany(
        {
            "noticeRequest.workflow": {
                $elemMatch: { role: "HR", assignedTo: oldId, status: "Pending" },
            },
        },
        { $set: { "noticeRequest.workflow.$[step].assignedTo": newId } },
        { arrayFilters: [{ "step.role": "HR", "step.assignedTo": oldId, "step.status": "Pending" }] },
    );

    await EmployeeBasic.updateMany(
        {
            "probationChangeRequest.status": "pending_hr_final",
            "probationChangeRequest.workflow": {
                $elemMatch: { role: "HR", assignedTo: oldId },
            },
        },
        { $set: { "probationChangeRequest.workflow.$[step].assignedTo": newId } },
        { arrayFilters: [{ "step.role": "HR", "step.assignedTo": oldId }] },
    );

    const [oldUserId, newUserId] = await Promise.all([
        resolveActivePortalUserId(oldEmp),
        resolveActivePortalUserId(newHrEmployee),
    ]);

    if (oldUserId && newUserId) {
        const fines = await Fine.updateMany(
            {
                submittedTo: oldUserId,
                fineStatus: { $in: ["Pending HR", "Pending Review"] },
            },
            { $set: { submittedTo: newUserId } },
        );
        counts.fines = fines.modifiedCount || 0;

        await Fine.updateMany(
            {
                workflow: {
                    $elemMatch: { role: "HR", assignedTo: oldUserId, status: "Pending" },
                },
            },
            { $set: { "workflow.$[step].assignedTo": newUserId } },
            { arrayFilters: [{ "step.role": "HR", "step.assignedTo": oldUserId, "step.status": "Pending" }] },
        );
    }

    const loanSubmittedToIds = [oldUserId, oldId].filter(Boolean);
    const loanSet = {
        ...(newUserId ? { submittedTo: newUserId } : {}),
    };
    if (Object.keys(loanSet).length) {
        const loans = await Loan.updateMany(
            {
                submittedTo: { $in: loanSubmittedToIds },
                status: "Pending HR",
            },
            { $set: loanSet },
        );
        counts.loans = loans.modifiedCount || 0;
    }

    if (newUserId && oldUserId) {
        await Loan.updateMany(
            {
                workflow: {
                    $elemMatch: { role: "HR Admin", assignedTo: oldUserId, status: "Pending" },
                },
            },
            { $set: { "workflow.$[step].assignedTo": newUserId } },
            {
                arrayFilters: [
                    { "step.role": "HR Admin", "step.assignedTo": oldUserId, "step.status": "Pending" },
                ],
            },
        );
    }

    const vehicleService = await AssetItem.updateMany(
        { "activeServiceWorkflow.stage": "pending_hr", actionRequiredBy: oldId },
        { $set: { actionRequiredBy: newId } },
    );
    counts.vehicleServicePendingHr = vehicleService.modifiedCount || 0;

    // Pending vehicle handover at HR / management / HOD — move actionRequiredBy to new flowchart HR.
    const vehicleHandover = await AssetItem.updateMany(
        {
            actionRequiredBy: oldId,
            "pendingActionDetails.vehicleHandoverFlow.stage": {
                $in: ["hr", "management", "hod"],
            },
        },
        { $set: { actionRequiredBy: newId } },
    );
    counts.vehicleHandoverPendingHr = vehicleHandover.modifiedCount || 0;

    const vehicleProfile = await AssetItem.updateMany(
        { vehicleProfileActivationStatus: "submitted", actionRequiredBy: oldId },
        { $set: { actionRequiredBy: newId } },
    );
    counts.vehicleProfileSubmitted = vehicleProfile.modifiedCount || 0;

    try {
        const assetCounts = await rerouteAllPendingAssetCreationApprovals({ category: "hr" });
        counts.fleetAssetApprovals = assetCounts?.fleetUpdated || 0;
    } catch (err) {
        console.error("[reroutePendingHrResponsibilities] fleet asset reroute failed:", err?.message || err);
    }

    console.log(
        `[reroutePendingHrResponsibilities] ${oldId} → ${newId}: ${JSON.stringify(counts)}`,
    );

    return { skipped: false, counts };
}

/**
 * When Flowchart Admin Officer changes, move in-flight Admin Officer work
 * (vehicle handover target stage, shop garage admin stage) to the new holder.
 * Additive — does not alter existing HR reroute.
 */
export async function reroutePendingAdminOfficerResponsibilities({
    oldAdminEmpObjectId,
    newAdminEmployee,
}) {
    const oldId = toObjectId(oldAdminEmpObjectId);
    const newId = toObjectId(newAdminEmployee?._id);
    const newEmpId = String(newAdminEmployee?.employeeId || "").trim();

    if (!oldId || !newId) {
        return { skipped: true, reason: "missing_admin_ids" };
    }
    if (oldId.equals(newId)) {
        return { skipped: true, reason: "same_admin_holder" };
    }

    const counts = {
        dashboardActions: 0,
        vehicleHandoverTarget: 0,
        vehicleServiceAdmin: 0,
        vehicleProfilePendingAdmin: 0,
    };

    const dash = await DashboardAction.updateMany(
        {
            assignedTo: oldId,
            status: "Pending",
            requestType: {
                $in: ["Asset Assignment", "Vehicle Service Request", "Vehicle Profile Activation"],
            },
        },
        { $set: { assignedTo: newId, ...(newEmpId ? { assignedToEmpId: newEmpId } : {}) } },
    );
    counts.dashboardActions = dash.modifiedCount || 0;

    const handoverTarget = await AssetItem.updateMany(
        {
            actionRequiredBy: oldId,
            "pendingActionDetails.vehicleHandoverFlow.stage": "target",
        },
        { $set: { actionRequiredBy: newId } },
    );
    counts.vehicleHandoverTarget = handoverTarget.modifiedCount || 0;

    const serviceAdmin = await AssetItem.updateMany(
        {
            actionRequiredBy: oldId,
            "activeServiceWorkflow.stage": {
                $in: ["pending_admin", "admin_officer", "pending_admin_officer"],
            },
        },
        { $set: { actionRequiredBy: newId } },
    );
    counts.vehicleServiceAdmin = serviceAdmin.modifiedCount || 0;

    const vehicleProfileAdmin = await AssetItem.updateMany(
        { vehicleProfileActivationStatus: "pending_admin", actionRequiredBy: oldId },
        { $set: { actionRequiredBy: newId } },
    );
    counts.vehicleProfilePendingAdmin = vehicleProfileAdmin.modifiedCount || 0;

    console.log(
        `[reroutePendingAdminOfficerResponsibilities] ${oldId} → ${newId}: ${JSON.stringify(counts)}`,
    );

    return { skipped: false, counts };
}

/**
 * When Flowchart Accounts changes, move pending Accounts approvals to the new holder.
 */
export async function reroutePendingAccountsResponsibilities({
    oldAccountsEmpObjectId,
    newAccountsEmployee,
}) {
    const oldId = toObjectId(oldAccountsEmpObjectId);
    const newId = toObjectId(newAccountsEmployee?._id);
    const newEmpId = String(newAccountsEmployee?.employeeId || "").trim();

    if (!oldId || !newId) {
        return { skipped: true, reason: "missing_accounts_ids" };
    }
    if (oldId.equals(newId)) {
        return { skipped: true, reason: "same_accounts_holder" };
    }

    const counts = {
        dashboardActions: 0,
        vehicleServicePendingAccounts: 0,
    };

    const dash = await DashboardAction.updateMany(
        {
            assignedTo: oldId,
            status: "Pending",
            requestType: { $in: ["Vehicle Service Request", "Utility Bill Payment"] },
        },
        { $set: { assignedTo: newId, ...(newEmpId ? { assignedToEmpId: newEmpId } : {}) } },
    );
    counts.dashboardActions = dash.modifiedCount || 0;

    const serviceAccounts = await AssetItem.updateMany(
        {
            actionRequiredBy: oldId,
            "activeServiceWorkflow.stage": {
                $in: ["pending_accounts", "accounts"],
            },
        },
        { $set: { actionRequiredBy: newId } },
    );
    counts.vehicleServicePendingAccounts = serviceAccounts.modifiedCount || 0;

    console.log(
        `[reroutePendingAccountsResponsibilities] ${oldId} → ${newId}: ${JSON.stringify(counts)}`,
    );

    return { skipped: false, counts };
}
