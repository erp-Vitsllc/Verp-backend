import mongoose from "mongoose";
import Flowchart from "../models/Flowchart.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import User from "../models/User.js";
import DashboardAction from "../models/DashboardAction.js";
import { sendResponsibilityApprovalEmail } from "../utils/sendResponsibilityApprovalEmail.js";
import { buildResponsibilityEmailData } from "../utils/flowchartResponsibilityEmailData.js";
import AssetItem from "../models/AssetItem.js";
import { sendAssetAssignmentEmail } from "../utils/sendAssetAssignmentEmail.js";
import { hodDisplayFromEmployee } from "../utils/buildAssignmentHandoverEmailAttachments.js";
import { notifyAssetHandoverTransferEmails } from "../utils/notifyAssetHandoverTransferEmails.js";
import { sendFlowchartReassignmentResultEmail } from "../utils/sendFlowchartReassignmentResultEmail.js";
import { isUserAdministrator } from "../services/permissionService.js";
import { isJwtSystemSuperUser } from "../utils/systemSuperUser.js";
import { resolveFlowchartHrEmployee } from "../utils/resolveFlowchartHrEmployee.js";
import { rerouteAllPendingAssetCreationApprovals } from "../utils/assetApprovalHelpers.js";
import { reroutePendingHrResponsibilities, reroutePendingAdminOfficerResponsibilities, reroutePendingAccountsResponsibilities } from "../utils/reroutePendingHrResponsibilities.js";
import AssetHistory from "../models/AssetHistory.js";

/**
 * On Asset Controller approval: checked assets (keepAssetIds) stay Unassigned / On Leave.
 * Unchecked assets in the preview list are assigned to the previous controller (reassignment snapshot).
 * If keepAssetIds is omitted, all preview assets are kept (no reassignments).
 * Appends AssetHistory only (records are never removed).
 */
async function applyAssetControllerPoolSelectionOnApprove({
    keepAssetIds,
    previousControllerEmpObjectId,
    performerEmpObjectId,
    previousControllerLabel,
    newControllerLabel
}) {
    if (!previousControllerEmpObjectId || !mongoose.Types.ObjectId.isValid(String(previousControllerEmpObjectId))) {
        return { keptIds: [], reassignedIds: [] };
    }
    const emailData = await buildResponsibilityEmailData("assetcontroller");
    const previewIds = [
        ...(emailData.unassignedAssets || []).map((a) => String(a._id)),
        ...(emailData.parkingAssets || []).map((a) => String(a._id))
    ].filter((id) => mongoose.Types.ObjectId.isValid(id));
    const previewSet = new Set(previewIds);

    const keepSet =
        keepAssetIds == null
            ? previewSet
            : new Set((keepAssetIds || []).map(String).filter((id) => mongoose.Types.ObjectId.isValid(id)));

    const oldId = new mongoose.Types.ObjectId(String(previousControllerEmpObjectId));
    const when = new Date();
    const dateStr = when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

    let performerLabel = "The new asset controller";
    if (performerEmpObjectId && mongoose.Types.ObjectId.isValid(String(performerEmpObjectId))) {
        const p = await EmployeeBasic.findById(performerEmpObjectId).select("firstName lastName").lean();
        if (p) {
            const n = `${p.firstName || ""} ${p.lastName || ""}`.trim();
            if (n) performerLabel = n;
        }
    }
    const prevLabel = (previousControllerLabel || "the previous asset controller").trim() || "the previous asset controller";
    const newLabel = (newControllerLabel || "the new asset controller").trim() || "the new asset controller";

    const keptIds = [];
    const reassignedIds = [];

    for (const idStr of previewSet) {
        const asset = await AssetItem.findById(idStr).select("assetId name status").lean();
        if (!asset) continue;

        if (keepSet.has(idStr)) {
            keptIds.push(idStr);
            const st = (asset.status || "").toLowerCase();
            const isLeave = st === "on leave";
            const userStory = isLeave
                ? `${performerLabel} accepted the role as ${newLabel} on ${dateStr}. This item stays on leave with the same person — nothing was moved.`
                : `${performerLabel} accepted the role as ${newLabel} on ${dateStr}. This item is still open and not assigned to a person.`;
            await AssetHistory.create({
                assetId: idStr,
                action: "ControllerHandover",
                performedBy: performerEmpObjectId || undefined,
                comments: userStory,
                details: {
                    userStory,
                    variant: isLeave ? "kept_on_leave" : "kept_open",
                    assetCode: asset.assetId,
                    assetName: asset.name
                },
                date: when
            });
        } else {
            reassignedIds.push(idStr);
            await AssetItem.updateOne(
                { _id: idStr, status: { $in: ["Unassigned", "On Leave"] } },
                {
                    $set: {
                        assignedTo: oldId,
                        assignedToType: "Employee",
                        assignedCompany: null,
                        status: "Assigned",
                        acceptanceStatus: "Accepted",
                        actionRequiredBy: null,
                        pendingAction: null,
                        pendingActionDetails: null,
                        onLeaveStartDate: null,
                        onLeaveEndDate: null,
                        onLeaveDuration: null
                    }
                }
            );
            const userStory = `${performerLabel} accepted the role as ${newLabel} on ${dateStr}. This item was assigned to ${prevLabel} (who was the asset controller before).`;
            await AssetHistory.create({
                assetId: idStr,
                action: "ControllerHandover",
                assignedTo: oldId,
                assignedToType: "Employee",
                performedBy: performerEmpObjectId || undefined,
                comments: userStory,
                details: {
                    userStory,
                    variant: "returned_to_previous_controller",
                    assetCode: asset.assetId,
                    assetName: asset.name,
                    assignedToName: prevLabel
                },
                date: when
            });
        }
    }
    return { keptIds, reassignedIds };
}

