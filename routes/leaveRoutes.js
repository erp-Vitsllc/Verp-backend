import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkPermission } from '../middleware/permissionMiddleware.js';
import { getEmployeeLeaveDirectory } from '../controllers/leaveController.js';

const router = express.Router();

router.use(protect);

router.get(
    '/employees',
    checkPermission('hrm_leave', 'view'),
    getEmployeeLeaveDirectory,
);
router.get('/', checkPermission('hrm_leave', 'view'), getEmployeeLeaveDirectory);

export default router;
