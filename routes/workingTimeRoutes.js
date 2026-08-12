import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkPermissionAny } from '../middleware/permissionMiddleware.js';
import { getWorkingTime, upsertWorkingTime } from '../controllers/workingTimeController.js';

const router = express.Router();

router.use(protect);

router.get('/', getWorkingTime);

router.put(
    '/',
    checkPermissionAny('hrm_attendance', ['create', 'edit', 'view']),
    upsertWorkingTime,
);

export default router;
