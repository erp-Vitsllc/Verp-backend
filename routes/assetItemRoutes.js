import express from 'express';
import { createAssetItem, getAssetItems, getAllAssignedAssets, getUnassignedAssetsForEmployee, getAssetItemDetail, assignAssetItem, bulkAssignAssetItems, downloadHandoverPdf, downloadHistoryHandoverPdf, respondToAssignment, getAssetHistory, getHistoryRecord, returnAssetItem, updateAssetStatus, addAssetDocument, updateAssetDocument, deleteAssetDocument, addAssetService, addAssetImage, deleteAssetImage, transferAssetAccessory, manageAccessoryStatus, updateAssetItem, endOfLifeAsset, requestAssetAction, handleAssetActionApproval, finalizeAssetAction, uploadAccessoriesAttachment, requestAccessoryAction, respondAccessoryAction, finalizeAccessoryAction, respondToAssetCreation } from '../controllers/assetItemController.js';
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
    .post(protect, requireAssetController, createAssetItem);

router.get('/assigned/all', protect, getAllAssignedAssets);
router.get('/unassigned/controller/:employeeId', protect, getUnassignedAssetsForEmployee);

router.get('/detail/:id', protect, getAssetItemDetail);
router.get('/:id/history', protect, getAssetHistory);
router.get('/history-record/:historyId', protect, getHistoryRecord);
router.get('/handover-pdf/:id', protect, downloadHandoverPdf);
router.get('/history-handover-pdf/:historyId', protect, downloadHistoryHandoverPdf);
router.put('/bulk/assign', protect, requireAssetController, bulkAssignAssetItems);
router.put('/:id/assign', protect, requireAssetController, assignAssetItem);
router.put('/:id/respond', protect, requireAssetController, respondToAssignment);
router.put('/:id/approve-creation', protect, requireAssetController, respondToAssetCreation);
router.put('/:id/return', protect, requireAssetController, returnAssetItem);
router.put('/:id/status', protect, requireAssetController, updateAssetStatus);
router.post('/:id/document', protect, requireAssetController, addAssetDocument);
router.put('/:id/document/:docId', protect, requireAssetController, updateAssetDocument);
router.delete('/:id/document/:docId', protect, requireAssetController, deleteAssetDocument);
router.post('/:id/service', protect, requireAssetController, addAssetService);
router.post('/:id/images', protect, requireAssetController, addAssetImage);
router.delete('/:id/images/:imageId', protect, requireAssetController, deleteAssetImage);

router.put('/:id', protect, requireAssetController, updateAssetItem);
router.put('/:id/end-of-life', protect, requireAssetController, endOfLifeAsset);
router.put('/:id/request-action', protect, requireAssetController, requestAssetAction);
router.put('/:id/approve-action', protect, requireAssetController, handleAssetActionApproval);
router.put('/:id/finalize-action', protect, requireAssetController, finalizeAssetAction);

// Accessories
router.put('/:id/accessories/:accId/transfer', protect, requireAssetController, transferAssetAccessory);
router.put('/:id/accessories/:accId/status', protect, requireAssetController, manageAccessoryStatus);
router.put('/:id/accessories-attachment', protect, requireAssetController, uploadAccessoriesAttachment);
router.put('/:id/accessories/:accId/request-action', protect, requireAssetController, requestAccessoryAction);
router.put('/:id/accessories/:accId/respond-action', protect, requireAssetController, respondAccessoryAction);
router.put('/:id/accessories/:accId/finalize-action', protect, requireAssetController, finalizeAccessoryAction);

router.route('/:typeId')
    .get(protect, getAssetItems);

export default router;
