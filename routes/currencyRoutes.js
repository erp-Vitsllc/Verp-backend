import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { getCurrencyRates } from '../controllers/currency/getCurrencyRates.js';

const router = express.Router();

router.use(protect);
router.get('/rates', getCurrencyRates);

export default router;
