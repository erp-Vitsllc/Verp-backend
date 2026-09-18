import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkAnyModulePermission, checkPermission, requireAdmin } from '../middleware/permissionMiddleware.js';
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

router.get('/status', protect, requireAdmin, getWhatsAppStatus);
router.get(
    '/access',
    protect,
    checkAnyModulePermission(
        [
            ['hrm_employees_list', 'view'],
            ['hrm_employees', 'view'],
            ['hrm_employees_view', 'view'],
            ['hrm_employees_view_basic', 'view'],
        ],
        'Access denied. HR or admin permission is required to view WhatsApp messages.',
    ),
    getWhatsAppInboxAccess,
);
router.get(
    '/conversations',
    protect,
    checkAnyModulePermission(
        [
            ['hrm_employees_list', 'view'],
            ['hrm_employees', 'view'],
            ['hrm_employees_view', 'view'],
            ['hrm_employees_view_basic', 'view'],
        ],
        'Access denied. HR or admin permission is required to view WhatsApp messages.',
    ),
    listWhatsAppConversations,
);
router.get(
    '/thread',
    protect,
    checkAnyModulePermission(
        [
            ['hrm_employees_list', 'view'],
            ['hrm_employees', 'view'],
            ['hrm_employees_view', 'view'],
            ['hrm_employees_view_basic', 'view'],
        ],
        'Access denied. HR or admin permission is required to view WhatsApp messages.',
    ),
    listWhatsAppThread,
);
router.post(
    '/thread',
    protect,
    checkAnyModulePermission(
        [
            ['hrm_employees_list', 'view'],
            ['hrm_employees', 'view'],
            ['hrm_employees_view', 'view'],
            ['hrm_employees_view_basic', 'view'],
        ],
        'Access denied. HR or admin permission is required to view WhatsApp messages.',
    ),
    postWhatsAppThreadReply,
);
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
