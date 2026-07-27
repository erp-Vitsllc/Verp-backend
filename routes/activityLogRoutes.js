import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
    checkActivityLogAccess,
    listActivityLogs,
} from '../controllers/activityLogController.js';

const router = express.Router();

router.use(protect);

router.get('/access', checkActivityLogAccess);
router.get('/', listActivityLogs);

export default router;
