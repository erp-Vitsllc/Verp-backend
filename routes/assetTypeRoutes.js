import express from 'express';
import mongoose from 'mongoose';
import { createAssetType, getAssetTypes, deleteAssetType, getAssetTypeById, uploadInvoice, updateAssetItem } from '../controllers/assetTypeController.js';
import { protect } from '../middleware/authMiddleware.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';

const requireAssetControllerOrAdmin = async (req, res, next) => {
    try {
        const isAdmin = req.user.isAdmin === true || req.user.role === 'Admin' || req.user.role === 'ROOT';
        if (isAdmin) return next();

        const assetController = await getDepartmentHOD('assetcontroller', req.user.employeeObjectId);
        const isAssetController = assetController && assetController._id.toString() === req.user.employeeObjectId?.toString();

        if (isAssetController) return next();

        const { id } = req.params;
        if (id && mongoose.Types.ObjectId.isValid(id)) {
            const AssetItem = (await import('../models/AssetItem.js')).default;
            const asset = await AssetItem.findById(id);

            if (asset) {
                const currentUserId = req.user._id?.toString() || req.user.id?.toString();
                const isCreator = asset.createdBy?.toString() === currentUserId;
                const isAwaitingApproval = asset.status === 'Draft' || asset.status === 'Pending';

                // Allow creator for Draft/Pending assets
                if (isCreator && isAwaitingApproval) {
                    return next();
                }

                // Allow assigned user to update accessories on their assigned asset (PUT with accessories)
                const isAssignedUser = asset.assignedTo && asset.assignedTo.toString() === req.user.employeeObjectId?.toString();
                const isAccessoriesOnlyUpdate = req.method === 'PUT' && req.body && Object.keys(req.body).every(k => k === 'accessories' || k === 'accessoriesAttachment');
                if (isAssignedUser && isAccessoriesOnlyUpdate) {
                    return next();
                }
            }
        }

        return res.status(403).json({ message: 'Access denied. Only Asset Controller or Admin can perform this operation.' });
    } catch (error) {
        next(error);
    }
};

const router = express.Router();

router.route('/')
    .post(protect, createAssetType)
    .get(protect, getAssetTypes);

router.route('/upload')
    .post(protect, uploadInvoice);

router.route('/:id')
    .delete(protect, requireAssetControllerOrAdmin, deleteAssetType)
    .get(protect, getAssetTypeById)
    .put(protect, requireAssetControllerOrAdmin, updateAssetItem);

export default router;
