import ActivityLog from '../models/ActivityLog.js';
import { canViewAdminDeletionArchive } from '../utils/adminRestoreAccess.js';

async function ensureViewAccess(req, res) {
    const allowed = await canViewAdminDeletionArchive(req.user);
    if (!allowed) {
        res.status(403).json({
            message: 'Only administrator or management can access activity logs.',
        });
        return false;
    }
    return true;
}

export const checkActivityLogAccess = async (req, res) => {
    try {
        const allowed = await canViewAdminDeletionArchive(req.user);
        return res.json({ allowed });
    } catch (error) {
        console.error('[checkActivityLogAccess]', error);
        return res.status(500).json({ message: 'Failed to check access.' });
    }
};

/**
 * GET /api/ActivityLog
 * Query: page, limit, module, action, search, from, to
 */
export const listActivityLogs = async (req, res) => {
    try {
        if (!(await ensureViewAccess(req, res))) return;

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const skip = (page - 1) * limit;

        const filter = {};
        if (req.query.module) filter.module = String(req.query.module);
        if (req.query.action) filter.action = String(req.query.action);

        if (req.query.from || req.query.to) {
            filter.createdAt = {};
            if (req.query.from) {
                const from = new Date(req.query.from);
                if (!Number.isNaN(from.getTime())) filter.createdAt.$gte = from;
            }
            if (req.query.to) {
                const to = new Date(req.query.to);
                if (!Number.isNaN(to.getTime())) {
                    to.setHours(23, 59, 59, 999);
                    filter.createdAt.$lte = to;
                }
            }
            if (!Object.keys(filter.createdAt).length) delete filter.createdAt;
        }

        const search = String(req.query.search || '').trim();
        if (search) {
            const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter.$or = [
                { summary: rx },
                { 'actor.name': rx },
                { entityId: rx },
                { entityType: rx },
                { module: rx },
                { ip: rx },
            ];
        }

        const [items, total, modules] = await Promise.all([
            ActivityLog.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            ActivityLog.countDocuments(filter),
            ActivityLog.distinct('module'),
        ]);

        return res.json({
            items,
            total,
            page,
            limit,
            totalPages: Math.max(1, Math.ceil(total / limit)),
            modules: (modules || []).filter(Boolean).sort(),
        });
    } catch (error) {
        console.error('[listActivityLogs]', error);
        return res.status(500).json({ message: error.message || 'Failed to load activity logs.' });
    }
};
