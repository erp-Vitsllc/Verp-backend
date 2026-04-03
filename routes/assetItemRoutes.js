import express from 'express';
import EmployeeBasic from '../models/EmployeeBasic.js';
import User from '../models/User.js';
import { createAssetItem, getAssetItems, getAllAssignedAssets, getMyAssignedAssetsForReturn, getUnassignedAssetsForEmployee, getHRCompanyAssets, getOnLeaveAssetsForEmployee, handleOnLeaveAction, bulkHandleOnLeaveAction, getAssetItemDetail, assignAssetItem, bulkAssignAssetItems, downloadHandoverPdf, downloadHistoryHandoverPdf, respondToAssignment, bulkRespondToAssignment, getAssetHistory, getHistoryRecord, returnAssetItem, updateAssetStatus, addAssetDocument, updateAssetDocument, deleteAssetDocument, addAssetService, addAssetImage, deleteAssetImage, transferAssetAccessory, manageAccessoryStatus, updateAssetItem, deleteAssetItem, endOfLifeAsset, requestAssetAction, bulkRequestAssetAction, handleAssetActionApproval, finalizeAssetAction, uploadAccessoriesAttachment, requestAccessoryAction, respondAccessoryAction, finalizeAccessoryAction, respondToAssetCreation, bulkRespondToAssetCreation, getBulkAssetDetails, getBulkAssetInventoryForPrint, transferAsset } from '../controllers/assetItemController.js';
import { protect } from '../middleware/authMiddleware.js';
import { isUserInFlowchart, getDepartmentHOD } from '../utils/getDepartmentHOD.js';
import { isUserAdministrator } from '../services/permissionService.js';

const normEmp = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');

