import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkPermission } from '../middleware/permissionMiddleware.js';
import { getEmployeeLeaveDirectory, getLeaveCalendar, getLeaveSalaryVisibility } from '../controllers/leaveController.js';
import {
    applyLeaveRange,
    decideLeavePendingRequest,
    getLeavePendingInbox,
    getLeavePendingRequests,
    getLeaveTeamTrack,
} from '../controllers/leave/leaveDashboardData.js';
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
router.get(
    '/calendar',
    checkPermission('hrm_leave', 'view'),
    getLeaveCalendar,
);
router.get(
    '/salary-visibility',
    checkPermission('hrm_leave', 'view'),
    getLeaveSalaryVisibility,
);
router.get(
    '/pending-requests',
    checkPermission('hrm_leave', 'view'),
    getLeavePendingRequests,
);
router.get(
    '/dashboard/pending-inbox',
    checkPermission('hrm_leave', 'view'),
    getLeavePendingInbox,
);
router.post(
    '/pending-requests/decide',
    checkPermission('hrm_leave', 'view'),
    decideLeavePendingRequest,
);
router.post(
    '/apply',
    checkPermission('hrm_leave', 'view'),
    applyLeaveRange,
);
router.get(
    '/team-track',
    checkPermission('hrm_leave', 'view'),
    getLeaveTeamTrack,
);
router.get('/employees/:id/attendance-profile/access', getEmployeeAttendanceProfileAccess);
router.get('/employees/:id/attendance-profile', getEmployeeAttendanceProfile);
router.get('/', checkPermission('hrm_leave', 'view'), getEmployeeLeaveDirectory);

export default router;
