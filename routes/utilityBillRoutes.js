import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
    listUtilityBillPayments,
    createUtilityBillPayment,
    respondUtilityBillPayment,
    getUtilityBillPayment,
} from '../controllers/utilityBill/utilityBillPaymentController.js';

const router = express.Router();

router.use(protect);

router.get('/', listUtilityBillPayments);
router.post('/', createUtilityBillPayment);
router.get('/:id', getUtilityBillPayment);
router.put('/:id/respond', respondUtilityBillPayment);

export default router;
