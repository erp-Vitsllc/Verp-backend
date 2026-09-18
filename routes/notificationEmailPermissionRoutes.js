import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { requireAdminOrFlowchartHr } from '../middleware/permissionMiddleware.js';
import {
    getNotificationEmailPermissionAccess,
    getNotificationEmailPermissionMap,
    listNotificationEmailPermissions,
    updateNotificationEmailPermission,
} from '../controllers/notificationEmailPermissionController.js';

const router = express.Router();

router.get('/access', protect, getNotificationEmailPermissionAccess);
router.get('/', protect, requireAdminOrFlowchartHr, listNotificationEmailPermissions);
router.get('/map', protect, getNotificationEmailPermissionMap);
router.patch('/', protect, requireAdminOrFlowchartHr, updateNotificationEmailPermission);

export default router;
