import express from 'express';
import { createAssetItem, getAssetItems, getAllAssignedAssets, getUnassignedAssetsForEmployee, getAssetItemDetail, assignAssetItem, bulkAssignAssetItems, downloadHandoverPdf, downloadHistoryHandoverPdf, respondToAssignment, getAssetHistory, getHistoryRecord, returnAssetItem, updateAssetStatus, addAssetDocument, updateAssetDocument, deleteAssetDocument, addAssetService, addAssetImage, deleteAssetImage, transferAssetAccessory, manageAccessoryStatus, updateAssetItem, endOfLifeAsset, requestAssetAction, handleAssetActionApproval, finalizeAssetAction, uploadAccessoriesAttachment, requestAccessoryAction, respondAccessoryAction, finalizeAccessoryAction, respondToAssetCreation } from '../controllers/assetItemController.js';
import { protect } from '../middleware/authMiddleware.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';

/**
 * Middleware to restrict access to Asset Controller or Admin only.
 * Used for creating assets, assigning, and operations on UNASSIGNED assets.
 */
const requireAssetControllerOrAdmin = async (req, res, next) => {
    try {
        const isAdmin = req.user.isAdmin === true || req.user.role === 'Admin' || req.user.role === 'ROOT';
        if (isAdmin) return next();

        const assetController = await getDepartmentHOD('assetcontroller', req.user.employeeObjectId);
        const isAssetController = assetController && assetController._id.toString() === req.user.employeeObjectId?.toString();

        if (!isAssetController) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller or Admin can perform this operation.' });
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
        const isAdmin = req.user.isAdmin === true || req.user.role === 'Admin' || req.user.role === 'ROOT';
        const assetController = await getDepartmentHOD('assetcontroller', req.user.employeeObjectId);
        const isAssetController = assetController && assetController._id.toString() === req.user.employeeObjectId?.toString();

        // Admin & Asset Controller always have full access
        if (isAdmin || isAssetController) return next();

        // Specific Asset Access
        if (id) {
            const AssetItem = (await import('../models/AssetItem.js')).default;
            const asset = await AssetItem.findById(id).select('assignedTo status actionRequiredBy');
            if (asset) {
                const currentUserId = req.user.employeeObjectId?.toString();

                // 1. Allow if Assigned User (unless asset is explicitly unassigned or in draft/creation phase)
                const isAssignedUser = asset.assignedTo?.toString() === currentUserId;
                if (isAssignedUser && asset.status !== 'Unassigned' && asset.status !== 'Draft') {
                    return next();
                }

                // 2. Allow if the current action is specifically required from this user (e.g., Transfer recipient, Manager, HOD)
                const isActionRequiredByMe = asset.actionRequiredBy?.toString() === currentUserId;
                if (isActionRequiredByMe) {
                    return next();
                }
            }
        }

        return res.status(403).json({ message: 'Access denied. You do not have permission to modify this asset.' });
    } catch (error) {
        next(error);
    }
};

const router = express.Router();

router.route('/')
    .post(protect, createAssetItem);

router.get('/assigned/all', protect, getAllAssignedAssets);
router.get('/unassigned/controller/:employeeId', protect, getUnassignedAssetsForEmployee);

router.get('/detail/:id', protect, getAssetItemDetail);
router.get('/:id/history', protect, getAssetHistory);
router.get('/history-record/:historyId', protect, getHistoryRecord);
router.get('/handover-pdf/:id', protect, downloadHandoverPdf);
router.get('/history-handover-pdf/:historyId', protect, downloadHistoryHandoverPdf);
router.put('/bulk/assign', protect, requireAssetControllerOrAdmin, bulkAssignAssetItems);
router.put('/:id/assign', protect, requireAssetControllerOrAdmin, assignAssetItem);
router.put('/:id/respond', protect, requireAssetFullAccess, respondToAssignment);
router.put('/:id/approve-creation', protect, requireAssetControllerOrAdmin, respondToAssetCreation);
router.put('/:id/return', protect, requireAssetControllerOrAdmin, returnAssetItem);
router.put('/:id/status', protect, requireAssetFullAccess, updateAssetStatus);
router.post('/:id/document', protect, requireAssetFullAccess, addAssetDocument);
router.put('/:id/document/:docId', protect, requireAssetFullAccess, updateAssetDocument);
router.delete('/:id/document/:docId', protect, requireAssetControllerOrAdmin, deleteAssetDocument);
router.post('/:id/service', protect, requireAssetFullAccess, addAssetService);
router.post('/:id/images', protect, requireAssetFullAccess, addAssetImage);
router.delete('/:id/images/:imageId', protect, requireAssetControllerOrAdmin, deleteAssetImage);

router.put('/:id', protect, requireAssetControllerOrAdmin, updateAssetItem);
router.put('/:id/end-of-life', protect, requireAssetFullAccess, endOfLifeAsset);
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
