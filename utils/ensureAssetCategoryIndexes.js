import AssetCategory from '../models/AssetCategory.js';

/**
 * MongoDB may still have the old global unique index on `name` (`name_1`).
 * The schema now uses a partial unique index (unique only when isActive is true).
 * Drop the legacy index once, then sync so inserts work after a "deleted" (inactive) row.
 */
export async function ensureAssetCategoryIndexes() {
    try {
        const coll = AssetCategory.collection;
        const indexes = await coll.indexes();

        for (const idx of indexes) {
            if (idx.name === 'name_1' && idx.key && idx.key.name === 1 && !idx.partialFilterExpression) {
                await coll.dropIndex('name_1');
                console.log('[AssetCategory] Dropped legacy global unique index name_1.');
                break;
            }
        }

        await AssetCategory.syncIndexes();
        console.log('[AssetCategory] Indexes synced.');
    } catch (e) {
        // ns not found / index already dropped / race — non-fatal
        console.warn('[AssetCategory] Index maintenance (non-fatal):', e?.message || e);
    }
}
