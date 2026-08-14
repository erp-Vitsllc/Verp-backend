import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkPermission, checkPermissionAny } from '../middleware/permissionMiddleware.js';
import {
    getAttendanceByDate,
    getAttendanceCalendarSummary,
    getAttendanceMarkRoster,
    markAttendance,
    getMyAttendanceMonth,
    getMyAttendanceYearSummary,
    checkInMyAttendance,
    checkOutMyAttendance,
    getAttendanceTeamTree,
    markTeamAttendance,
    getAttendancePendingInbox,
    approveAttendancePending,
    requestAttendanceLeave,
    requestAttendanceYellow,
    requestAttendanceFuture,
    decideAttendanceLeaveRequest,
} from '../controllers/attendanceController.js';

const router = express.Router();

router.use(protect);

// Self-service (any logged-in linked employee) — register before /:id style routes
router.get('/me/year-summary', getMyAttendanceYearSummary);
router.get('/me', getMyAttendanceMonth);
router.get('/team-tree', getAttendanceTeamTree);
router.post('/me/check-in', checkInMyAttendance);
router.post('/me/check-out', checkOutMyAttendance);
router.post('/me/leave-request', requestAttendanceLeave);
router.post('/me/yellow-request', requestAttendanceYellow);
router.post('/me/future-request', requestAttendanceFuture);
router.post('/me/leave-request/decide', decideAttendanceLeaveRequest);
router.post('/team/mark', markTeamAttendance);

// Leave-request inbox is scoped to the viewer's reportees (no HR module permission required)
router.get('/dashboard/pending-inbox', getAttendancePendingInbox);
router.post('/dashboard/approve-pending', approveAttendancePending);

router.get(
    '/mark-roster',
    checkPermission('hrm_attendance', 'view'),
    getAttendanceMarkRoster,
);
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