/** JWT / env system admin — aligned with asset controllers (not only isAdmin boolean). */
const isAdminForAssetRoutes = async (user) => {
    if (!user) return false;
    if (user.isAdmin === true || user.role === 'Admin' || user.role === 'ROOT') return true;
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
    if (!hod) return false;
    if (hod._id && user.employeeObjectId && hod._id.toString() === user.employeeObjectId.toString()) return true;
    if (hod.employeeId && user.employeeId && normEmp(hod.employeeId) === normEmp(user.employeeId)) return true;
    return false;
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

        // If not controller, check if they are the assigned user (for certain operations like transfer request)
        const { id } = req.params;
        const { fromId, assetId: bodyAssetId, assetIds } = req.body;
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

            // Allow if they are the creator of a Draft/Pending item
            const currentUserId = req.user?._id?.toString();
            if (asset && asset.createdBy?.toString() === currentUserId && (asset.status === 'Draft' || asset.status === 'Pending')) {
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

        if (isAdminUser || isAssetControllerUser) return next();

        const { id } = req.params;
        if (!id) {
            return res.status(400).json({ message: 'Asset id is required' });
        }

        const AssetItem = (await import('../models/AssetItem.js')).default;
        const asset = await AssetItem.findById(id).select('status actionRequiredBy createdBy').lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        // If there is no actionRequiredBy, only asset controller/admin should approve drafts.
        if (!asset.actionRequiredBy) return res.status(403).json({ message: 'Access denied' });

        const currentEmpObjId = req.user?.employeeObjectId?.toString?.() || null;
        const currentEmpId = req.user?.employeeId || null;

        // Match by EmployeeBasic _id (actionRequiredBy stores EmployeeBasic._id)
        if (currentEmpObjId && asset.actionRequiredBy.toString() === currentEmpObjId) {
            return next();
        }

        // Match by employeeId string (controller uses this fallback too)
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
 * - Additionally allow HR for Loss & Damage approvals (controller logic already checks this).
 */
const requireAssetActionApprover = async (req, res, next) => {
    try {
        const isAdminUser = await isAdminForAssetRoutes(req.user);
        const isAssetControllerUser = await isDesignatedAssetController(req.user);
        if (isAdminUser || isAssetControllerUser) return next();

        const { id } = req.params;
        if (!id) return res.status(400).json({ message: 'Asset id is required' });

        const AssetItem = (await import('../models/AssetItem.js')).default;
        const asset = await AssetItem.findById(id).select('actionRequiredBy pendingAction assignedToType assignedCompany').lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const currentEmpObjId = req.user?.employeeObjectId?.toString?.() || null;
        const currentUserId = req.user?._id?.toString?.() || null;

        if (asset.actionRequiredBy && currentEmpObjId && asset.actionRequiredBy.toString() === currentEmpObjId) return next();
        if (asset.actionRequiredBy && currentUserId && asset.actionRequiredBy.toString() === currentUserId) return next();

        const isHR = await isUserInFlowchart(req.user, 'hr').catch(() => false);
        const actionType = asset.pendingAction;

        if (isHR && actionType === 'Loss and Damage') return next();

        return res.status(403).json({ message: 'Access denied. Only designated approver can approve this asset action.' });
    } catch (error) {
        next(error);
    }
};

/**
 * Middleware for granular asset CRUD operations.
 * 1. If asset is UNASSIGNED: Only Asset Controller or Admin.
 * 2. If asset is ASSIGNED: Asset Controller, Admin, or the ASSIGNED USER.
 */
const requireAssetFullAccess = async (req, res, next) => {
    try {
        const { id } = req.params;
        const isAdminUser = await isAdminForAssetRoutes(req.user);
        const isAssetControllerUser = await isDesignatedAssetController(req.user);

        // Admin / designated Asset Controller always have full access.
        if (isAdminUser || isAssetControllerUser) return next();

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

                // Company-assigned assets: HR should have the same actions as the assigned employee
                // (for those companies HR is responsible for).
                if (asset.assignedToType === 'Company') {
                    const currentEmployeeObjectId = req.user?.employeeObjectId?.toString?.() || null;
                    const currentEmployeeId = req.user?.employeeId || null;

                    const isHRFlowchart = await isUserInFlowchart(req.user, 'hr').catch(() => false);
                    const hrHOD = await getDepartmentHOD('hr').catch(() => null);
                    const isHrHod =
                        !!(hrHOD?._id && currentEmployeeObjectId && hrHOD._id.toString() === currentEmployeeObjectId);

                    if (isHRFlowchart || isHrHod) return next();

                    // If not global HR, allow only when HR has an active responsibility for this company.
                    if (asset.assignedCompany && (currentEmployeeObjectId || currentEmployeeId)) {
                        const Company = (await import('../models/Company.js')).default;
                        const escapeRegExp = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const employeeIdPattern = currentEmployeeId
                            ? new RegExp(`^${escapeRegExp(String(currentEmployeeId).trim()).replace(/\s+/g, '\\s*')}$`, 'i')
                            : null;

                        const hrOr = [];
                        if (currentEmployeeObjectId) hrOr.push({ empObjectId: currentEmployeeObjectId });
                        if (employeeIdPattern) hrOr.push({ employeeId: { $regex: employeeIdPattern } });

                        const hasHrResponsibility =
                            hrOr.length > 0
                                ? await Company.exists({
                                    _id: asset.assignedCompany,
                                    responsibilities: {
                                        $elemMatch: {
                                            category: { $regex: /hr|human/i },
                                            status: 'Active',
                                            $or: hrOr
                                        }
                                    }
                                }).catch(() => false)
                                : false;

                        if (hasHrResponsibility) return next();
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

                // 2. Allow if Creator + Draft/Pending
                if (asset.createdBy?.toString() === currentUserId && (asset.status === 'Draft' || asset.status === 'Pending')) return next();

                // For company flows, allow asset controller/admin as before
                if (isAdminUser || isAssetControllerUser) return next();
            }
        }

        const { assetIds } = req.body;
        if (assetIds && Array.isArray(assetIds) && assetIds.length > 0) {
            const AssetItem = (await import('../models/AssetItem.js')).default;
            const assets = await AssetItem.find({ _id: { $in: assetIds } }).select('assignedTo status actionRequiredBy');

            const allPermitted = assets.every(a => {
                const isAssignedUser = a.assignedTo && a.assignedTo.toString() === currentEmpId;
                const isActionRequiredByMe = a.actionRequiredBy && (a.actionRequiredBy.toString() === currentEmpId || a.actionRequiredBy.toString() === currentUserId);
                return isAssignedUser || isActionRequiredByMe;
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
        const asset = await AssetItem.findById(id).select('assignedTo');
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        if (asset.assignedTo && asset.assignedTo.toString() === currentEmpId) {
            return next();
        }

        return res.status(403).json({
            message: 'Access denied. Only the assigned employee, Asset Controller, or an administrator can return this asset.'
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

router.get('/assigned/all', protect, getAllAssignedAssets);
router.get('/assigned/me-for-return', protect, getMyAssignedAssetsForReturn);
router.get('/unassigned/controller/:employeeId', protect, getUnassignedAssetsForEmployee);
router.get('/on-leave/controller/:employeeId', protect, getOnLeaveAssetsForEmployee);
router.get('/company-assets/hr/:employeeId', protect, getHRCompanyAssets);

router.get('/detail/:id', protect, getAssetItemDetail);
router.get('/bulk/details', protect, getBulkAssetDetails);
router.get('/bulk/print-inventory', protect, getBulkAssetInventoryForPrint);
router.get('/:id/history', protect, getAssetHistory);
router.get('/history-record/:historyId', protect, getHistoryRecord);
router.get('/handover-pdf/:id', protect, downloadHandoverPdf);
router.get('/history-handover-pdf/:historyId', protect, downloadHistoryHandoverPdf);
router.put('/bulk/assign', protect, requireAssetControllerOrAdmin, bulkAssignAssetItems);
router.put('/bulk/on-leave-action', protect, requireAssetControllerOrAdmin, (req, res, next) => {
    console.log('[Route] PUT /bulk/on-leave-action hit. Body:', JSON.stringify(req.body));
    bulkHandleOnLeaveAction(req, res, next);
});
router.put('/:id/assign', protect, requireAssetControllerOrAdmin, assignAssetItem);
router.put('/:id/respond', protect, respondToAssignment);
router.put('/bulk/respond', protect, bulkRespondToAssignment);
router.post('/transfer', protect, requireAssetControllerOrAdmin, transferAsset);
router.put('/bulk/approve-creation', protect, requireAssetControllerOrAdmin, bulkRespondToAssetCreation);
router.put('/:id/approve-creation', protect, requireAssetCreationApprover, respondToAssetCreation);
router.put('/:id/return', protect, requireReturnAssetAccess, returnAssetItem);
router.put('/:id/on-leave-action', protect, requireParkingAssetAccess, (req, res, next) => {
    console.log(`[Route] PUT /${req.params.id}/on-leave-action hit`);
    handleOnLeaveAction(req, res, next);
});
router.put('/:id/status', protect, requireAssetFullAccess, updateAssetStatus);
router.post('/:id/document', protect, requireAssetFullAccess, addAssetDocument);
router.put('/:id/document/:docId', protect, requireAssetFullAccess, updateAssetDocument);
router.delete('/:id/document/:docId', protect, requireAssetControllerOrAdmin, deleteAssetDocument);
router.post('/:id/service', protect, requireAssetFullAccess, addAssetService);
router.post('/:id/images', protect, requireAssetFullAccess, addAssetImage);
router.delete('/:id/images/:imageId', protect, requireAssetControllerOrAdmin, deleteAssetImage);

router.route('/:id')
    .put(protect, requireAssetControllerOrAdmin, updateAssetItem)
    .delete(protect, requireAssetControllerOrAdmin, deleteAssetItem);

router.put('/:id/end-of-life', protect, requireAssetFullAccess, endOfLifeAsset);
router.put('/bulk/request-action', protect, requireAssetFullAccess, bulkRequestAssetAction);
router.put('/:id/request-action', protect, requireAssetFullAccess, requestAssetAction);
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
