import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkPermission, requireAdmin } from '../middleware/permissionMiddleware.js';
import {
    getWhatsAppInboxAccess,
    getWhatsAppStatus,
    getWhatsAppWebhook,
    listWhatsAppConversations,
    listWhatsAppThread,
    postWhatsAppTest,
    postWhatsAppTestEmployees,
    postWhatsAppThreadReply,
    postWhatsAppToEmployee,
    postWhatsAppWebhook,
} from '../controllers/whatsapp/whatsappController.js';

const router = express.Router();

router.get('/webhook', getWhatsAppWebhook);
router.post('/webhook', postWhatsAppWebhook);

router.get('/status', protect, requireAdmin, getWhatsAppStatus);
router.get('/access', protect, requireAdmin, getWhatsAppInboxAccess);
router.get('/conversations', protect, requireAdmin, listWhatsAppConversations);
router.get('/thread', protect, requireAdmin, listWhatsAppThread);
router.post('/thread', protect, requireAdmin, postWhatsAppThreadReply);
router.post('/test', protect, requireAdmin, postWhatsAppTest);
router.post('/test-employees', protect, requireAdmin, postWhatsAppTestEmployees);
router.post('/employee/:id', protect, checkPermission('hrm_employees_list', 'view'), postWhatsAppToEmployee);

export default router;
