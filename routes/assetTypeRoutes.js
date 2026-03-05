import express from 'express';
import { createAssetType, getAssetTypes, deleteAssetType, getAssetTypeById, uploadInvoice, updateAssetItem } from '../controllers/assetTypeController.js';
import { protect } from '../middleware/authMiddleware.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';

const requireAssetController = async (req, res, next) => {
    try {
        const assetController = await getDepartmentHOD('assetcontroller');
        if (!assetController) {
            return res.status(403).json({ message: 'Asset Controller must be assigned in the Global Settings (Flowchart) before performing asset operations.' });
        }
        next();
    } catch (error) {
        next(error);
    }
};

const router = express.Router();

router.route('/')
    .post(protect, requireAssetController, createAssetType)
    .get(protect, getAssetTypes);

router.route('/upload')
    .post(protect, requireAssetController, uploadInvoice);

router.route('/:id')
    .delete(protect, requireAssetController, deleteAssetType)
    .get(protect, getAssetTypeById)
    .put(protect, requireAssetController, updateAssetItem);

export default router;
