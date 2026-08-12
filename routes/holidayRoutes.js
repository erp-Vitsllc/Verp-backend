import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkPermission, checkPermissionAny } from '../middleware/permissionMiddleware.js';
import { listHolidays, createHoliday, deleteHoliday } from '../controllers/holidayController.js';

const router = express.Router();

router.use(protect);

// Any logged-in user can read holidays (dashboard calendar)
router.get('/', listHolidays);

// Add / remove — HR attendance permission
router.post(
    '/',
    checkPermissionAny('hrm_attendance', ['create', 'edit', 'view']),
    createHoliday,
);
router.delete(
    '/:date',
    checkPermissionAny('hrm_attendance', ['create', 'edit', 'view']),
    deleteHoliday,
);

export default router;
