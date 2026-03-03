import express from 'express';
import { createAssetItem, getAssetItems, getAllAssignedAssets, getAssetItemDetail, assignAssetItem, bulkAssignAssetItems, downloadHandoverPdf, respondToAssignment, getAssetHistory, returnAssetItem, updateAssetStatus, addAssetDocument, updateAssetDocument, deleteAssetDocument, addAssetService, addAssetImage, deleteAssetImage, transferAssetAccessory, manageAccessoryStatus, updateAssetItem, endOfLifeAsset, requestAssetAction, handleAssetActionApproval, finalizeAssetAction, uploadAccessoriesAttachment, requestAccessoryAction, respondAccessoryAction, finalizeAccessoryAction } from '../controllers/assetItemController.js';
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

router.put('/:id', protect, updateAssetItem);
router.put('/:id/end-of-life', protect, endOfLifeAsset);
router.put('/:id/request-action', protect, requestAssetAction);
router.put('/:id/approve-action', protect, handleAssetActionApproval);
router.put('/:id/finalize-action', protect, finalizeAssetAction);

// Accessories
router.put('/:id/accessories/:accId/transfer', protect, transferAssetAccessory);
router.put('/:id/accessories/:accId/status', protect, manageAccessoryStatus);
router.put('/:id/accessories-attachment', protect, uploadAccessoriesAttachment);
router.put('/:id/accessories/:accId/request-action', protect, requestAccessoryAction);
router.put('/:id/accessories/:accId/respond-action', protect, respondAccessoryAction);
router.put('/:id/accessories/:accId/finalize-action', protect, finalizeAccessoryAction);

router.route('/:typeId')
    .get(protect, getAssetItems);

export default router;
