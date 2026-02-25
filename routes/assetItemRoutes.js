import express from 'express';
import { createAssetItem, getAssetItems, getAllAssignedAssets, getAssetItemDetail, assignAssetItem, bulkAssignAssetItems, downloadHandoverPdf, respondToAssignment, getAssetHistory, returnAssetItem, updateAssetStatus, addAssetDocument, updateAssetDocument, deleteAssetDocument, addAssetService, addAssetImage, deleteAssetImage, transferAssetAccessory, manageAccessoryStatus } from '../controllers/assetItemController.js';
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
router.put('/:id/status', protect, updateAssetStatus);
router.post('/:id/document', protect, addAssetDocument);
router.put('/:id/document/:docId', protect, updateAssetDocument);
router.delete('/:id/document/:docId', protect, deleteAssetDocument);
router.post('/:id/service', protect, addAssetService);
router.post('/:id/images', protect, addAssetImage);
router.delete('/:id/images/:imageId', protect, deleteAssetImage);

// Accessories
router.put('/:id/accessories/:accId/transfer', protect, transferAssetAccessory);
router.put('/:id/accessories/:accId/status', protect, manageAccessoryStatus);

router.route('/:typeId')
    .get(protect, getAssetItems);

export default router;
