import express from 'express';
import { createAssetType, getAssetTypes, deleteAssetType, getAssetTypeById, uploadInvoice, updateAssetItem } from '../controllers/assetTypeController.js';
import { protect } from '../middleware/authMiddleware.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';

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

const router = express.Router();

router.route('/')
    .post(protect, requireAssetControllerOrAdmin, createAssetType)
    .get(protect, getAssetTypes);

router.route('/upload')
    .post(protect, requireAssetControllerOrAdmin, uploadInvoice);

router.route('/:id')
    .delete(protect, requireAssetControllerOrAdmin, deleteAssetType)
    .get(protect, getAssetTypeById)
    .put(protect, requireAssetControllerOrAdmin, updateAssetItem);

export default router;
