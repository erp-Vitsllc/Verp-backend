import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { getSignedAttachmentUrl } from '../controllers/storage/getSignedAttachmentUrl.js';

const router = express.Router();

router.post('/signed-url', protect, getSignedAttachmentUrl);
router.get('/signed-url', protect, getSignedAttachmentUrl);

export default router;
