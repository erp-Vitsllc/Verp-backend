import express from 'express';
import { zohoCallback } from '../controllers/zoho/zohoCallback.js';
import { getZohoVendors } from '../controllers/zoho/getZohoVendors.js';
import { getZohoCustomers } from '../controllers/zoho/getZohoCustomers.js';
import { getZohoVendorPayments } from '../controllers/zoho/getZohoVendorPayments.js';
import { getZohoVendorPaymentSupport } from '../controllers/zoho/getZohoVendorPaymentSupport.js';
import { getZohoBills } from '../controllers/zoho/getZohoBills.js';
import { getZohoExpenses } from '../controllers/zoho/getZohoExpenses.js';
import { getZohoAuthUrl } from '../controllers/zoho/getZohoAuthUrl.js';
import { postZohoVendorPayment } from '../controllers/zoho/postZohoVendorPayment.js';
import { postZohoSync } from '../controllers/zoho/postZohoSync.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/callback', zohoCallback);
router.get('/auth-url', protect, getZohoAuthUrl);
router.post('/sync', protect, postZohoSync);
router.get('/vendors', protect, getZohoVendors);
router.get('/customers', protect, getZohoCustomers);
router.get('/bills', protect, getZohoBills);
router.get('/expenses', protect, getZohoExpenses);
router.get('/vendorpayments', protect, getZohoVendorPayments);
router.post('/vendorpayments', protect, postZohoVendorPayment);
router.get('/vendorpayments/support', protect, getZohoVendorPaymentSupport);

export default router;
