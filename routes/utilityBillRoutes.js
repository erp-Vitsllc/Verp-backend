import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
    listUtilityBillPayments,
    createUtilityBillPayment,
    createUtilityBillBatch,
    respondUtilityBillPayment,
    respondUtilityBillBatch,
    payUtilityBillBatch,
    getUtilityBillPayment,
    getUtilityBillBatch,
} from '../controllers/utilityBill/utilityBillPaymentController.js';
import {
    upsertUtilityBillPaymentDay,
    updateUtilityBillPaymentDayStatus,
} from '../controllers/utilityBill/utilityBillPaymentDayController.js';

const router = express.Router();

router.use(protect);

router.get('/', listUtilityBillPayments);
router.post('/payment-day', upsertUtilityBillPaymentDay);
router.put('/payment-day/:entryId/status', updateUtilityBillPaymentDayStatus);
router.post('/batch', createUtilityBillBatch);
router.get('/batch/:batchId', getUtilityBillBatch);
router.put('/batch/:batchId/respond', respondUtilityBillBatch);
router.put('/batch/:batchId/pay', payUtilityBillBatch);
router.post('/', createUtilityBillPayment);
router.get('/:id', getUtilityBillPayment);
router.put('/:id/respond', respondUtilityBillPayment);

export default router;