/**
 * For Assigned User / Admin / HR reassignment:
 * checked keepAssetIds stay company assets;
 * unchecked company assets are assigned back to previous holder.
 */
async function applyCompanyAssetSelectionOnApprove({
    category,
    keepAssetIds,
    previousHolderEmpObjectId,
    performerEmpObjectId,
    previousHolderLabel,
    newHolderLabel
}) {
    if (!previousHolderEmpObjectId || !mongoose.Types.ObjectId.isValid(String(previousHolderEmpObjectId))) {
        return { keptIds: [], reassignedIds: [] };
    }
    const emailData = await buildResponsibilityEmailData(category);
    const previewIds = (emailData.companyAssets || []).map((a) => String(a._id)).filter((id) => mongoose.Types.ObjectId.isValid(id));
    const previewSet = new Set(previewIds);
    const keepSet =
        keepAssetIds == null
            ? previewSet
            : new Set((keepAssetIds || []).map(String).filter((id) => mongoose.Types.ObjectId.isValid(id)));

    const oldId = new mongoose.Types.ObjectId(String(previousHolderEmpObjectId));
    const when = new Date();
    const dateStr = when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

    let performerLabel = "The new role holder";
    if (performerEmpObjectId && mongoose.Types.ObjectId.isValid(String(performerEmpObjectId))) {
        const p = await EmployeeBasic.findById(performerEmpObjectId).select("firstName lastName").lean();
        if (p) {
            const n = `${p.firstName || ""} ${p.lastName || ""}`.trim();
            if (n) performerLabel = n;
        }
    }
    const prevLabel = (previousHolderLabel || "the previous holder").trim() || "the previous holder";
    const newLabel = (newHolderLabel || "the new holder").trim() || "the new holder";

    const keptIds = [];
    const reassignedIds = [];
    for (const idStr of previewSet) {
        const asset = await AssetItem.findById(idStr).select("assetId name status").lean();
        if (!asset) continue;

        if (keepSet.has(idStr)) {
            keptIds.push(idStr);
            const userStory = `${performerLabel} accepted the role as ${newLabel} on ${dateStr}. This company asset stays under company allocation.`;
            await AssetHistory.create({
                assetId: idStr,
                action: "ControllerHandover",
                performedBy: performerEmpObjectId || undefined,
                comments: userStory,
                details: { userStory, variant: "kept_company_asset", assetCode: asset.assetId, assetName: asset.name },
                date: when
            });
        } else {
            reassignedIds.push(idStr);
            await AssetItem.updateOne(
                { _id: idStr, assignedToType: "Company" },
                {
                    $set: {
                        assignedTo: oldId,
                        assignedToType: "Employee",
                        assignedCompany: null,
                        status: "Assigned",
                        acceptanceStatus: "Accepted",
                        actionRequiredBy: null,
                        pendingAction: null,
                        pendingActionDetails: null
                    }
                }
            );
            const userStory = `${performerLabel} accepted the role as ${newLabel} on ${dateStr}. This company asset was assigned back to ${prevLabel}.`;
            await AssetHistory.create({
                assetId: idStr,
                action: "ControllerHandover",
                assignedTo: oldId,
                assignedToType: "Employee",
                performedBy: performerEmpObjectId || undefined,
                comments: userStory,
                details: { userStory, variant: "returned_to_previous_holder", assetCode: asset.assetId, assetName: asset.name, assignedToName: prevLabel },
                date: when
            });
        }
    }
    return { keptIds, reassignedIds };
}

