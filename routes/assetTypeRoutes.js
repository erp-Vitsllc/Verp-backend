import express from 'express';
import { createAssetType, getAssetTypes, deleteAssetType, getAssetTypeById, uploadInvoice, updateAssetItem } from '../controllers/assetTypeController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.route('/')
    .post(protect, createAssetType)
    .get(protect, getAssetTypes);

router.route('/upload')
    .post(protect, uploadInvoice);

router.route('/:id')
    .delete(protect, deleteAssetType)
    .get(protect, getAssetTypeById)
    .put(protect, updateAssetItem);

export default router;
