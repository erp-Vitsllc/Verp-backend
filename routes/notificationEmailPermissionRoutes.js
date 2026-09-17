import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { requireAdmin } from '../middleware/permissionMiddleware.js';
import {
    getNotificationEmailPermissionAccess,
    getNotificationEmailPermissionMap,
    listNotificationEmailPermissions,
    updateNotificationEmailPermission,
} from '../controllers/notificationEmailPermissionController.js';

const router = express.Router();

router.get('/access', protect, requireAdmin, getNotificationEmailPermissionAccess);
router.get('/', protect, requireAdmin, listNotificationEmailPermissions);
router.get('/map', protect, getNotificationEmailPermissionMap);
router.patch('/', protect, requireAdmin, updateNotificationEmailPermission);

export default router;
