import express from 'express';
import { createAssetItem, getAssetItems, getAllAssignedAssets, getAssetItemDetail, assignAssetItem, bulkAssignAssetItems, downloadHandoverPdf, respondToAssignment, getAssetHistory, returnAssetItem } from '../controllers/assetItemController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.route('/')
    .post(protect, createAssetItem);

router.get('/assigned/all', protect, getAllAssignedAssets);

router.get('/detail/:id', protect, getAssetItemDetail);
router.get('/:id/history', protect, getAssetHistory);
router.get('/handover-pdf/:id', protect, downloadHandoverPdf);
router.put('/bulk/assign', protect, bulkAssignAssetItems);
router.put('/:id/assign', protect, assignAssetItem);
router.put('/:id/respond', protect, respondToAssignment);
router.put('/:id/return', protect, returnAssetItem);

router.route('/:typeId')
    .get(protect, getAssetItems);

export default router;
