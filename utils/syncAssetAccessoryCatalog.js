import AssetAccessoryCatalog from '../models/AssetAccessoryCatalog.js';

const PREFIX = 'VEGA-ACC-';

/**
 * Next global accessory catalog id: VEGA-ACC-001, VEGA-ACC-002, ...
 * Coexists with legacy ids (e.g. asset-acc-cat-*) in the same collection.
 */
export async function generateVegaAccessoryCatalogId() {
    const escaped = PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escaped}\\d+$`);
    const item = await AssetAccessoryCatalog.findOne({
        accessoryCatalogId: { $regex: regex }
    })
        .sort({ accessoryCatalogId: -1 })
        .lean();

    if (!item?.accessoryCatalogId) {
        return `${PREFIX}${String(1).padStart(3, '0')}`;
    }
    const numStr = item.accessoryCatalogId.substring(PREFIX.length);
    const numericPart = parseInt(numStr, 10);
    const nextNum = Number.isNaN(numericPart) ? 1 : numericPart + 1;
    return `${PREFIX}${String(nextNum).padStart(3, '0')}`;
}

function mapEmbeddedStatusToCatalog(status) {
    const s = String(status || 'Attached').trim();
    if (s === 'Lost') return 'Lost';
    if (s === 'End of Life') return 'EndOfLife';
    if (s === 'Pending') return 'Pending';
    if (s === 'Damaged') return 'Attached';
    if (s === 'Transfered') return 'Attached';
    return 'Attached';
}

/**
 * Upserts a catalog row for one embedded accessory instance (linked to asset + assetAccessoryId).
 */
export async function upsertCatalogInstanceForEmbeddedAccessory(assetDoc, embedded) {
    if (!assetDoc?._id || !embedded?.accessoryId) return null;

    const stEmb = String(embedded?.status || '').trim();
    const paEmb = String(embedded?.pendingAction || '').trim();
    if (stEmb === 'Pending' && paEmb === 'Add') {
        return null;
    }

    const assetItemId = assetDoc._id;
    const assetAccessoryId = String(embedded.accessoryId).trim();
    const catalogStatus = mapEmbeddedStatusToCatalog(embedded.status);
    /** Lost / End of Life: keep catalog row but detach from asset so pool & asset page treat as unattached. */
    const detachFromAsset = stEmb === 'Lost' || stEmb === 'End of Life';

    let existing = null;
    if (embedded._id) {
        existing = await AssetAccessoryCatalog.findOne({
            recordType: 'instance',
            embeddedAccessoryMongoId: embedded._id
        });
    }
    if (!existing) {
        existing = await AssetAccessoryCatalog.findOne({
            recordType: 'instance',
            assetItemId,
            assetAccessoryId
        });
    }

    const linkPayload = detachFromAsset
        ? { assetItemId: null, assetIdRef: '' }
        : { assetItemId, assetIdRef: assetDoc.assetId || '' };

    const basePayload = {
        recordType: 'instance',
        assetAccessoryId,
        embeddedAccessoryMongoId: embedded._id || undefined,
        name: embedded.name || 'Accessory',
        price: Number(embedded.amount) || 0,
        description: embedded.description != null ? String(embedded.description).trim() : '',
        status: catalogStatus,
        isActive: true,
        ...linkPayload
    };

    if (existing) {
        existing.name = basePayload.name;
        existing.price = basePayload.price;
        existing.description = basePayload.description;
        existing.status = basePayload.status;
        existing.assetIdRef = basePayload.assetIdRef;
        existing.assetItemId = basePayload.assetItemId;
        if (embedded._id) existing.embeddedAccessoryMongoId = embedded._id;
        await existing.save();
        return existing;
    }

    const accessoryCatalogId = await generateVegaAccessoryCatalogId();
    const doc = await AssetAccessoryCatalog.create({
        accessoryCatalogId,
        ...basePayload,
        history: [
            {
                at: new Date(),
                action: 'attached',
                message: `Synced from asset ${assetDoc.assetId} — ${assetAccessoryId}`,
                assetId: assetDoc.assetId,
                assetName: assetDoc.name,
                assetObjectId: assetDoc._id
            }
        ]
    });
    return doc;
}

/**
 * After asset create/update: mirror all embedded accessories into the accessories catalog DB.
 */
export async function syncAllAccessoryInstancesForAsset(assetDoc) {
    if (!assetDoc?._id) return;
    const list = assetDoc.accessories || [];
    for (const acc of list) {
        try {
            await upsertCatalogInstanceForEmbeddedAccessory(assetDoc, acc);
        } catch (e) {
            console.error('[syncAllAccessoryInstancesForAsset]', e?.message || e);
        }
    }
}

/**
 * When accessories are removed from an asset (admin delete row), mark catalog instance as Unattached.
 */
export async function markCatalogInstancesDetachedFromAsset(assetItemId, removedAccessoryIds) {
    if (!assetItemId || !removedAccessoryIds?.length) return;
    const ids = removedAccessoryIds.map((a) => (typeof a === 'string' ? a : a?.accessoryId)).filter(Boolean);
    if (!ids.length) return;

    await AssetAccessoryCatalog.updateMany(
        {
            recordType: 'instance',
            assetItemId,
            assetAccessoryId: { $in: ids }
        },
        {
            $set: {
                status: 'Unattached',
                assetItemId: null,
                assetIdRef: ''
            }
        }
    );
}
