import express from 'express';
import { zohoCallback } from '../controllers/zoho/zohoCallback.js';
import { getZohoVendors } from '../controllers/zoho/getZohoVendors.js';
import { getZohoCustomers } from '../controllers/zoho/getZohoCustomers.js';
import { getZohoAuthUrl } from '../controllers/zoho/getZohoAuthUrl.js';
import { postZohoSync } from '../controllers/zoho/postZohoSync.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/callback', zohoCallback);
router.get('/auth-url', protect, getZohoAuthUrl);
router.post('/sync', protect, postZohoSync);
router.get('/vendors', protect, getZohoVendors);
router.get('/customers', protect, getZohoCustomers);

export default router;
