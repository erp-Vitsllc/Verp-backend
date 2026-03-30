import express from 'express';
import EmployeeBasic from '../models/EmployeeBasic.js';
import User from '../models/User.js';
import { createAssetItem, getAssetItems, getAllAssignedAssets, getUnassignedAssetsForEmployee, getHRCompanyAssets, getOnLeaveAssetsForEmployee, handleOnLeaveAction, bulkHandleOnLeaveAction, getAssetItemDetail, assignAssetItem, bulkAssignAssetItems, downloadHandoverPdf, downloadHistoryHandoverPdf, respondToAssignment, bulkRespondToAssignment, getAssetHistory, getHistoryRecord, returnAssetItem, updateAssetStatus, addAssetDocument, updateAssetDocument, deleteAssetDocument, addAssetService, addAssetImage, deleteAssetImage, transferAssetAccessory, manageAccessoryStatus, updateAssetItem, deleteAssetItem, endOfLifeAsset, requestAssetAction, bulkRequestAssetAction, handleAssetActionApproval, finalizeAssetAction, uploadAccessoriesAttachment, requestAccessoryAction, respondAccessoryAction, finalizeAccessoryAction, respondToAssetCreation, transferAsset } from '../controllers/assetItemController.js';
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
            const asset = await AssetItem.findById(targetId);
            const currentEmpId = req.user?.employeeObjectId?.toString();

            // Allow if seeking to manage their own assigned asset
            if (asset && asset.assignedTo && asset.assignedTo.toString() === currentEmpId) {
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
 * Middleware for granular asset CRUD operations.
 * 1. If asset is UNASSIGNED: Only Asset Controller or Admin.
 * 2. If asset is ASSIGNED: Asset Controller, Admin, or the ASSIGNED USER.
 */
const requireAssetFullAccess = async (req, res, next) => {
    try {
        const { id } = req.params;
        const isAdminUser = await isAdminForAssetRoutes(req.user);
        const isAssetControllerUser = await isDesignatedAssetController(req.user);

        // Check for specific employee permissions (Assigned User or Action Required By)
        const currentEmpId = req.user?.employeeObjectId?.toString();
        const currentUserId = req.user?._id?.toString();

        if (id) {
            const AssetItem = (await import('../models/AssetItem.js')).default;
            const asset = await AssetItem.findById(id).select('assignedTo status actionRequiredBy createdBy');
            if (asset) {
                const assignedToEmpId = asset.assignedTo ? asset.assignedTo.toString() : null;

                // Employee assignment: STRICTLY allow only assigned employee or (if no ERP access) their primaryReportee.
                if (assignedToEmpId) {
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

const router = express.Router();

router.route('/')
    .post(protect, createAssetItem);

router.get('/assigned/all', protect, getAllAssignedAssets);
router.get('/unassigned/controller/:employeeId', protect, getUnassignedAssetsForEmployee);
router.get('/on-leave/controller/:employeeId', protect, getOnLeaveAssetsForEmployee);
router.get('/company-assets/hr/:employeeId', protect, getHRCompanyAssets);

router.get('/detail/:id', protect, getAssetItemDetail);
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
router.put('/:id/respond', protect, requireAssetFullAccess, respondToAssignment);
router.put('/bulk/respond', protect, requireAssetFullAccess, bulkRespondToAssignment);
router.post('/transfer', protect, requireAssetControllerOrAdmin, transferAsset);
router.put('/:id/approve-creation', protect, requireAssetControllerOrAdmin, respondToAssetCreation);
router.put('/:id/return', protect, requireReturnAssetAccess, returnAssetItem);
router.put('/:id/on-leave-action', protect, requireAssetControllerOrAdmin, (req, res, next) => {
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
router.put('/:id/approve-action', protect, requireAssetControllerOrAdmin, handleAssetActionApproval);
router.put('/:id/finalize-action', protect, requireAssetControllerOrAdmin, finalizeAssetAction);

// Accessories
router.put('/:id/accessories/:accId/transfer', protect, requireAssetControllerOrAdmin, transferAssetAccessory);
router.put('/:id/accessories/:accId/status', protect, requireAssetFullAccess, manageAccessoryStatus);
router.put('/:id/accessories-attachment', protect, requireAssetFullAccess, uploadAccessoriesAttachment);
router.put('/:id/accessories/:accId/request-action', protect, requireAssetFullAccess, requestAccessoryAction);
router.put('/:id/accessories/:accId/respond-action', protect, requireAssetFullAccess, respondAccessoryAction);
router.put('/:id/accessories/:accId/finalize-action', protect, requireAssetControllerOrAdmin, finalizeAccessoryAction);

router.route('/:typeId')
    .get(protect, getAssetItems);

export default router;
