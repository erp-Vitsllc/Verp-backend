import express from 'express';
import { getNextFleetVehicleAssetId } from '../controllers/assetItem/getNextFleetVehicleAssetId.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import User from '../models/User.js';
import { createAssetItem, getAssetItems, getVehicleFleetDashboard, getVehicleFleetServiceRequests, getAllAssignedAssets, getMyAssignedAssetsForReturn, getUnassignedAssetsForEmployee, getCompanyAllocationCoordinatorStatus, getHRCompanyAssets, getOnLeaveAssetsForEmployee, getOnServiceAssetsForEmployee, runAssetServiceOverdueCheck, handleOnLeaveAction, bulkHandleOnLeaveAction, handleOnServiceAction, bulkHandleOnServiceAction, getAssetItemDetail, assignAssetItem, bulkAssignAssetItems, bulkAssignAssetItemsToCompany, downloadHandoverPdf, downloadHistoryHandoverPdf, downloadVehicleHandoverPdf, respondToAssignment, bulkRespondToAssignment, getBulkAssignmentPendingGroup, respondBulkAssignmentGroup, getAssetHistory, getHistoryRecord, deleteVehicleHandoverHistory, uploadHandoverAssessmentPhoto, updateHistoryReceiverAssessment, updateHistoryBodyCondition, updateHistoryHandoverItemFineWaiver, returnAssetItem, updateAssetStatus, addAssetDocument, updateAssetDocument, deleteAssetDocument, addAssetService, deleteAssetService, updateAssetServiceDraft, submitAssetServiceDraft, saveOilServiceDetailsDraftHandler, submitOilServiceDetailsHandler, submitTireChangeGarageHandler, completeTireChangeHandler, updateTireChangeQuoteEmployeeRowsHandler, submitMechanicalWorkGarageHandler, completeMechanicalWorkHandler, updateMechanicalWorkQuoteEmployeeRowsHandler, submitBodyWorkGarageHandler, completeBodyWorkHandler, updateBodyWorkQuoteEmployeeRowsHandler, submitAccidentRepairGarageHandler, completeAccidentRepairHandler, updateAccidentRepairQuoteEmployeeRowsHandler, updateOilServiceDatesHandler, updateShopServiceExtendDateHandler, addAssetImage, deleteAssetImage, transferAssetAccessory, manageAccessoryStatus, updateAssetItem, deleteAssetItem, endOfLifeAsset, requestAssetAction, bulkRequestAssetAction, handleAssetActionApproval, finalizeAssetAction, uploadAccessoriesAttachment, requestAccessoryAction, respondAccessoryAction, finalizeAccessoryAction, respondToAssetCreation, bulkRespondToAssetCreation, getBulkAssetDetails, getBulkAssetInventoryForPrint, transferAsset, transferAssigneeAsset, submitDraftForCreationApproval, saveLossDamageFineDraft, getPendingAssetDashboardInbox, deletePendingAssetDashboardInboxItem, getEmployeePreviousAssets } from '../controllers/assetItemController.js';
import { respondVehicleServiceWorkflow, respondVehicleServiceScheduledPeriod } from '../controllers/vehicleServiceWorkflowController.js';
import {
    listVehicleOilServiceTypes,
    addVehicleOilServiceType,
} from '../controllers/vehicleOilServiceTypeController.js';
import {
    listVehicleCarWashTypes,
    addVehicleCarWashType,
} from '../controllers/vehicleCarWashTypeController.js';
import {
    requestOwnerOnDuty,
    getOwnerOnDutyReview,
    respondOwnerOnDuty,
    bulkOnDutyFromLeave,
    requestOnDutyFromOwner,
    getPendingOnDutyRequestFromOwner,
    respondOnDutyAcRequest,
} from '../controllers/ownerOnDutyController.js';
import {
    submitVehicleProfileActivation,
    approveVehicleProfileActivation,
    holdVehicleProfileActivation,
    rejectVehicleProfileActivation,
} from '../controllers/vehicleProfileActivationController.js';
import {
    queueVehicleProfileEdit,
    submitVehicleProfileEdit,
    approveVehicleProfileEdit,
    rejectVehicleProfileEdit,
    applyVehicleProfileSection,
} from '../controllers/vehicleProfileEditController.js';
import {
    submitVehicleDispositionRequest,
    respondVehicleDispositionHr,
    submitVehicleDispositionFinance,
} from '../controllers/vehicleDispositionWorkflowController.js';
import {
    submitVehicleInspectionRequest,
    submitVehicleReinspectionRequest,
    submitInspectionHandoverForHr,
    approveVehicleInspection,
    rejectVehicleInspection,
    updateHistoryVehicleInspectionForm,
} from '../controllers/vehicleInspectionController.js';
import {
    submitVehicleMortgageClose,
    approveVehicleMortgageClose,
    rejectVehicleMortgageClose,
} from '../controllers/vehicleMortgageCloseController.js';
import { protect } from '../middleware/authMiddleware.js';
import { downloadAssetListPdf } from '../controllers/asset/downloadAssetListPdf.js';
import {
    isUserInFlowchart,
    getDepartmentHOD,
    isUserActiveCompanyAssetCoordinator,
    isUserCompanyAssetCoordinator
} from '../utils/getDepartmentHOD.js';
import { isUserAdministrator, hasPermission } from '../services/permissionService.js';
import { isJwtSystemSuperUser } from '../utils/systemSuperUser.js';

const normEmp = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');

/**
 * Fleet vehicle assets (plate or vehicle-like category). Used to relax middleware so
 * profile/document edits are not limited to Asset Controller + assignee only.
 */
