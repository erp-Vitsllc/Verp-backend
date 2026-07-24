import express from 'express';
import { zohoCallback } from '../controllers/zoho/zohoCallback.js';
import { getZohoVendors } from '../controllers/zoho/getZohoVendors.js';
import { getZohoCustomers } from '../controllers/zoho/getZohoCustomers.js';
import { getZohoVendorPayments } from '../controllers/zoho/getZohoVendorPayments.js';
import { getZohoVendorPaymentById } from '../controllers/zoho/getZohoVendorPaymentById.js';
import { getZohoVendorPaymentPdf } from '../controllers/zoho/getZohoVendorPaymentPdf.js';
import { getZohoVendorPaymentSupport } from '../controllers/zoho/getZohoVendorPaymentSupport.js';
import { getZohoBills } from '../controllers/zoho/getZohoBills.js';
import { getZohoBillById } from '../controllers/zoho/getZohoBillById.js';
import { getZohoBillSupport } from '../controllers/zoho/getZohoBillSupport.js';
import { getZohoExpenses } from '../controllers/zoho/getZohoExpenses.js';
import { getZohoExpenseSupport } from '../controllers/zoho/getZohoExpenseSupport.js';
import { getZohoAuthUrl } from '../controllers/zoho/getZohoAuthUrl.js';
import { getZohoConnections } from '../controllers/zoho/getZohoConnections.js';
import { postZohoVendorPayment, putZohoVendorPayment } from '../controllers/zoho/postZohoVendorPayment.js';
import { postZohoBill, putZohoBill } from '../controllers/zoho/postZohoBill.js';
import {
    postZohoBillAttachment,
    uploadZohoBillAttachmentMiddleware,
} from '../controllers/zoho/postZohoBillAttachment.js';
import { postZohoExpense } from '../controllers/zoho/postZohoExpense.js';
import { postZohoVendor } from '../controllers/zoho/postZohoVendor.js';
import { getZohoVendorById } from '../controllers/zoho/getZohoVendorById.js';
import {
    getZohoVendorComments,
    postZohoVendorComment,
} from '../controllers/zoho/zohoVendorComments.js';
import {
    getZohoBillComments,
    postZohoBillComment,
} from '../controllers/zoho/zohoBillComments.js';
import { postZohoSync } from '../controllers/zoho/postZohoSync.js';
import { protect } from '../middleware/authMiddleware.js';
import { zohoOrganizationContext } from '../middleware/zohoOrganizationContext.js';

const router = express.Router();

router.get('/callback', zohoCallback);
router.get('/auth-url', protect, getZohoAuthUrl);
router.get('/connections', protect, getZohoConnections);

// All Books API routes run under the org from ?organizationId= / ?companyId= (or env default)
router.use(protect, zohoOrganizationContext);

router.post('/sync', postZohoSync);
router.get('/vendors', getZohoVendors);
router.post('/vendors', postZohoVendor);
router.get('/vendors/:vendorId', getZohoVendorById);
router.get('/vendors/:vendorId/comments', getZohoVendorComments);
router.post('/vendors/:vendorId/comments', postZohoVendorComment);
router.get('/customers', getZohoCustomers);
router.get('/bills', getZohoBills);
router.get('/bills/support', getZohoBillSupport);
router.get('/bills/:billId', getZohoBillById);
router.get('/bills/:billId/comments', getZohoBillComments);
router.post('/bills/:billId/comments', postZohoBillComment);
router.post(
    '/bills/:billId/attachment',
    uploadZohoBillAttachmentMiddleware,
    postZohoBillAttachment,
);
router.post('/bills', postZohoBill);
router.put('/bills/:billId', putZohoBill);
router.get('/expenses/support', getZohoExpenseSupport);
router.get('/expenses', getZohoExpenses);
router.post('/expenses', postZohoExpense);
router.get('/vendorpayments', getZohoVendorPayments);
router.post('/vendorpayments', postZohoVendorPayment);
router.get('/vendorpayments/support', getZohoVendorPaymentSupport);
router.get('/vendorpayments/:paymentId/pdf', getZohoVendorPaymentPdf);
router.get('/vendorpayments/:paymentId', getZohoVendorPaymentById);
router.put('/vendorpayments/:paymentId', putZohoVendorPayment);

export default router;
