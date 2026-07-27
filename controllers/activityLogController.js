import ActivityLog from '../models/ActivityLog.js';
import AssetItem from '../models/AssetItem.js';
import mongoose from 'mongoose';
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

function looksLikeObjectId(value) {
    return /^[a-fA-F0-9]{24}$/.test(String(value || '').trim());
}

/** Replace bare Mongo ids in Asset activity rows with VEGA-VHCL-… / name for display. */
async function enrichAssetActivityLabels(items = []) {
    const rows = Array.isArray(items) ? items : [];
    const mongoIds = new Set();

    for (const row of rows) {
        if (String(row?.entityType || '') !== 'Asset') continue;
        const metaId = String(row?.metadata?.assetMongoId || '').trim();
        const entityId = String(row?.entityId || '').trim();
        if (looksLikeObjectId(metaId)) mongoIds.add(metaId);
        if (looksLikeObjectId(entityId)) mongoIds.add(entityId);
        const summaryIdMatch = String(row?.summary || '').match(/\b([a-fA-F0-9]{24})\b/);
        if (summaryIdMatch?.[1]) mongoIds.add(summaryIdMatch[1]);
    }

    if (!mongoIds.size) return rows;

    const validIds = [...mongoIds].filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (!validIds.length) return rows;

    const assets = await AssetItem.find({ _id: { $in: validIds } })
        .select('_id assetId name plateNumber plateEmirate')
        .lean();
    const byId = new Map(
        assets.map((asset) => {
            const plate = [asset.plateEmirate, asset.plateNumber].filter(Boolean).join(' ').trim();
            const label =
                asset.assetId && asset.name
                    ? `${asset.assetId} · ${asset.name}`
                    : asset.assetId && plate
                      ? `${asset.assetId} · ${plate}`
                      : asset.assetId || asset.name || String(asset._id);
            return [String(asset._id), { label, assetId: asset.assetId || '', mongoId: String(asset._id) }];
        }),
    );

    // Old rows may have stored AssetHistory _id by mistake — resolve via history → asset.
    const missing = validIds.filter((id) => !byId.has(String(id)));
    if (missing.length) {
        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            const histories = await AssetHistory.find({ _id: { $in: missing } })
                .select('_id assetId')
                .lean();
            const parentAssetIds = [
                ...new Set(
                    histories
                        .map((h) => String(h.assetId || '').trim())
                        .filter((id) => mongoose.Types.ObjectId.isValid(id)),
                ),
            ];
            if (parentAssetIds.length) {
                const parents = await AssetItem.find({ _id: { $in: parentAssetIds } })
                    .select('_id assetId name plateNumber plateEmirate')
                    .lean();
                const parentById = new Map(
                    parents.map((asset) => {
                        const plate = [asset.plateEmirate, asset.plateNumber]
                            .filter(Boolean)
                            .join(' ')
                            .trim();
                        const label =
                            asset.assetId && asset.name
                                ? `${asset.assetId} · ${asset.name}`
                                : asset.assetId && plate
                                  ? `${asset.assetId} · ${plate}`
                                  : asset.assetId || asset.name || String(asset._id);
                        return [
                            String(asset._id),
                            { label, assetId: asset.assetId || '', mongoId: String(asset._id) },
                        ];
                    }),
                );
                for (const history of histories) {
                    const parent = parentById.get(String(history.assetId || ''));
                    if (parent) byId.set(String(history._id), parent);
                }
            }
        } catch (err) {
            console.warn('[listActivityLogs] history→asset enrich failed:', err?.message || err);
        }
    }

    return rows.map((row) => {
        if (String(row?.entityType || '') !== 'Asset') return row;
        const metaId = String(row?.metadata?.assetMongoId || '').trim();
        const entityId = String(row?.entityId || '').trim();
        const summaryIdMatch = String(row?.summary || '').match(/\b([a-fA-F0-9]{24})\b/);
        const key =
            (looksLikeObjectId(metaId) && metaId) ||
            (looksLikeObjectId(entityId) && entityId) ||
            summaryIdMatch?.[1] ||
            '';
        const resolved = key ? byId.get(key) : null;
        if (!resolved) return row;

        let summary = String(row.summary || '');
        if (key && summary.includes(key)) {
            summary = summary.replace(key, resolved.label);
        } else if (/updated asset/i.test(summary) && !summary.includes(resolved.label)) {
            summary = summary.replace(/\s+[a-fA-F0-9]{24}\s*$/, '').trim();
            if (/updated asset\s*$/i.test(summary)) {
                summary = `updated asset ${resolved.label}`;
            } else if (!summary.toLowerCase().includes(String(resolved.assetId || '').toLowerCase())) {
                summary = `${summary} ${resolved.label}`.trim();
            }
        }

        return {
            ...row,
            entityId: resolved.assetId || row.entityId,
            summary,
            viewHref:
                row.viewHref ||
                `/HRM/Asset/Vehicle/details/${encodeURIComponent(resolved.mongoId)}`,
            metadata: {
                ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
                displayLabel: resolved.label,
                assetMongoId: resolved.mongoId,
            },
        };
    });
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
                { 'metadata.displayLabel': rx },
            ];
        }

        const [rawItems, total, modules] = await Promise.all([
            ActivityLog.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            ActivityLog.countDocuments(filter),
            ActivityLog.distinct('module'),
        ]);

        const items = await enrichAssetActivityLabels(rawItems);

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