const isVehicleAssetLean = (assetQuick) => {
    if (!assetQuick) return false;
    const plate = String(assetQuick.plateNumber || '').trim();
    const typeName =
        assetQuick.typeId && typeof assetQuick.typeId === 'object' && assetQuick.typeId.name
            ? String(assetQuick.typeId.name)
            : '';
    const tn = typeName.toLowerCase();
    return (
        !!plate ||
        tn.includes('vehicle') ||
        tn.includes('car') ||
        tn.includes('fleet') ||
        tn.includes('truck')
    );
};

/** JWT / env system admin — aligned with asset controllers (not only isAdmin boolean). */
const isAdminForAssetRoutes = async (user) => {
    if (!user) return false;
    if (isJwtSystemSuperUser(user)) return true;
    if (user.id || user._id) {
        const uid = user.id || user._id;
        return await isUserAdministrator(uid);
    }
    return false;
};

/** Flowchart row match OR same employee as getDepartmentHOD('assetcontroller') (designated AC). */
const isDesignatedAssetController = async (user) => {
    if (!user) return false;
    if (await isUserInFlowchart(user, 'assetcontroller')) return true;
    const hod = await getDepartmentHOD('assetcontroller');
    if (hod) {
        if (hod._id && user.employeeObjectId && hod._id.toString() === user.employeeObjectId.toString()) return true;
        if (hod.employeeId && user.employeeId && normEmp(hod.employeeId) === normEmp(user.employeeId)) return true;
    }
    const uid = user.id || user._id;
    if (uid && await hasPermission(uid, 'hrm_asset', 'edit')) return true;
    return false;
};

const isDesignatedHr = async (user) => {
    if (!user) return false;
    if (await isUserInFlowchart(user, 'hr')) return true;
    const hod = await getDepartmentHOD('hr');
    if (!hod) return false;
    if (hod._id && user.employeeObjectId && hod._id.toString() === user.employeeObjectId.toString()) return true;
    if (hod.employeeId && user.employeeId && normEmp(hod.employeeId) === normEmp(user.employeeId)) return true;
    return false;
};

/** Flowchart Admin Officer (admincontroller) — assigns fleet vehicles from the pool. */
const isDesignatedAdminOfficer = async (user) => {
    if (!user) return false;
    if (await isUserInFlowchart(user, 'admincontroller')) return true;
    const hod = await getDepartmentHOD('admincontroller');
    if (!hod) return false;
    if (hod._id && user.employeeObjectId && hod._id.toString() === user.employeeObjectId.toString()) return true;
    if (hod.employeeId && user.employeeId && normEmp(hod.employeeId) === normEmp(user.employeeId)) return true;
    return false;
};

/**
 * Tools: Asset Controller or portal Administrator.
 * Fleet vehicles: also flowchart Admin Officer (and HR / current assignee for reassign flows).
 */
