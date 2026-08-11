import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkPermission, checkPermissionAny } from '../middleware/permissionMiddleware.js';
import {
    getAttendanceByDate,
    getAttendanceCalendarSummary,
    markAttendance,
    getMyAttendanceMonth,
    checkInMyAttendance,
    checkOutMyAttendance,
    getAttendanceTeamTree,
    markTeamAttendance,
} from '../controllers/attendanceController.js';

const router = express.Router();

router.use(protect);

// Self-service (any logged-in linked employee) — register before /:id style routes
router.get('/me', getMyAttendanceMonth);
router.get('/team-tree', getAttendanceTeamTree);
router.post('/me/check-in', checkInMyAttendance);
router.post('/me/check-out', checkOutMyAttendance);
router.post('/team/mark', markTeamAttendance);

router.get(
    '/calendar',
    checkPermission('hrm_attendance', 'view'),
    getAttendanceCalendarSummary,
);
router.get('/', checkPermission('hrm_attendance', 'view'), getAttendanceByDate);
router.post(
    '/mark',
    checkPermissionAny('hrm_attendance', ['create', 'edit', 'view']),
    markAttendance,
);

export default router;
