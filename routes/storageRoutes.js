import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { getSignedAttachmentUrl } from '../controllers/storage/getSignedAttachmentUrl.js';
import { streamStorageFile } from '../controllers/storage/streamStorageFile.js';

const router = express.Router();

router.get('/file', protect, streamStorageFile);
router.post('/signed-url', protect, getSignedAttachmentUrl);
router.get('/signed-url', protect, getSignedAttachmentUrl);

export default router;
