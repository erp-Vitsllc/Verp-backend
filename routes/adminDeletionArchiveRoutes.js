import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
    checkAdminRestoreAccess,
    getAdminDeletionArchiveTree,
    getAdminDeletionArchiveMeta,
    getAdminDeletionArchiveItems,
    getAdminDeletionArchiveItem,
    restoreAdminDeletionArchiveItem,
    purgeAdminDeletionArchiveItem,
} from '../controllers/adminDeletionArchiveController.js';

const router = express.Router();

router.use(protect);

router.get('/access', checkAdminRestoreAccess);
router.get('/meta', getAdminDeletionArchiveMeta);
router.get('/tree', getAdminDeletionArchiveTree);
router.get('/items', getAdminDeletionArchiveItems);
router.get('/:id', getAdminDeletionArchiveItem);
router.post('/:id/restore', restoreAdminDeletionArchiveItem);
router.delete('/:id', purgeAdminDeletionArchiveItem);

export default router;
