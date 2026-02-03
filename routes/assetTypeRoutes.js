import express from 'express';
import { createAssetType, getAssetTypes, deleteAssetType } from '../controllers/assetTypeController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.route('/')
    .post(protect, createAssetType)
    .get(protect, getAssetTypes);

router.route('/:id')
    .delete(protect, deleteAssetType);

export default router;
