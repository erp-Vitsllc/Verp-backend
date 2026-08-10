import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
    listUtilityBillPayments,
    createUtilityBillPayment,
    createUtilityBillBatch,
    updateUtilityBillBatch,
    respondUtilityBillPayment,
    respondUtilityBillBatch,
    payUtilityBillBatch,
    getUtilityBillPayment,
    getUtilityBillBatch,
    syncUtilityBillBatchToZoho,
    deleteUtilityBillPayment,
} from '../controllers/utilityBill/utilityBillPaymentController.js';
import {
    upsertUtilityBillPaymentDay,
    updateUtilityBillPaymentDayStatus,
} from '../controllers/utilityBill/utilityBillPaymentDayController.js';
import {
    createUtilityEntryStatusChange,
    getUtilityEntryStatusChange,
    listUtilityEntryStatusChanges,
    respondUtilityEntryStatusChange,
} from '../controllers/utilityBill/utilityEntryStatusChangeController.js';
import {
    listUtilityTypeNames,
    addUtilityTypeName,
    removeUtilityTypeName,
    renameUtilityTypeName,
    listUtilityProviders,
    addUtilityProvider,
    removeUtilityProvider,
    listUtilityConfigs,
    upsertUtilityConfig,
    deleteUtilityConfig,
} from '../controllers/utilityBill/utilitySetupController.js';
import {
    listUtilityEntries,
    getUtilityEntry,
    createUtilityEntry,
    updateUtilityEntry,
    deleteUtilityEntry,
    listUtilityEntryAssignmentHistory,
} from '../controllers/utilityBill/utilityEntryController.js';

const router = express.Router();

router.use(protect);

router.get('/types', listUtilityTypeNames);
router.post('/types', addUtilityTypeName);
router.put('/types/:name', renameUtilityTypeName);
router.delete('/types/:name', removeUtilityTypeName);

router.get('/providers', listUtilityProviders);
router.post('/providers', addUtilityProvider);
router.delete('/providers/:name', removeUtilityProvider);

router.get('/configs', listUtilityConfigs);
router.post('/configs', upsertUtilityConfig);
router.delete('/configs/:id', deleteUtilityConfig);

router.get('/entries', listUtilityEntries);
router.post('/entries', createUtilityEntry);
router.get('/entries/:id/assignment-history', listUtilityEntryAssignmentHistory);
router.get('/entries/:id', getUtilityEntry);
router.put('/entries/:id', updateUtilityEntry);
router.delete('/entries/:id', deleteUtilityEntry);

router.get('/', listUtilityBillPayments);
router.post('/payment-day', upsertUtilityBillPaymentDay);
router.put('/payment-day/:entryId/status', updateUtilityBillPaymentDayStatus);

router.post('/status-change', createUtilityEntryStatusChange);
router.get('/status-change', listUtilityEntryStatusChanges);
router.get('/status-change/:id', getUtilityEntryStatusChange);
router.put('/status-change/:id/respond', respondUtilityEntryStatusChange);

router.post('/batch', createUtilityBillBatch);
router.get('/batch/:batchId', getUtilityBillBatch);
router.put('/batch/:batchId', updateUtilityBillBatch);
router.put('/batch/:batchId/respond', respondUtilityBillBatch);
router.put('/batch/:batchId/pay', payUtilityBillBatch);
router.post('/batch/:batchId/sync-zoho', syncUtilityBillBatchToZoho);
router.post('/', createUtilityBillPayment);
router.get('/:id', getUtilityBillPayment);
router.delete('/:id', deleteUtilityBillPayment);
router.put('/:id/respond', respondUtilityBillPayment);

export default router;
