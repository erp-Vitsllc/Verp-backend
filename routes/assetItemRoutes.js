import express from 'express';
import { createAssetItem, getAssetItems, getAllAssignedAssets, getUnassignedAssetsForEmployee, getHRCompanyAssets, getOnLeaveAssetsForEmployee, handleOnLeaveAction, getAssetItemDetail, assignAssetItem, bulkAssignAssetItems, downloadHandoverPdf, downloadHistoryHandoverPdf, respondToAssignment, getAssetHistory, getHistoryRecord, returnAssetItem, updateAssetStatus, addAssetDocument, updateAssetDocument, deleteAssetDocument, addAssetService, addAssetImage, deleteAssetImage, transferAssetAccessory, manageAccessoryStatus, updateAssetItem, endOfLifeAsset, requestAssetAction, bulkRequestAssetAction, handleAssetActionApproval, finalizeAssetAction, uploadAccessoriesAttachment, requestAccessoryAction, respondAccessoryAction, finalizeAccessoryAction, respondToAssetCreation, transferAsset } from '../controllers/assetItemController.js';
import { protect } from '../middleware/authMiddleware.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';

/**
 * Middleware to restrict access to Asset Controller or Admin only.
 * Used for creating assets, assigning, and operations on UNASSIGNED assets.
 */
const requireAssetControllerOrAdmin = async (req, res, next) => {
    try {
        const isAdmin = req.user?.isAdmin === true || req.user?.role === 'Admin' || req.user?.role === 'ROOT';
        if (isAdmin) return next();

        const assetController = await getDepartmentHOD('assetcontroller');
        const isAssetControllerRole = req.user?.role === 'Asset Controller' || req.user?.role === 'AssetController' || req.user?.groupName?.includes('Asset') || req.user?.groupName?.includes('Controller');
        const isAssetControllerFlow = assetController && (assetController._id?.toString() === req.user?.employeeObjectId?.toString() || assetController.employeeId === req.user?.employeeId);

        if (!isAssetControllerFlow && !isAssetControllerRole) {
            // For transfer/request-action, also allow if the user is the assigned user of the asset(s)
            const { id } = req.params;
            const { fromId, assetId: bodyAssetId, assetIds } = req.body;

            // Check individual asset
            const targetId = id || fromId || bodyAssetId;
            if (targetId) {
                const AssetItem = (await import('../models/AssetItem.js')).default;
                const asset = await AssetItem.findById(targetId);
                const currentEmpId = req.user?.employeeObjectId?.toString();
                const currentUserId = req.user?._id?.toString();

                // 1. Allow if Assigned User
                if (asset && asset.assignedTo && asset.assignedTo.toString() === currentEmpId) {
                    return next();
                }

                // 2. Allow if Creator + Draft/Pending
                if (asset && asset.createdBy?.toString() === currentUserId && (asset.status === 'Draft' || asset.status === 'Pending')) {
                    return next();
                }
            }

            // Check bulk assets (allow only if user owns ALL of them)
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

            return res.status(403).json({ message: 'Access denied. Only Asset Controller, Admin, or the assigned user can perform this operation.' });
        }
        next();
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
        const isAdmin = req.user?.isAdmin === true || req.user?.role === 'Admin' || req.user?.role === 'ROOT';
        const assetController = await getDepartmentHOD('assetcontroller');
        const isAssetControllerRole = req.user?.role === 'Asset Controller' || req.user?.role === 'AssetController' || req.user?.groupName?.includes('Asset') || req.user?.groupName?.includes('Controller');
        const isAssetControllerFlow = assetController && (assetController._id?.toString() === req.user?.employeeObjectId?.toString() || assetController.employeeId === req.user?.employeeId);

        // Admin & Asset Controller always have full access
        if (isAdmin || isAssetControllerFlow || isAssetControllerRole) return next();

        // Specific Asset Access (Individual)
        if (id) {
            const AssetItem = (await import('../models/AssetItem.js')).default;
            const asset = await AssetItem.findById(id).select('assignedTo status actionRequiredBy assignedCompany');
            if (asset) {
                const currentEmpId = req.user?.employeeObjectId?.toString();
                const currentUserId = req.user?._id?.toString();

                // 1. Allow if Assigned User
                const isAssignedUser = asset.assignedTo && asset.assignedTo.toString() === currentEmpId;
                if (isAssignedUser) {
                    return next();
                }

                // 2. Allow if Action Required By Me
                const isActionRequiredByMe = (asset.actionRequiredBy && (asset.actionRequiredBy.toString() === currentEmpId || asset.actionRequiredBy.toString() === currentUserId));
                if (isActionRequiredByMe) {
                    return next();
                }

                // 3. Allow if Creator + Draft/Pending (Awaiting creation approval)
                const isCreator = asset.createdBy?.toString() === currentUserId;
                const isAwaitingApproval = asset.status === 'Draft' || asset.status === 'Pending';
                if (isCreator && isAwaitingApproval) {
                    return next();
                }
            }
        }

        // Specific Asset Access (Bulk)
        const { assetIds } = req.body;
        if (assetIds && Array.isArray(assetIds) && assetIds.length > 0) {
            const AssetItem = (await import('../models/AssetItem.js')).default;
            const assets = await AssetItem.find({ _id: { $in: assetIds } }).select('assignedTo status actionRequiredBy');
            const currentEmpId = req.user?.employeeObjectId?.toString();
            const currentUserId = req.user?._id?.toString();

            const allPermitted = assets.every(a => {
                const isAssignedUser = a.assignedTo && a.assignedTo.toString() === currentEmpId;
                const isActionRequiredByMe = a.actionRequiredBy && (a.actionRequiredBy.toString() === currentEmpId || a.actionRequiredBy.toString() === currentUserId);
                return isAssignedUser || isActionRequiredByMe;
            });

            if (allPermitted && assets.length === assetIds.length) {
                return next();
            }
        }

        console.log(`[Full Access Fail] Admin: ${isAdmin}, Flow: ${isAssetControllerFlow}, Role: ${isAssetControllerRole}, User: ${req.user?.name}, ID: ${req.user?.employeeId}, AssetID: ${id}`);
        return res.status(403).json({
            message: 'Access denied. You do not have permission to access or modify this asset.',
            debug: { user: req.user?.name, id: req.user?.employeeId, role: req.user?.role, group: req.user?.groupName }
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
router.put('/:id/assign', protect, requireAssetControllerOrAdmin, assignAssetItem);
router.put('/:id/respond', protect, requireAssetFullAccess, respondToAssignment);
router.post('/transfer', protect, requireAssetControllerOrAdmin, transferAsset);
router.put('/:id/approve-creation', protect, requireAssetControllerOrAdmin, respondToAssetCreation);
router.put('/:id/return', protect, requireAssetControllerOrAdmin, returnAssetItem);
router.put('/:id/on-leave-action', protect, requireAssetControllerOrAdmin, handleOnLeaveAction);
router.put('/:id/status', protect, requireAssetFullAccess, updateAssetStatus);
router.post('/:id/document', protect, requireAssetFullAccess, addAssetDocument);
router.put('/:id/document/:docId', protect, requireAssetFullAccess, updateAssetDocument);
router.delete('/:id/document/:docId', protect, requireAssetControllerOrAdmin, deleteAssetDocument);
router.post('/:id/service', protect, requireAssetFullAccess, addAssetService);
router.post('/:id/images', protect, requireAssetFullAccess, addAssetImage);
router.delete('/:id/images/:imageId', protect, requireAssetControllerOrAdmin, deleteAssetImage);

router.put('/:id', protect, requireAssetControllerOrAdmin, updateAssetItem);
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
