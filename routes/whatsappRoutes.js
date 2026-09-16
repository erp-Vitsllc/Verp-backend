import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkPermission, requireAdmin } from '../middleware/permissionMiddleware.js';
import {
    getWhatsAppStatus,
    getWhatsAppWebhook,
    postWhatsAppTest,
    postWhatsAppTestEmployees,
    postWhatsAppToEmployee,
    postWhatsAppWebhook,
} from '../controllers/whatsapp/whatsappController.js';

const router = express.Router();

router.get('/webhook', getWhatsAppWebhook);
router.post('/webhook', postWhatsAppWebhook);

router.get('/status', protect, requireAdmin, getWhatsAppStatus);
router.post('/test', protect, requireAdmin, postWhatsAppTest);
router.post('/test-employees', protect, requireAdmin, postWhatsAppTestEmployees);
router.post('/employee/:id', protect, checkPermission('hrm_employees_list', 'view'), postWhatsAppToEmployee);

export default router;
