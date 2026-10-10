import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkPermission, checkPermissionAny } from '../middleware/permissionMiddleware.js';
import {
    getAttendanceByDate,
    getAttendanceCalendarSummary,
    getAttendanceMarkRoster,
    markAttendance,
    mapAttendanceFromEmployee,
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
    decideAttendanceChangeRequest,
} from '../controllers/attendanceController.js';
import {
    getCompOffMonth,
    requestCompOffLeave,
    settleCompOff,
} from '../controllers/compOffController.js';
import {
    requestFlexibleOvertime,
    decideFlexibleOvertime,
} from '../controllers/flexibleOtController.js';
import {
    requestHourAdjust,
    decideHourAdjust,
} from '../controllers/hourAdjustController.js';

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
router.post('/me/compoff-request', requestCompOffLeave);
router.get(
    '/compoff',
    checkPermissionAny('hrm_attendance', ['create', 'edit', 'view']),
    getCompOffMonth,
);
router.post(
    '/compoff/settle',
    checkPermissionAny('hrm_attendance', ['create', 'edit', 'view']),
    settleCompOff,
);
router.post('/flexible-ot/request', requestFlexibleOvertime);
router.post('/flexible-ot/decide', decideFlexibleOvertime);
router.post('/hour-adjust/request', requestHourAdjust);
router.post('/hour-adjust/decide', decideHourAdjust);
router.post('/team/mark', markTeamAttendance);

// Leave-request inbox is scoped to the viewer's reportees (no HR module permission required)
router.get('/dashboard/pending-inbox', getAttendancePendingInbox);
router.post('/dashboard/approve-pending', approveAttendancePending);
router.post('/change-request/decide', decideAttendanceChangeRequest);

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
router.post(
    '/map-punch',
    checkPermissionAny('hrm_attendance', ['create', 'edit', 'view']),
    mapAttendanceFromEmployee,
);

export default router;
