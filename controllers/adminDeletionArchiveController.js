import {
    getArchiveTree,
    getArchiveCategoryMeta,
    listArchiveItems,
    getArchiveById,
    restoreArchiveById,
    purgeArchiveById,
    getArchiveAttachmentsForView,
    ADMIN_DELETION_ARCHIVE_RETENTION_DAYS,
} from '../services/adminDeletionArchiveService.js';
import { canAccessAdminRestore } from '../utils/adminRestoreAccess.js';

async function ensureRestoreAccess(req, res) {
    const allowed = await canAccessAdminRestore(req.user);
    if (!allowed) {
        res.status(403).json({ message: 'Only administrator or management can access deleted records.' });
        return false;
    }
    return true;
}

export const checkAdminRestoreAccess = async (req, res) => {
    try {
        const allowed = await canAccessAdminRestore(req.user);
        return res.json({ allowed });
    } catch (error) {
        console.error('[checkAdminRestoreAccess]', error);
        return res.status(500).json({ message: 'Failed to check access.' });
    }
};

export const getAdminDeletionArchiveTree = async (req, res) => {
    try {
        if (!(await ensureRestoreAccess(req, res))) return;
        const tree = await getArchiveTree();
        return res.json({
            modules: tree,
            retentionDays: ADMIN_DELETION_ARCHIVE_RETENTION_DAYS,
        });
    } catch (error) {
        console.error('[getAdminDeletionArchiveTree]', error);
        return res.status(500).json({ message: error.message || 'Failed to load deleted records.' });
    }
};

export const getAdminDeletionArchiveMeta = async (req, res) => {
    try {
        if (!(await ensureRestoreAccess(req, res))) return;
        const meta = await getArchiveCategoryMeta();
        return res.json(meta);
    } catch (error) {
        console.error('[getAdminDeletionArchiveMeta]', error);
        return res.status(500).json({ message: 'Failed to load categories.' });
    }
};

export const getAdminDeletionArchiveItems = async (req, res) => {
    try {
        if (!(await ensureRestoreAccess(req, res))) return;
        const { topModule, category, status } = req.query;
        const items = await listArchiveItems({ topModule, category, status });
        return res.json({ items });
    } catch (error) {
        console.error('[getAdminDeletionArchiveItems]', error);
        return res.status(500).json({ message: 'Failed to load items.' });
    }
};

export const getAdminDeletionArchiveAttachments = async (req, res) => {
    try {
        if (!(await ensureRestoreAccess(req, res))) return;
        const attachments = await getArchiveAttachmentsForView(req.params.id);
        return res.json({ attachments });
    } catch (error) {
        console.error('[getAdminDeletionArchiveAttachments]', error);
        return res.status(400).json({ message: error.message || 'Failed to load attachments.' });
    }
};

export const getAdminDeletionArchiveItem = async (req, res) => {
    try {
        if (!(await ensureRestoreAccess(req, res))) return;
        const item = await getArchiveById(req.params.id);
        if (!item) return res.status(404).json({ message: 'Record not found.' });
        return res.json({ item });
    } catch (error) {
        console.error('[getAdminDeletionArchiveItem]', error);
        return res.status(500).json({ message: 'Failed to load record.' });
    }
};

export const restoreAdminDeletionArchiveItem = async (req, res) => {
    try {
        if (!(await ensureRestoreAccess(req, res))) return;
        const archive = await restoreArchiveById(req.params.id, req);
        return res.json({
            message: 'Record restored successfully.',
            item: archive,
        });
    } catch (error) {
        console.error('[restoreAdminDeletionArchiveItem]', error);
        return res.status(400).json({ message: error.message || 'Restore failed.' });
    }
};

export const purgeAdminDeletionArchiveItem = async (req, res) => {
    try {
        if (!(await ensureRestoreAccess(req, res))) return;
        const archive = await purgeArchiveById(req.params.id, req);
        return res.json({
            message: 'Record permanently deleted from recovery.',
            item: archive,
        });
    } catch (error) {
        console.error('[purgeAdminDeletionArchiveItem]', error);
        return res.status(400).json({ message: error.message || 'Permanent delete failed.' });
    }
};