// @desc    Get all flowchart responsibilities
// @route   GET /api/flowchart
// @access  Private
export const getFlowchartResponsibilities = async (req, res) => {
    try {
        const responsibilities = await Flowchart.find()
            .populate('empObjectId', 'employeeId firstName lastName department designation')
            .sort({ category: 1, status: -1 });

        res.status(200).json(responsibilities);
    } catch (error) {
        console.error('Error fetching flowchart responsibilities:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Add or update flowchart responsibility
// @route   POST /api/flowchart
// @access  Private
export const addFlowchartResponsibility = async (req, res) => {
    try {
        const { category, employeeId, employeeName, designation, empObjectId, status, department, companyEmail, email } = req.body;

        console.log('Received flowchart data:', { category, employeeId, employeeName, designation, empObjectId, status });

        // Auto-resolve empObjectId if missing
        let resolvedEmpObjectId = empObjectId;
        if (!resolvedEmpObjectId && employeeId) {
            const employee = await EmployeeBasic.findOne({
                employeeId: { $regex: new RegExp(`^${employeeId.replace(/\s+/g, '\\s*')}$`, 'i') }
            }).select('_id');
            if (employee) {
                resolvedEmpObjectId = employee._id;
                console.log(`Auto-resolved empObjectId for ${employeeId}: ${resolvedEmpObjectId}`);
            }
        }

        // Validate required fields
        if (!category || !employeeId || !employeeName || !designation) {
            return res.status(400).json({
                message: 'Missing required fields: category, employeeId, employeeName, designation are required',
                received: { category, employeeId, employeeName, designation }
            });
        }

        // Check if responsibility already exists for this category
        const existing = await Flowchart.findOne({ category });

        if (existing) {
            const employeeChanged =
                existing.empObjectId?.toString() !== resolvedEmpObjectId?.toString() ||
                (existing.employeeId || '').trim() !== (employeeId || '').trim();
            const wasActive = existing.status === 'Active';
            const incomingPending = status === 'Pending';

            if (employeeChanged && wasActive && incomingPending) {
                existing.reassignmentSnapshot = {
                    employeeId: existing.employeeId,
                    employeeName: existing.employeeName,
                    designation: existing.designation,
                    empObjectId: existing.empObjectId,
                    companyEmail: existing.companyEmail,
                    email: existing.email,
                    department: existing.department
                };
            }

            existing.employeeId = employeeId;
            existing.employeeName = employeeName;
            existing.designation = designation;
            existing.empObjectId = resolvedEmpObjectId;
            existing.status = status || 'Active';
            existing.department = department;
            existing.companyEmail = companyEmail;
            existing.email = email;
            existing.updatedBy = req.user._id;

            await existing.save();

            // Trigger approval if reassigned and Pending
            if (employeeChanged && status === 'Pending' && resolvedEmpObjectId) {
                try {
                    const employee = await EmployeeBasic.findById(resolvedEmpObjectId);
                    if (employee) {
                        const existingDashboardAction = await DashboardAction.findOne({
                            assignedTo: employee._id,
                            requestType: 'Responsibility Approval',
                            status: 'Pending',
                            extra1: category
                        });

                        if (!existingDashboardAction) {
                            const newAction = await DashboardAction.create({
                                assignedTo: employee._id,
                                assignedToEmpId: employee.employeeId,
                                requestId: existing._id,
                                requestType: 'Responsibility Approval',
                                subjectEmployeeId: employee.employeeId,
                                subjectName: `${employee.firstName} ${employee.lastName}`,
                                requestedByName: req.user.name || 'Admin',
                                extra1: category,
                                extra2: `${category} Responsibility Approval (Reassigned)`,
                                status: 'Pending'
                            });

                            const roleLabels = {
                                hr: 'HR Admin',
                                accounts: 'Financial Controller',
                                assetcontroller: 'Asset Controller'
                            };
                            const emailPayload = await buildResponsibilityEmailData(category);
                            await sendResponsibilityApprovalEmail({
                                employee: employee,
                                companyName: 'Main ERP',
                                category: roleLabels[category] || category,
                                requestId: newAction._id,
                                dashboardDeepLinkId: existing._id,
                                unassignedAssets: [],
                                emailData: { categoryKey: category, ...emailPayload }
                            });
                        }
                    }
                } catch (err) {
                    console.error(`[Flowchart Reassign Error] Trigger failed:`, err);
                }
            }
            return res.status(200).json({ message: 'Responsibility updated successfully', responsibility: existing });
        } else {
            // Create new
            const responsibility = new Flowchart({
                category,
                employeeId,
                employeeName,
                designation,
                empObjectId: resolvedEmpObjectId,
                status: status || 'Active',
                department,
                companyEmail,
                email,
                createdBy: req.user._id
            });

            await responsibility.save();

            // Create dashboard action for responsibility approval if status is Pending
            if (status === 'Pending' && resolvedEmpObjectId) {
                try {
                    // Find the employee record
                    const employee = await EmployeeBasic.findById(resolvedEmpObjectId);
                    if (employee) {
                        // Check if we already have a pending dashboard action for this specific role and employee
                        const existingAction = await DashboardAction.findOne({
                            assignedTo: employee._id,
                            requestType: 'Responsibility Approval',
                            status: 'Pending',
                            extra1: category
                        });

                        if (!existingAction) {
                            const newAction = await DashboardAction.create({
                                assignedTo: employee._id,
                                assignedToEmpId: employee.employeeId,
                                requestId: responsibility._id,
                                requestType: 'Responsibility Approval',
                                subjectEmployeeId: employee.employeeId,
                                subjectName: `${employee.firstName} ${employee.lastName}`,
                                requestedByName: req.user.name || 'Admin',
                                extra1: category,
                                extra2: `${category} Responsibility Approval`,
                                status: 'Pending'
                            });

                            console.log(`[Flowchart] Created responsibility approval action for ${category}: ${employee.employeeId}`);

                            // Send approval email
                            const roleLabels = {
                                'hr': 'HR Admin',
                                'accounts': 'Financial Controller',
                                'assetcontroller': 'Asset Controller',
                                'management': 'General Management',
                                'admincontroller': 'Admin Officer'
                            };

                            const emailPayload = await buildResponsibilityEmailData(category);
                            await sendResponsibilityApprovalEmail({
                                employee: employee,
                                companyName: 'Main ERP', // Global flowchart is for the whole system
                                category: roleLabels[category] || category,
                                requestId: newAction._id,
                                dashboardDeepLinkId: responsibility._id,
                                unassignedAssets: [],
                                emailData: { categoryKey: category, ...emailPayload }
                            });
                        }
                    }
                } catch (err) {
                    console.error(`[Flowchart Error] Failed to create responsibility approval action for ${category}:`, err);
                }
            }

            res.status(201).json({ message: 'Responsibility created successfully', responsibility });
        }
    } catch (error) {
        console.error('Error adding flowchart responsibility:', error);

        // Send detailed error message
        if (error.name === 'ValidationError') {
            const errors = Object.values(error.errors).map(err => err.message);
            return res.status(400).json({
                message: 'Validation Error',
                errors: errors,
                details: error.message
            });
        }

        res.status(500).json({
            message: 'Server Error',
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

// @desc    Respond to responsibility approval
// @route   PUT /api/flowchart/respond-responsibility
// @access  Private
export const respondToResponsibility = async (req, res) => {
    try {
        const { action, actionId, category, assetControllerHandover, companyAssetHandover } = req.body;
        const catNorm = (category || "").toLowerCase().replace(/\s+/g, "");

        // Find the responsibility by ID or category
        let responsibility;
        if (actionId) {
            responsibility = await Flowchart.findById(actionId);
        } else {
            responsibility = await Flowchart.findOne({ category });
        }

        if (!responsibility) {
            return res.status(404).json({ message: 'Responsibility not found' });
        }

        const invitedCandidateName = `${responsibility.employeeName || ''}`.trim() || 'the invited person';

        // Snapshot of previous active holder (used for notifying old responsible on accept/reject)
        const oldSnapshot = responsibility.reassignmentSnapshot
            ? {
                employeeId: responsibility.reassignmentSnapshot.employeeId,
                employeeName: responsibility.reassignmentSnapshot.employeeName,
                designation: responsibility.reassignmentSnapshot.designation,
                empObjectId: responsibility.reassignmentSnapshot.empObjectId,
                companyEmail: responsibility.reassignmentSnapshot.companyEmail,
                email: responsibility.reassignmentSnapshot.email,
                department: responsibility.reassignmentSnapshot.department
            }
            : null;

        let assetControllerOutcome = null;

        if (action === 'Reject' && responsibility.reassignmentSnapshot) {
            const s = responsibility.reassignmentSnapshot;
            responsibility.employeeId = s.employeeId;
            responsibility.employeeName = s.employeeName;
            responsibility.designation = s.designation;
            responsibility.empObjectId = s.empObjectId;
            responsibility.companyEmail = s.companyEmail;
            responsibility.email = s.email;
            responsibility.department = s.department;
            responsibility.status = 'Active';
            responsibility.reassignmentSnapshot = null;
            responsibility.updatedBy = req.user._id;
            await responsibility.save();
        } else {
            if (action === 'Approve' && catNorm === 'assetcontroller' && oldSnapshot?.empObjectId) {
                try {
                    assetControllerOutcome = await applyAssetControllerPoolSelectionOnApprove({
                        keepAssetIds: assetControllerHandover?.keepAssetIds,
                        previousControllerEmpObjectId: oldSnapshot.empObjectId,
                        performerEmpObjectId: req.user?.employeeObjectId,
                        previousControllerLabel: oldSnapshot.employeeName,
                        newControllerLabel: responsibility.employeeName
                    });
                } catch (acErr) {
                    console.error('[Flowchart] Asset controller pool selection failed:', acErr);
                    return res.status(500).json({
                        message: 'Failed to apply asset pool selection. Flowchart was not updated.'
                    });
                }
            }
            if (action === 'Approve' && ['assigneduser', 'admincontroller', 'hr'].includes(catNorm) && oldSnapshot?.empObjectId) {
                try {
                    await applyCompanyAssetSelectionOnApprove({
                        category,
                        keepAssetIds: companyAssetHandover?.keepAssetIds,
                        previousHolderEmpObjectId: oldSnapshot.empObjectId,
                        performerEmpObjectId: req.user?.employeeObjectId,
                        previousHolderLabel: oldSnapshot.employeeName,
                        newHolderLabel: responsibility.employeeName
                    });
                } catch (coErr) {
                    console.error('[Flowchart] Company asset selection failed:', coErr);
                    return res.status(500).json({
                        message: 'Failed to apply company asset selection. Flowchart was not updated.'
                    });
                }
            }
            responsibility.status = action === 'Approve' ? 'Active' : 'Rejected';
            if (action === 'Approve') {
                responsibility.reassignmentSnapshot = null;
            }
            responsibility.updatedBy = req.user._id;
            await responsibility.save();
        }

        // Also update any dashboard action if it exists
        const dashboardAction = await DashboardAction.findOne({
            $or: [
                { requestId: responsibility._id, requestType: 'Responsibility Approval', status: 'Pending' },
                { extra1: category, requestType: 'Responsibility Approval', status: 'Pending' }
            ]
        });

        if (dashboardAction) {
            dashboardAction.status = action === 'Approve' ? 'Approved' : 'Rejected';
            dashboardAction.resolvedAt = new Date();
            dashboardAction.resolvedBy = req.user._id;
            await dashboardAction.save();
        }

        // Re-route every pending HR inbox item + fleet asset approvals to the new Flowchart HR holder.
        if (action === "Approve" && catNorm === "hr" && oldSnapshot?.empObjectId && responsibility.empObjectId) {
            try {
                const newHR = await EmployeeBasic.findById(responsibility.empObjectId)
                    .select("_id employeeId firstName lastName")
                    .lean();
                const hrReroute = await reroutePendingHrResponsibilities({
                    oldHrEmpObjectId: oldSnapshot.empObjectId,
                    newHrEmployee: newHR,
                });
                console.log(
                    `[Flowchart] HR responsibility reroute after approve: ${JSON.stringify(hrReroute)}`,
                );
            } catch (rerouteErr) {
                console.error(
                    "[Flowchart] Failed to re-route pending HR responsibilities:",
                    rerouteErr?.message || rerouteErr,
                );
            }
        } else if (
            action === "Approve" &&
            (catNorm === "admincontroller" || catNorm === "assigneduser") &&
            oldSnapshot?.empObjectId &&
            responsibility.empObjectId
        ) {
            try {
                const newAdmin = await EmployeeBasic.findById(responsibility.empObjectId)
                    .select("_id employeeId firstName lastName")
                    .lean();
                const adminReroute = await reroutePendingAdminOfficerResponsibilities({
                    oldAdminEmpObjectId: oldSnapshot.empObjectId,
                    newAdminEmployee: newAdmin,
                });
                console.log(
                    `[Flowchart] Admin Officer responsibility reroute after approve: ${JSON.stringify(adminReroute)}`,
                );
            } catch (rerouteErr) {
                console.error(
                    "[Flowchart] Failed to re-route pending Admin Officer responsibilities:",
                    rerouteErr?.message || rerouteErr,
                );
            }
        } else if (
            action === "Approve" &&
            catNorm === "accounts" &&
            oldSnapshot?.empObjectId &&
            responsibility.empObjectId
        ) {
            try {
                const newAccounts = await EmployeeBasic.findById(responsibility.empObjectId)
                    .select("_id employeeId firstName lastName")
                    .lean();
                const accountsReroute = await reroutePendingAccountsResponsibilities({
                    oldAccountsEmpObjectId: oldSnapshot.empObjectId,
                    newAccountsEmployee: newAccounts,
                });
                console.log(
                    `[Flowchart] Accounts responsibility reroute after approve: ${JSON.stringify(accountsReroute)}`,
                );
            } catch (rerouteErr) {
                console.error(
                    "[Flowchart] Failed to re-route pending Accounts responsibilities:",
                    rerouteErr?.message || rerouteErr,
                );
            }
        } else if (action === "Approve" && catNorm === "assetcontroller") {
            try {
                const counts = await rerouteAllPendingAssetCreationApprovals({ category: "assetcontroller" });
                console.log(
                    `[Flowchart] Re-routed pending asset creation approvals after assetcontroller change: ${JSON.stringify(counts)}`,
                );
            } catch (rerouteErr) {
                console.error(
                    "[Flowchart] Failed to re-route pending asset creation approvals:",
                    rerouteErr?.message || rerouteErr,
                );
            }
        }

        // Trigger asset handover if HR responsibility approved
        if (action === "Approve" && catNorm === "hr") {
            try {
                const targetHREmpId = responsibility.empObjectId;
                const newHR = await EmployeeBasic.findById(targetHREmpId).select('_id employeeId firstName lastName');

                if (newHR) {
                    const otherHRsWithAssets = await AssetItem.find({
                        assignedTo: { $ne: targetHREmpId, $ne: null }
                    }).distinct('assignedTo');

                    for (const potentialOldHRId of otherHRsWithAssets) {
                        const potentialOldHR = await EmployeeBasic.findById(potentialOldHRId);
                        if (potentialOldHR && (potentialOldHR.designation?.toLowerCase().includes('hr') || potentialOldHR.department?.toLowerCase().includes('hr'))) {
                            const assetsToTransfer = await AssetItem.find({ assignedTo: potentialOldHRId });

                            if (assetsToTransfer.length > 0) {
                                await AssetItem.updateMany(
                                    { assignedTo: potentialOldHRId },
                                    {
                                        $set: {
                                            actionRequiredBy: targetHREmpId,
                                            status: 'Pending',
                                            acceptanceStatus: 'Pending',
                                            pendingAction: 'Asset Transfer',
                                            pendingActionDetails: {
                                                transferFrom: potentialOldHRId,
                                                type: 'HR_Handover',
                                                oldHRName: `${potentialOldHR.firstName} ${potentialOldHR.lastName}`
                                            }
                                        }
                                    }
                                );

                                const dashboardActions = assetsToTransfer.map(asset => ({
                                    assignedTo: targetHREmpId,
                                    assignedToEmpId: newHR.employeeId,
                                    requestId: asset._id,
                                    requestType: 'Asset Transfer',
                                    subjectEmployeeId: potentialOldHR.employeeId,
                                    subjectName: `${potentialOldHR.firstName} ${potentialOldHR.lastName}`,
                                    requestedByName: 'System (Global HR Handover)',
                                    extra1: `${asset.assetId} - ${asset.name}`,
                                    extra2: 'Global Responsibility Handover',
                                    status: 'Pending'
                                }));
                                await DashboardAction.insertMany(dashboardActions);
                                
                                try {
                                    const assignerForHandover = req.user?.employeeObjectId
                                        ? await EmployeeBasic.findById(req.user.employeeObjectId)
                                            .select('firstName lastName employeeId signature department')
                                            .lean()
                                        : null;
                                    const newHrFull = await EmployeeBasic.findById(newHR._id)
                                        .select('firstName lastName employeeId department primaryReportee')
                                        .populate('primaryReportee', 'firstName lastName employeeId')
                                        .lean();
                                    const hid = assetsToTransfer.map((a) => a._id.toString()).filter(Boolean);
                                    await notifyAssetHandoverTransferEmails({
                                        req,
                                        assetIds: hid,
                                        asset: assetsToTransfer[0],
                                        assets: assetsToTransfer,
                                        assigneeEmployee: newHrFull || newHR,
                                        assignerEmployee: assignerForHandover,
                                        isBulk: assetsToTransfer.length > 1,
                                        assetCount: assetsToTransfer.length,
                                        filenameBase: 'hr-global-handover',
                                        handoverCtx: {
                                            assigneeName: `${newHrFull?.firstName || ''} ${newHrFull?.lastName || ''}`.trim() || newHR.employeeId,
                                            employeeCode: newHrFull?.employeeId || newHR.employeeId || '—',
                                            department: (newHrFull?.department && String(newHrFull.department).trim()) || '—',
                                            hodName: hodDisplayFromEmployee(newHrFull),
                                            assigner: assignerForHandover,
                                            assignerName: req.user?.name || 'System',
                                        },
                                    });
                                } catch (emailErr) {
                                    console.error(`[Email Error] Global handover notification failed:`, emailErr);
                                }
 
                                console.log(`[Flowchart Handover] Triggered handover of ${assetsToTransfer.length} assets from ${potentialOldHR.employeeId} to ${newHR.employeeId}`);
                            }
                        }
                    }
                }
            } catch (err) {
                console.error("[Flowchart Handover Error] HR Asset handover failed:", err);
            }
        }

        // Notify previous/old holder (accept or reject)
        if (oldSnapshot) {
            try {
                await sendFlowchartReassignmentResultEmail(req, {
                    category,
                    action,
                    oldSnapshot,
                    invitedCandidateName,
                    assetControllerOutcome:
                        action === 'Approve' && catNorm === 'assetcontroller' && assetControllerOutcome
                            ? assetControllerOutcome
                            : null
                });
            } catch (mailErr) {
                console.error("[Flowchart Result Email] Non-fatal:", mailErr?.message || mailErr);
            }
        }

        res.status(200).json({ message: `Responsibility ${action}ed successfully` });
    } catch (error) {
        console.error('Error responding to responsibility:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Delete flowchart responsibility
// @route   DELETE /api/flowchart/:id
// @route   DELETE /api/flowchart/category/:category
// @access  Private
export const deleteFlowchartResponsibility = async (req, res) => {
    try {
        const isJwtAdmin = isJwtSystemSuperUser(req.user);
        let isSysAdmin = false;
        try {
            isSysAdmin = await isUserAdministrator(req.user?.id);
        } catch {
            isSysAdmin = false;
        }
        const privileged = isJwtAdmin || isSysAdmin;

        if (!privileged) {
            return res.status(403).json({
                message: 'Only Administrators have permission to delete flowchart designations.'
            });
        }

        const { id, category } = req.params;

        let deletedDoc = null;
        if (id && mongoose.Types.ObjectId.isValid(id)) {
            deletedDoc = await Flowchart.findByIdAndDelete(id);
        } else if (category) {
            deletedDoc = await Flowchart.findOneAndDelete({ category: category.toLowerCase().replace(/\s+/g, '') });
        } else if (id) {
            // Check if id is actually a category name instead of ObjectId
            deletedDoc = await Flowchart.findOneAndDelete({ category: id.toLowerCase().replace(/\s+/g, '') });
        }

        if (!deletedDoc) {
            return res.status(404).json({ message: 'Flowchart responsibility not found' });
        }

        // Delete any pending dashboard actions for this responsibility
        await DashboardAction.deleteMany({
            $or: [
                { requestId: deletedDoc._id, requestType: 'Responsibility Approval' },
                { extra1: deletedDoc.category, requestType: 'Responsibility Approval' }
            ]
        });

        res.status(200).json({
            message: 'Responsibility deleted successfully from database',
            responsibility: deletedDoc
        });
    } catch (error) {
        console.error('Error deleting flowchart responsibility:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Summary lists for Flowchart position view (Settings)
// @route   GET /api/flowchart/position-summary/:category
// @access  Private
export const getFlowchartPositionSummary = async (req, res) => {
    try {
        const { category } = req.params;
        const cat = (category || '').toLowerCase().replace(/\s+/g, '');

        // When generating PDFs/emails, we may need to preview inventory "as" a different employee.
        // Frontend print pages can pass ?previewAs=<employeeObjectId>.
        const previewAs = req.query?.previewAs ? String(req.query.previewAs) : null;

        const empId = previewAs || req.user?.employeeObjectId?.toString?.() || null;
        const isJwtAdmin = isJwtSystemSuperUser(req.user);
        let isSysAdmin = false;
        try {
            isSysAdmin = await isUserAdministrator(req.user?.id);
        } catch {
            isSysAdmin = false;
        }
        const privileged = isJwtAdmin || isSysAdmin;

        const flow = await Flowchart.findOne({ category: cat });
        let canViewInventory = true;
        let viewerNote = null;

        if (cat === 'assetcontroller' || cat === 'hr' || cat === 'assigneduser' || cat === 'admincontroller') {
            if (!flow) {
                canViewInventory = false;
                viewerNote = 'This position is not configured in the flowchart.';
            } else {
                const holderMatch = flow.empObjectId && empId && flow.empObjectId.toString() === empId;
                if (flow.status === 'Pending') {
                    if (!holderMatch && !privileged) {
                        canViewInventory = false;
                        viewerNote =
                            'This inventory is available after your responsibility request is sent. Only the invited assignee (and administrators) can open the full preview until it is approved.';
                    }
                } else if (flow.status === 'Active') {
                    if (!holderMatch && !privileged) {
                        canViewInventory = false;
                        viewerNote =
                            'Only the current role holder and administrators can view this inventory preview.';
                    }
                }
            }
        }

        const data = await buildResponsibilityEmailData(category);

        if (!canViewInventory) {
            return res.status(200).json({
                category,
                canViewInventory: false,
                viewerNote,
                hrBullets: data.hrBullets || [],
                companyAssets: [],
                unassignedAssets: [],
                parkingAssets: [],
                accessorySummaryLines: []
            });
        }

        res.status(200).json({
            category,
            canViewInventory: true,
            viewerNote,
            ...data
        });
    } catch (error) {
        console.error('Error building position summary:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get employees for dropdown
// @route   GET /api/flowchart/employees
// @access  Private
export const getEmployeesForFlowchart = async (req, res) => {
    try {
        const employees = await EmployeeBasic.find({ profileStatus: 'active' })
            .select('employeeId firstName lastName department designation companyEmail email')
            .sort({ firstName: 1, lastName: 1 });

        res.status(200).json(employees);
    } catch (error) {
        console.error('Error fetching employees:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Active Flowchart HR holder (EmployeeBasic ids) for client-side permission checks
// @route   GET /api/Flowchart/active-holder/hr
// @access  Private
export const getActiveFlowchartHolderHr = async (req, res) => {
    try {
        const resolved = await resolveFlowchartHrEmployee();
        if (resolved.error) {
            return res.status(200).json({
                ok: false,
                code: resolved.error,
                message: resolved.message,
                empObjectId: null,
                employeeId: null
            });
        }
        const e = resolved.employee;
        return res.status(200).json({
            ok: true,
            empObjectId: String(e._id),
            employeeId: e.employeeId || null
        });
    } catch (error) {
        console.error('getActiveFlowchartHolderHr:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};
