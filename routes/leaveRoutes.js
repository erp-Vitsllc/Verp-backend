import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkPermission } from '../middleware/permissionMiddleware.js';
import { getEmployeeLeaveDirectory } from '../controllers/leaveController.js';
import {
    getEmployeeAttendanceProfile,
    getEmployeeAttendanceProfileAccess,
} from '../controllers/leave/getEmployeeAttendanceProfile.js';

const router = express.Router();

router.use(protect);

router.get(
    '/employees',
    checkPermission('hrm_leave', 'view'),
    getEmployeeLeaveDirectory,
);
router.get('/employees/:id/attendance-profile/access', getEmployeeAttendanceProfileAccess);
router.get('/employees/:id/attendance-profile', getEmployeeAttendanceProfile);
router.get('/', checkPermission('hrm_leave', 'view'), getEmployeeLeaveDirectory);

export default router;
