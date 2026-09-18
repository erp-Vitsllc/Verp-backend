import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkAnyModulePermission, checkPermission, requireAdmin, requireWhatsAppInboxAccess } from '../middleware/permissionMiddleware.js';
import {
    getWhatsAppInboxAccess,
    getWhatsAppStatus,
    getWhatsAppWebhook,
    listWhatsAppConversations,
    listWhatsAppThread,
    postWhatsAppCheckNumber,
    postWhatsAppTest,
    postWhatsAppTestEmployees,
    postWhatsAppThreadReply,
    postWhatsAppToEmployee,
    postWhatsAppWebhook,
} from '../controllers/whatsapp/whatsappController.js';

const router = express.Router();

router.get('/webhook', getWhatsAppWebhook);
router.post('/webhook', postWhatsAppWebhook);

router.get('/status', protect, requireWhatsAppInboxAccess, getWhatsAppStatus);
router.get('/access', protect, getWhatsAppInboxAccess);
router.get('/conversations', protect, requireWhatsAppInboxAccess, listWhatsAppConversations);
router.get('/thread', protect, requireWhatsAppInboxAccess, listWhatsAppThread);
router.post('/thread', protect, requireWhatsAppInboxAccess, postWhatsAppThreadReply);
router.post('/test', protect, requireAdmin, postWhatsAppTest);
router.post('/test-employees', protect, requireAdmin, postWhatsAppTestEmployees);
router.post(
    '/check-number',
    protect,
    checkAnyModulePermission(
        [
            ['hrm_employees_list', 'view'],
            ['hrm_employees_add', 'create'],
            ['hrm_employees_view_basic', 'edit'],
            ['hrm_employees_view_personal', 'edit'],
        ],
        'Access denied. Employee permission is required to check WhatsApp numbers.',
    ),
    postWhatsAppCheckNumber,
);
router.post('/employee/:id', protect, checkPermission('hrm_employees_list', 'view'), postWhatsAppToEmployee);

export default router;
