import express from 'express';
import {
    createAssetType,
    getAssetTypes,
    deleteAssetType,
    getAssetTypeById,
    uploadInvoice,
    updateAssetItem,
    submitAssetForApproval,
    getAssetTypeRoleMeta
} from '../controllers/assetTypeController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.route('/')
    .post(protect, createAssetType)
    .get(protect, getAssetTypes);

router.route('/upload')
    .post(protect, uploadInvoice);

// Must be registered before /:id so "meta" is not parsed as an ObjectId
router.get('/meta/role', protect, getAssetTypeRoleMeta);

// More specific than PUT /:id — register first
router.put('/:id/submit-approval', protect, submitAssetForApproval);

router.route('/:id')
    .delete(protect, deleteAssetType)
    .get(protect, getAssetTypeById)
    .put(protect, updateAssetItem);

export default router;