const requireAssetAssignAccess = async (req, res, next) => {
    try {
        const isAdminUser = await isAdminForAssetRoutes(req.user);
        const isAssetControllerUser = await isDesignatedAssetController(req.user);
        if (isAdminUser || isAssetControllerUser) return next();

        const { id } = req.params;
        if (id) {
            const AssetItem = (await import('../models/AssetItem.js')).default;
            const assetQuick = await AssetItem.findById(id)
                .populate('typeId', 'name')
                .select('plateNumber typeId assignedTo status')
                .lean()
                .catch(() => null);
            if (assetQuick && isVehicleAssetLean(assetQuick)) {
                // Align with assignAssetItem / userCanAssignFleetVehicleAssets
                const isAdminOfficer = await isDesignatedAdminOfficer(req.user);
                if (isAdminOfficer) return next();

                const isHrUser = await isDesignatedHr(req.user);
                if (isHrUser) return next();

                let currentEmpId = req.user?.employeeObjectId?.toString();
                if (!currentEmpId && req.user?.employeeId) {
                    const me = await EmployeeBasic.findOne({
                        employeeId: { $regex: new RegExp(`^${String(req.user.employeeId).replace(/\s+/g, '\\s*')}$`, 'i') }
                    }).select('_id').lean().catch(() => null);
                    if (me?._id) currentEmpId = me._id.toString();
                }
                const isAssignedVehicle =
                    String(assetQuick.status || '').trim() === 'Assigned' && !!assetQuick.assignedTo;
                if (
                    isAssignedVehicle &&
                    currentEmpId &&
                    assetQuick.assignedTo.toString() === currentEmpId
                ) {
                    return next();
                }

                return res.status(403).json({
                    message: 'Access denied. Only the flowchart Admin Officer can assign fleet vehicles.'
                });
            }
        }

        return res.status(403).json({
            message: 'Access denied. Only Asset Controller or Administrator can assign assets.'
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Middleware to restrict access to Asset Controller or Admin only.
 * Used for creating assets, assigning, and operations on UNASSIGNED assets.
 */
const requireAssetControllerOrAdmin = async (req, res, next) => {
    try {
        const isAdminUser = await isAdminForAssetRoutes(req.user);
        const isAssetControllerUser = await isDesignatedAssetController(req.user);

        if (isAdminUser || isAssetControllerUser) return next();

        const { id } = req.params;
        const pathNoQueryAc = String(req.originalUrl || req.url || '').split('?')[0];
        const isVehicleDocumentDelete = req.method === 'DELETE' && id && /\/document\/[^/]+$/.test(pathNoQueryAc);
        const isVehicleImageDelete = req.method === 'DELETE' && id && /\/images\/[^/]+$/.test(pathNoQueryAc);
        if (isVehicleDocumentDelete || isVehicleImageDelete) {
            const AssetItem = (await import('../models/AssetItem.js')).default;
            const assetQuick = await AssetItem.findById(id)
                .populate('typeId', 'name')
                .select('plateNumber typeId')
                .lean()
                .catch(() => null);
            if (isVehicleAssetLean(assetQuick)) return next();
        }

        // If not controller, check if they are the assigned user (for certain operations like transfer request)
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const { fromId, assetId: bodyAssetId, assetIds } = body;
        const targetId = id || fromId || bodyAssetId;

        if (targetId) {
            const AssetItem = (await import('../models/AssetItem.js')).default;
            const asset = await AssetItem.findById(targetId).select('assignedTo assignedBy createdBy status');
            let currentEmpId = req.user?.employeeObjectId?.toString();
            if (!currentEmpId && req.user?.employeeId) {
                const me = await EmployeeBasic.findOne({
                    employeeId: { $regex: new RegExp(`^${String(req.user.employeeId).replace(/\s+/g, '\\s*')}$`, 'i') }
                }).select('_id').lean().catch(() => null);
                if (me?._id) currentEmpId = me._id.toString();
            }

            // Allow if seeking to manage their own assigned asset
            if (asset && asset.assignedTo && asset.assignedTo.toString() === currentEmpId) {
                return next();
            }

            // Allow current assigner to reassign/manage this asset
            if (asset && asset.assignedBy && asset.assignedBy.toString() === currentEmpId) {
                return next();
            }

            // Allow if they are the creator of a draft / pending approval / rejected (creation rework) item
            const currentUserId = req.user?._id?.toString();
            const creatorMayManageCreation =
                asset.status === 'Draft' ||
                asset.status === 'Pending' ||
                asset.status === 'Rejected' ||
                asset.status === 'Submitted for Approval';
            if (asset && asset.createdBy?.toString() === currentUserId && creatorMayManageCreation) {
                return next();
            }
        }

        // Bulk check
        if (assetIds && Array.isArray(assetIds) && assetIds.length > 0) {
            const AssetItem = (await import('../models/AssetItem.js')).default;
            const assets = await AssetItem.find({ _id: { $in: assetIds } });
            const currentEmpId = req.user?.employeeObjectId?.toString();
            if (currentEmpId && assets.length > 0) {
                const allOwned = assets.every(a => a.assignedTo?.toString() === currentEmpId);
                if (allOwned && assets.length === assetIds.length) {
                    return next();
                }
            }
        }

        return res.status(403).json({
            message: 'Access denied. Only the Designated Asset Controller or the assigned employee can perform this operation.'
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Allows approval when the logged-in user is:
 * - Admin or designated Asset Controller, OR
 * - The designated approver stored in `asset.actionRequiredBy` (e.g., HR HOD for company allocations).
 *
 * This is required because `respondToAssetCreation` already enforces the real authorization,
 * but this route was previously blocked by `requireAssetControllerOrAdmin`.
 */
const requireAssetCreationApprover = async (req, res, next) => {
    try {
        const isAdminUser = await isAdminForAssetRoutes(req.user);
        const isAssetControllerUser = await isDesignatedAssetController(req.user);
        const isHrUser = await isDesignatedHr(req.user);

        if (isAdminUser || isAssetControllerUser) return next();

        const { id } = req.params;
        if (!id) {
            return res.status(400).json({ message: 'Asset id is required' });
        }

        const AssetItem = (await import('../models/AssetItem.js')).default;
        const asset = await AssetItem.findById(id).select('status actionRequiredBy createdBy plateNumber').lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const awaitingCreation =
            asset.status === 'Submitted for Approval' ||
            asset.status === 'Pending' ||
            (asset.status === 'Draft' && asset.actionRequiredBy);
        if (!awaitingCreation) {
            return res.status(409).json({ message: 'This approval request was already processed.' });
        }

        const fleetVehicle = !!(asset.plateNumber && String(asset.plateNumber).trim());
        if (fleetVehicle && isHrUser) return next();

        if (!asset.actionRequiredBy) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const currentEmpObjId = req.user?.employeeObjectId?.toString?.() || null;
        const currentEmpId = req.user?.employeeId || null;

        if (currentEmpObjId && asset.actionRequiredBy.toString() === currentEmpObjId) {
            return next();
        }

        if (currentEmpId) {
            const approverEmp = await EmployeeBasic.findById(asset.actionRequiredBy)
                .select('employeeId')
                .lean()
                .catch(() => null);

            if (approverEmp?.employeeId && normEmp(approverEmp.employeeId) === normEmp(currentEmpId)) {
                return next();
            }
        }

        return res.status(403).json({ message: 'Access denied. Only the designated approver can approve this asset.' });
    } catch (error) {
        next(error);
    }
};

/**
 * Middleware for Asset Action Approval (Loss & Damage / End of Life / Leave).
 * - Admin / designated Asset Controller always allowed.
 * - Otherwise allow the actual workflow approver in `asset.actionRequiredBy`.
 * - Additionally allow flowchart HR for non-company Loss & Damage, and Assigned User/Admin for company assets.
 */
const requireAssetActionApprover = async (req, res, next) => {
    try {
        const isAdminUser = await isAdminForAssetRoutes(req.user);
        const isAssetControllerUser = await isDesignatedAssetController(req.user);
        if (isAdminUser || isAssetControllerUser) return next();

        const { id } = req.params;
        if (!id) return res.status(400).json({ message: 'Asset id is required' });

        const AssetItem = (await import('../models/AssetItem.js')).default;
        const asset = await AssetItem.findById(id).select('actionRequiredBy pendingAction assignedToType assignedCompany pendingActionDetails plateNumber typeId').populate('typeId', 'name').lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const currentEmpObjId = req.user?.employeeObjectId?.toString?.() || null;
        const currentUserId = req.user?._id?.toString?.() || null;

        if (asset.actionRequiredBy && currentEmpObjId && asset.actionRequiredBy.toString() === currentEmpObjId) return next();
        if (asset.actionRequiredBy && currentUserId && asset.actionRequiredBy.toString() === currentUserId) return next();

        const isHR = await isUserInFlowchart(req.user, 'hr').catch(() => false);
        const isCompanyCoordinator = await isUserCompanyAssetCoordinator(req.user).catch(() => false);
        const isCompanyAsset = asset.assignedToType === 'Company' && !!asset.assignedCompany;
        const actionType = asset.pendingAction;
        const isFleetVehicle = isVehicleAssetLean(asset);

        if (
            isFleetVehicle &&
            (actionType === 'Return Asset' || actionType === 'Reassign Asset')
        ) {
            if (isHR) return next();
            const uid = req.user?.id || req.user?._id;
            if (uid) {
                const canFleetEdit =
                    (await hasPermission(uid, 'hrm_asset', 'edit')) ||
                    (await hasPermission(uid, 'hrm_asset_vehicle', 'edit'));
                if (canFleetEdit) return next();
            }
        }

        if (actionType === 'End of Life') {
            const stage = asset.pendingActionDetails?.stage;
            if (stage === 'pending_hr') {
                if (isHR) return next();
            } else if (stage === 'pending_management') {
                const isManagement = await isUserInFlowchart(req.user, 'management').catch(() => false);
                if (isManagement) return next();
            } else if (stage === 'pending_assetcontroller') {
                if (isAssetControllerUser) return next();
            }
        }

        if (isHR && actionType === 'Loss and Damage' && !isCompanyAsset) return next();
        if (isCompanyCoordinator && actionType === 'Loss and Damage' && isCompanyAsset) return next();

        return res.status(403).json({ message: 'Access denied. Only designated approver can approve this asset action.' });
    } catch (error) {
        next(error);
    }
};

/**
 * Middleware for granular asset CRUD operations.
 * 1. If asset is UNASSIGNED: Only Asset Controller or Admin (except POST add-service on vehicles — see below).
 * 2. If asset is ASSIGNED: Asset Controller, Admin, or the ASSIGNED USER (plus company/HR flows as implemented).
 * 3. POST `/:id/service` on a vehicle asset: any authenticated user (fleet flow is enforced in `addAssetService`).
 */
const requireAssetFullAccess = async (req, res, next) => {
    try {
        const { id } = req.params;
        const isAdminUser = await isAdminForAssetRoutes(req.user);
        const isAssetControllerUser = await isDesignatedAssetController(req.user);

        // Admin / designated Asset Controller always have full access.
        if (isAdminUser || isAssetControllerUser) return next();

        if (id) {
            const AssetItem = (await import('../models/AssetItem.js')).default;
            const assetQuickVehicle = await AssetItem.findById(id)
                .populate('typeId', 'name')
                .select('plateNumber typeId')
                .lean()
                .catch(() => null);
            if (isVehicleAssetLean(assetQuickVehicle)) {
                const pathNoQuery = String(req.originalUrl || req.url || '').split('?')[0];
                const isDocumentWrite =
                    /\/document/.test(pathNoQuery) && (req.method === 'POST' || req.method === 'PUT');
                const isAddImage = req.method === 'POST' && pathNoQuery.endsWith('/images');
                if (isDocumentWrite || isAddImage) return next();
            }
        }

        // Vehicle fleet / vehicle asset detail "Add service request": any logged-in user may POST
        // (controller enforces `serviceRequestSource` in `vehicle_fleet_dashboard` | `vehicle_asset_detail`
        // for vehicles). Avoids blocking unassigned fleet vehicles that only AC could touch before.
        if (id && req.method === 'POST') {
            const pathNoQuery = String(req.originalUrl || req.url || '').split('?')[0];
            if (pathNoQuery.endsWith('/service') && !pathNoQuery.includes('service-workflow')) {
                const AssetItem = (await import('../models/AssetItem.js')).default;
                const assetQuick = await AssetItem.findById(id)
                    .populate('typeId', 'name')
                    .select('plateNumber typeId')
                    .lean();
                if (assetQuick && isVehicleAssetLean(assetQuick)) return next();
            }
        }

        // Check for specific employee permissions (Assigned User or Action Required By)
        let currentEmpId = req.user?.employeeObjectId?.toString();
        const currentUserId = req.user?._id?.toString();
        if (!currentEmpId && req.user?.employeeId) {
            const me = await EmployeeBasic.findOne({
                employeeId: { $regex: new RegExp(`^${String(req.user.employeeId).replace(/\s+/g, '\\s*')}$`, 'i') }
            }).select('_id').lean().catch(() => null);
            if (me?._id) currentEmpId = me._id.toString();
        }

        if (id) {
            const AssetItem = (await import('../models/AssetItem.js')).default;
            const asset = await AssetItem.findById(id).select('assignedTo assignedToType assignedCompany status actionRequiredBy createdBy actionRequiredBy accessories');
            if (asset) {
                const assignedToEmpId = asset.assignedTo ? asset.assignedTo.toString() : null;
                const actionRequiredById = asset.actionRequiredBy ? asset.actionRequiredBy.toString() : null;
                const accId = req.params?.accId?.toString?.();

                if (asset.assignedToType === 'Company') {
                    const currentEmployeeObjectId = req.user?.employeeObjectId?.toString?.() || null;
                    const currentEmployeeId = req.user?.employeeId || null;

                    const isCompanyCoordinatorActive = await isUserActiveCompanyAssetCoordinator(
                        req.user?.employeeObjectId,
                        req.user?.employeeId
                    ).catch(() => false);
                    if (isCompanyCoordinatorActive) return next();

                    const isHRFlowchart = await isUserInFlowchart(req.user, 'hr').catch(() => false);
                    const hrHOD = await getDepartmentHOD('hr').catch(() => null);
                    const isHrHod =
                        !!(hrHOD?._id && currentEmployeeObjectId && hrHOD._id.toString() === currentEmployeeObjectId);

                    if (isHRFlowchart || isHrHod) return next();

                    if (asset.assignedCompany && (currentEmployeeObjectId || currentEmployeeId)) {
                        const Company = (await import('../models/Company.js')).default;
                        const escapeRegExp = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const employeeIdPattern = currentEmployeeId
                            ? new RegExp(`^${escapeRegExp(String(currentEmployeeId).trim()).replace(/\s+/g, '\\s*')}$`, 'i')
                            : null;

                        const respOr = [];
                        if (currentEmployeeObjectId) respOr.push({ empObjectId: currentEmployeeObjectId });
                        if (employeeIdPattern) respOr.push({ employeeId: { $regex: employeeIdPattern } });

                        const hasCompanyResponsibility =
                            respOr.length > 0
                                ? await Company.exists({
                                    _id: asset.assignedCompany,
                                    responsibilities: {
                                        $elemMatch: {
                                            category: {
                                                $regex:
                                                    /hr|human|assigned\s*user|assigneduser|admin\s*controller|admincontroller|^admin$/i
                                            },
                                            status: 'Active',
                                            $or: respOr
                                        }
                                    }
                                }).catch(() => false)
                                : false;

                        if (hasCompanyResponsibility) return next();
                    }
                }

                // For assignment response flow, allow the designated responder first.
                // Reassignment keeps old holder in assignedTo until acceptance, so this is required.
                if (req.originalUrl?.includes('/respond') && actionRequiredById && actionRequiredById === currentEmpId) {
                    return next();
                }

                // Employee assignment: STRICTLY allow only assigned employee or (if no ERP access) their primaryReportee.
                if (assignedToEmpId) {
                    // Special case: accessory transfer approval can be actioned by workflow participants
                    // (target assigned employee and source assigner/holder), even if they are not source-assigned user.
                    if (accId) {
                        const pendingAccessory = (asset.accessories || []).find(a =>
                            (a?._id?.toString?.() === accId) || (a?.accessoryId?.toString?.() === accId)
                        );
                        if (pendingAccessory?.pendingAction === 'Transfer') {
                            // For transfer response/finalization, do not hard-block in middleware.
                            // Controller-level logic performs the final approver authorization.
                            if (
                                req.originalUrl?.includes('/respond-action') ||
                                req.originalUrl?.includes('/finalize-action')
                            ) {
                                return next();
                            }

                            const transferTargetApproverId = pendingAccessory.pendingActionDetails?.targetApproverId?.toString?.() || pendingAccessory.pendingActionDetails?.targetApproverId;
                            const transferSourceApproverId = pendingAccessory.pendingActionDetails?.sourceApproverId?.toString?.() || pendingAccessory.pendingActionDetails?.sourceApproverId;
                            if (
                                (transferTargetApproverId && transferTargetApproverId.toString() === currentEmpId) ||
                                (transferSourceApproverId && transferSourceApproverId.toString() === currentEmpId)
                            ) {
                                return next();
                            }
                        }
                    }

                    if (assignedToEmpId === currentEmpId) return next();

                    // Delegate allowed only when the assigned employee has NO ERP portal access
                    const assignedEmp = await EmployeeBasic.findById(asset.assignedTo)
                        .select('primaryReportee employeeId')
                        .lean()
                        .catch(() => null);

                    const managerId = assignedEmp?.primaryReportee ? assignedEmp.primaryReportee.toString() : null;

                    const assignedEmployeeUser = assignedEmp?.employeeId
                        ? await User.findOne({ employeeId: assignedEmp.employeeId, status: 'Active' })
                            .select('enablePortalAccess')
                            .lean()
                            .catch(() => null)
                        : null;

                    const assignedHasPortalAccess = assignedEmployeeUser?.enablePortalAccess === true;

                    const delegateAllowed = !!(
                        managerId &&
                        managerId === currentEmpId &&
                        assignedHasPortalAccess === false
                    );

                    if (delegateAllowed) return next();

                    return res.status(403).json({
                        message: 'Access denied. Only the assigned employee or their primary reportee can respond to this approval.'
                    });
                }

                // Company assignment (assignedTo is empty): allow if actionRequiredBy matches
                // (keep original behavior for non-employee flows)
                // 1. Allow if Action Required By matches
                if (asset.actionRequiredBy && asset.actionRequiredBy.toString() === currentEmpId) return next();
                if (asset.actionRequiredBy && asset.actionRequiredBy.toString() === currentUserId) return next();

                // 2. Allow if Creator + Draft/Pending/Rejected (rework)
                if (
                    asset.createdBy?.toString() === currentUserId &&
                    (asset.status === 'Draft' || asset.status === 'Pending' || asset.status === 'Rejected')
                ) {
                    return next();
                }

                // For company flows, allow asset controller/admin as before
                if (isAdminUser || isAssetControllerUser) return next();
            }
        }

        const bulkBody = req.body && typeof req.body === 'object' ? req.body : {};
        const { assetIds } = bulkBody;
        if (assetIds && Array.isArray(assetIds) && assetIds.length > 0) {
            const AssetItem = (await import('../models/AssetItem.js')).default;
            const assets = await AssetItem.find({ _id: { $in: assetIds } }).select('assignedTo status actionRequiredBy assignedToType assignedCompany');
            const isCompanyCoordinatorActive = await isUserActiveCompanyAssetCoordinator(
                req.user?.employeeObjectId,
                req.user?.employeeId
            ).catch(() => false);

            const allPermitted = assets.every(a => {
                const isAssignedUser = a.assignedTo && a.assignedTo.toString() === currentEmpId;
                const isActionRequiredByMe = a.actionRequiredBy && (a.actionRequiredBy.toString() === currentEmpId || a.actionRequiredBy.toString() === currentUserId);
                const isCompanyAssigned = a.assignedToType === 'Company' && !!a.assignedCompany;
                const isCompanyCoordinatorForCompanyAsset = isCompanyCoordinatorActive && isCompanyAssigned;
                return isAssignedUser || isActionRequiredByMe || isCompanyCoordinatorForCompanyAsset;
            });

            if (allPermitted && assets.length === assetIds.length) return next();
        }

        return res.status(403).json({
            message: 'Access denied. Only the Designated Asset Controller or the assigned employee can perform this action.'
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Return asset: Admin / designated Asset Controller, or the employee assigned to the asset (not unassigned inventory).
 */
const requireReturnAssetAccess = async (req, res, next) => {
    try {
        const isAdminUser = await isAdminForAssetRoutes(req.user);
        const isAssetControllerUser = await isDesignatedAssetController(req.user);
        if (isAdminUser || isAssetControllerUser) return next();

        const { id } = req.params;
        let currentEmpId = req.user?.employeeObjectId?.toString();
        if (!currentEmpId && req.user?.employeeId) {
            const emp = await EmployeeBasic.findOne({
                employeeId: { $regex: new RegExp(`^${String(req.user.employeeId).replace(/\s+/g, '\\s*')}$`, 'i') }
            })
                .select('_id')
                .lean();
            if (emp) currentEmpId = emp._id.toString();
        }

        if (!id || !currentEmpId) {
            return res.status(403).json({
                message: 'Access denied. Only the assigned employee, Asset Controller, or an administrator can return this asset.'
            });
        }

        const AssetItem = (await import('../models/AssetItem.js')).default;
        const asset = await AssetItem.findById(id)
            .populate('typeId', 'name')
            .select('assignedTo assignedToType assignedCompany plateNumber typeId')
            .lean();
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        if (isVehicleAssetLean(asset)) {
            const isHrUser = await isDesignatedHr(req.user);
            if (isHrUser) return next();
        }

        // Company-assigned assets: allow active flowchart company coordinators
        // (Assigned User/Admin Controller) to process returns.
        if (asset.assignedToType === 'Company' && asset.assignedCompany) {
            const isCompanyCoordinatorActive = await isUserActiveCompanyAssetCoordinator(
                req.user?.employeeObjectId,
                req.user?.employeeId
            ).catch(() => false);
            if (isCompanyCoordinatorActive) return next();
        }

        if (asset.assignedTo && asset.assignedTo.toString() === currentEmpId) {
            return next();
        }

        return res.status(403).json({
            message: 'Access denied. Only the assigned employee, flowchart Assigned User/Admin, Asset Controller, or an administrator can return this asset.'
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Parking actions: only assigned employee of that parked asset, Asset Controller, or Admin.
 */
const requireParkingAssetAccess = async (req, res, next) => {
    try {
        const isAdminUser = await isAdminForAssetRoutes(req.user);
        const isAssetControllerUser = await isDesignatedAssetController(req.user);
        if (isAdminUser || isAssetControllerUser) return next();

        const { id } = req.params;
        let currentEmpId = req.user?.employeeObjectId?.toString();
        if (!currentEmpId && req.user?.employeeId) {
            const emp = await EmployeeBasic.findOne({
                employeeId: { $regex: new RegExp(`^${String(req.user.employeeId).replace(/\s+/g, '\\s*')}$`, 'i') }
            }).select('_id').lean().catch(() => null);
            if (emp?._id) currentEmpId = emp._id.toString();
        }

        if (!id || !currentEmpId) {
            return res.status(403).json({ message: 'Access denied. Only assigned user, Asset Controller, or Admin can perform parking actions.' });
        }

        const AssetItem = (await import('../models/AssetItem.js')).default;
        const asset = await AssetItem.findById(id).select('assignedTo status');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const isOnLeave = String(asset.status || '').toLowerCase().trim() === 'on leave';
        const isAssignedUser = asset.assignedTo && asset.assignedTo.toString() === currentEmpId;
        if (isOnLeave && isAssignedUser) return next();

        return res.status(403).json({ message: 'Access denied. Only assigned user, Asset Controller, or Admin can perform parking actions.' });
    } catch (error) {
        next(error);
    }
};

const router = express.Router();

router.route('/')
    .post(protect, createAssetItem);

router.get('/dashboard/pending-inbox', protect, getPendingAssetDashboardInbox);
router.delete('/dashboard/pending-inbox/:id', protect, deletePendingAssetDashboardInboxItem);
router.post('/owner-on-duty/request', protect, requestOwnerOnDuty);
router.post('/owner-on-duty/request-from-owner', protect, requestOnDutyFromOwner);
router.get('/owner-on-duty/pending-owner-request/:assetId', protect, getPendingOnDutyRequestFromOwner);
router.put('/owner-on-duty/respond-ac-request', protect, respondOnDutyAcRequest);
router.put('/bulk/on-duty-from-leave', protect, requireAssetControllerOrAdmin, bulkOnDutyFromLeave);
router.get('/owner-on-duty/review/:dashboardActionId', protect, getOwnerOnDutyReview);
router.put('/owner-on-duty/respond', protect, respondOwnerOnDuty);
router.get('/vehicle-fleet-dashboard', protect, getVehicleFleetDashboard);
router.get('/next-fleet-vehicle-id', protect, getNextFleetVehicleAssetId);
router.get('/vehicle-fleet-service-requests', protect, getVehicleFleetServiceRequests);
router.get('/assigned/all', protect, getAllAssignedAssets);
router.get('/assigned/me-for-return', protect, getMyAssignedAssetsForReturn);
router.get('/unassigned/controller/:employeeId', protect, getUnassignedAssetsForEmployee);
router.get('/on-leave/controller/:employeeId', protect, getOnLeaveAssetsForEmployee);
router.post('/on-service/run-overdue-check', protect, requireAssetControllerOrAdmin, runAssetServiceOverdueCheck);
router.get('/on-service/controller/:employeeId', protect, getOnServiceAssetsForEmployee);
router.get('/company-allocation/coordinator', protect, getCompanyAllocationCoordinatorStatus);
router.get('/company-assets/hr/:employeeId', protect, getHRCompanyAssets);
router.get('/previous/:employeeId', protect, getEmployeePreviousAssets);
router.get('/asset-list/pdf', protect, downloadAssetListPdf);
router.get('/detail/:id', protect, getAssetItemDetail);
router.get('/bulk/details', protect, getBulkAssetDetails);
router.get('/bulk/print-inventory', protect, getBulkAssetInventoryForPrint);
router.get('/bulk-assignment-pending/:groupId', protect, getBulkAssignmentPendingGroup);
router.put('/bulk-assignment-respond', protect, respondBulkAssignmentGroup);
router.get('/:id/history', protect, getAssetHistory);
router.get('/history-record/:historyId', protect, getHistoryRecord);
router.delete('/history-record/:historyId', protect, deleteVehicleHandoverHistory);
router.post('/handover/upload-photo', protect, uploadHandoverAssessmentPhoto);
router.put('/history-record/:historyId/receiver-assessment', protect, updateHistoryReceiverAssessment);
router.put('/history-record/:historyId/body-condition', protect, updateHistoryBodyCondition);
router.put('/history-record/:historyId/handover-item-fine-waiver', protect, updateHistoryHandoverItemFineWaiver);
router.post('/history-record/:historyId/submit-inspection-for-hr', protect, submitInspectionHandoverForHr);
router.put('/history-record/:historyId/vehicle-inspection-form', protect, updateHistoryVehicleInspectionForm);
router.get('/handover-pdf/:id', protect, downloadHandoverPdf);
router.get('/history-handover-pdf/:historyId', protect, downloadHistoryHandoverPdf);
router.get('/vehicle-handover-pdf/:vehicleId', protect, downloadVehicleHandoverPdf);
router.put('/bulk/assign', protect, requireAssetAssignAccess, bulkAssignAssetItems);
router.put('/bulk/assign-company', protect, requireAssetAssignAccess, bulkAssignAssetItemsToCompany);
router.put('/bulk/on-leave-action', protect, requireAssetControllerOrAdmin, (req, res, next) => {
    bulkHandleOnLeaveAction(req, res, next);
});
router.put('/bulk/on-service-action', protect, requireAssetControllerOrAdmin, (req, res, next) => {
    bulkHandleOnServiceAction(req, res, next);
});
router.put('/:id/assign', protect, requireAssetAssignAccess, assignAssetItem);
router.put('/:id/transfer-assignee', protect, requireAssetControllerOrAdmin, transferAssigneeAsset);
router.put('/:id/respond', protect, respondToAssignment);
router.put('/bulk/respond', protect, bulkRespondToAssignment);
router.post('/transfer', protect, requireAssetControllerOrAdmin, transferAsset);
router.put('/bulk/approve-creation', protect, requireAssetControllerOrAdmin, bulkRespondToAssetCreation);
router.put('/:id/approve-creation', protect, requireAssetCreationApprover, respondToAssetCreation);
router.put('/:id/submit-creation', protect, submitDraftForCreationApproval);
router.post('/:id/submit-vehicle-profile-activation', protect, submitVehicleProfileActivation);
router.post('/:id/approve-vehicle-profile-activation', protect, approveVehicleProfileActivation);
router.post('/:id/hold-vehicle-profile-activation', protect, holdVehicleProfileActivation);
router.post('/:id/reject-vehicle-profile-activation', protect, rejectVehicleProfileActivation);
router.post('/:id/queue-vehicle-profile-edit', protect, queueVehicleProfileEdit);
router.post('/:id/submit-vehicle-profile-edit', protect, submitVehicleProfileEdit);
router.post('/:id/apply-vehicle-profile-section', protect, applyVehicleProfileSection);
router.post('/:id/approve-vehicle-profile-edit', protect, approveVehicleProfileEdit);
router.post('/:id/reject-vehicle-profile-edit', protect, rejectVehicleProfileEdit);
router.post('/:id/submit-vehicle-inspection-request', protect, submitVehicleInspectionRequest);
router.post('/:id/submit-vehicle-reinspection-request', protect, submitVehicleReinspectionRequest);
router.post('/:id/approve-vehicle-inspection', protect, approveVehicleInspection);
router.post('/:id/reject-vehicle-inspection', protect, rejectVehicleInspection);
router.post('/:id/submit-vehicle-mortgage-close', protect, submitVehicleMortgageClose);
router.post('/:id/approve-vehicle-mortgage-close', protect, approveVehicleMortgageClose);
router.post('/:id/reject-vehicle-mortgage-close', protect, rejectVehicleMortgageClose);
router.post('/:id/submit-vehicle-disposition-request', protect, submitVehicleDispositionRequest);
router.post('/:id/respond-vehicle-disposition-hr', protect, respondVehicleDispositionHr);
router.post('/:id/submit-vehicle-disposition-finance', protect, submitVehicleDispositionFinance);
router.put('/:id/return', protect, requireReturnAssetAccess, returnAssetItem);
router.put('/:id/on-leave-action', protect, requireParkingAssetAccess, (req, res, next) => {
    handleOnLeaveAction(req, res, next);
});
router.put('/:id/on-service-action', protect, requireAssetControllerOrAdmin, (req, res, next) => {
    handleOnServiceAction(req, res, next);
});
router.put('/:id/status', protect, requireAssetFullAccess, updateAssetStatus);
router.post('/:id/document', protect, requireAssetFullAccess, addAssetDocument);
router.put('/:id/document/:docId', protect, requireAssetFullAccess, updateAssetDocument);
router.delete('/:id/document/:docId', protect, requireAssetControllerOrAdmin, deleteAssetDocument);
router.get('/oil-service-types', protect, listVehicleOilServiceTypes);
router.post('/oil-service-types', protect, addVehicleOilServiceType);
router.get('/car-wash-types', protect, listVehicleCarWashTypes);
router.post('/car-wash-types', protect, addVehicleCarWashType);

router.post('/:id/service', protect, requireAssetFullAccess, addAssetService);
router.delete('/:id/service/:serviceId', protect, requireAssetFullAccess, deleteAssetService);
router.put('/:id/service/:serviceId', protect, requireAssetFullAccess, updateAssetServiceDraft);
router.post('/:id/service/:serviceId/submit-request', protect, requireAssetFullAccess, submitAssetServiceDraft);
router.put('/:id/service/:serviceId/oil-dates', protect, requireAssetFullAccess, updateOilServiceDatesHandler);
router.put('/:id/service/:serviceId/extend-date', protect, requireAssetFullAccess, updateShopServiceExtendDateHandler);
router.post('/:id/service/:serviceId/oil-details/save', protect, requireAssetFullAccess, saveOilServiceDetailsDraftHandler);
router.post('/:id/service/:serviceId/oil-details/submit', protect, requireAssetFullAccess, submitOilServiceDetailsHandler);
router.put('/:id/service/:serviceId/tire-change/garage', protect, requireAssetFullAccess, submitTireChangeGarageHandler);
router.put(
    '/:id/service/:serviceId/tire-change/quote-employees',
    protect,
    requireAssetFullAccess,
    updateTireChangeQuoteEmployeeRowsHandler,
);
router.post('/:id/service/:serviceId/tire-change/complete', protect, requireAssetFullAccess, completeTireChangeHandler);
router.put('/:id/service/:serviceId/mechanical-work/garage', protect, requireAssetFullAccess, submitMechanicalWorkGarageHandler);
router.put(
    '/:id/service/:serviceId/mechanical-work/quote-employees',
    protect,
    requireAssetFullAccess,
    updateMechanicalWorkQuoteEmployeeRowsHandler,
);
router.post('/:id/service/:serviceId/mechanical-work/complete', protect, requireAssetFullAccess, completeMechanicalWorkHandler);
router.put('/:id/service/:serviceId/body-work/garage', protect, requireAssetFullAccess, submitBodyWorkGarageHandler);
router.put(
    '/:id/service/:serviceId/body-work/quote-employees',
    protect,
    requireAssetFullAccess,
    updateBodyWorkQuoteEmployeeRowsHandler,
);
router.post('/:id/service/:serviceId/body-work/complete', protect, requireAssetFullAccess, completeBodyWorkHandler);
router.put('/:id/service/:serviceId/accident-repair/garage', protect, requireAssetFullAccess, submitAccidentRepairGarageHandler);
router.put(
    '/:id/service/:serviceId/accident-repair/quote-employees',
    protect,
    requireAssetFullAccess,
    updateAccidentRepairQuoteEmployeeRowsHandler,
);
router.post('/:id/service/:serviceId/accident-repair/complete', protect, requireAssetFullAccess, completeAccidentRepairHandler);
router.post('/:id/service-workflow/respond', protect, respondVehicleServiceWorkflow);
router.post('/:id/service-workflow/period', protect, respondVehicleServiceScheduledPeriod);
router.post('/:id/images', protect, requireAssetFullAccess, addAssetImage);
router.delete('/:id/images/:imageId', protect, requireAssetControllerOrAdmin, deleteAssetImage);

router.route('/:id')
    .put(protect, requireAssetControllerOrAdmin, updateAssetItem)
    .delete(protect, requireAssetControllerOrAdmin, deleteAssetItem);

router.put('/:id/end-of-life', protect, requireAssetFullAccess, endOfLifeAsset);
router.put('/bulk/request-action', protect, requireAssetFullAccess, bulkRequestAssetAction);
router.put('/:id/request-action', protect, requireAssetFullAccess, requestAssetAction);
router.put('/:id/loss-damage-fine-draft', protect, requireAssetFullAccess, saveLossDamageFineDraft);
router.put('/:id/approve-action', protect, requireAssetActionApprover, handleAssetActionApproval);
router.put('/:id/finalize-action', protect, requireAssetControllerOrAdmin, finalizeAssetAction);

// Accessories
router.put('/:id/accessories/:accId/transfer', protect, requireAssetControllerOrAdmin, transferAssetAccessory);
router.put('/:id/accessories/:accId/status', protect, requireAssetFullAccess, manageAccessoryStatus);
router.put('/:id/accessories-attachment', protect, requireAssetFullAccess, uploadAccessoriesAttachment);
router.put('/:id/accessories/:accId/request-action', protect, requireAssetFullAccess, requestAccessoryAction);
// Accessory approval response: Asset Controller/Admin must always be able to act.
router.put('/:id/accessories/:accId/respond-action', protect, requireAssetFullAccess, respondAccessoryAction);
router.put('/:id/accessories/:accId/finalize-action', protect, requireAssetFullAccess, finalizeAccessoryAction);

router.route('/:typeId')
    .get(protect, getAssetItems);

export default router;
