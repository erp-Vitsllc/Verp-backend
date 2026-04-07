import mongoose from 'mongoose';

const assetAccessoryCatalogSchema = new mongoose.Schema({
    /** catalog = pool row (attach flow); instance = synced from an asset line (assetItemId + assetAccessoryId) */
    recordType: {
        type: String,
        enum: ['catalog', 'instance'],
        default: 'catalog'
    },
    assetItemId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AssetItem',
        // IMPORTANT: don't default to null; null participates in unique indexes.
    },
    /** Embedded accessory line id on the asset (e.g. VEGA-ASSET-003A) */
    assetAccessoryId: {
        type: String,
        trim: true
    },
    embeddedAccessoryMongoId: {
        type: mongoose.Schema.Types.ObjectId
    },
    assetIdRef: {
        type: String,
        default: '',
        trim: true
    },
    accessoryCatalogId: {
        type: String,
        required: true,
        unique: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    price: {
        type: Number,
        default: 0
    },
    description: {
        type: String,
        default: '',
        trim: true
    },
    status: {
        type: String,
        enum: ['Unattached', 'Pending', 'Attached', 'Lost', 'EndOfLife'],
        default: 'Unattached'
    },
    isActive: {
        type: Boolean,
        default: true
    },
    history: [{
        at: { type: Date, default: Date.now },
        action: {
            type: String,
            enum: ['created', 'attach_requested', 'attach_rejected', 'attached', 'unattached', 'updated', 'removed', 'synced']
        },
        message: { type: String, required: true, trim: true },
        assetId: { type: String, trim: true },
        assetName: { type: String, trim: true },
        assetObjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'AssetItem', default: null }
    }]
}, {
    timestamps: true
});

assetAccessoryCatalogSchema.index(
    { assetItemId: 1, assetAccessoryId: 1 },
    {
        unique: true,
        name: 'instance_asset_accessory',
        partialFilterExpression: { recordType: 'instance' }
    }
);

const AssetAccessoryCatalog = mongoose.model('AssetAccessoryCatalog', assetAccessoryCatalogSchema);

// Ensure the unique index only applies to instance rows (dev safety / migrations).
// If an older sparse unique index exists, it can break inserts with null keys.
try {
    mongoose.connection?.once?.('connected', async () => {
        try {
            await AssetAccessoryCatalog.collection.dropIndex('instance_asset_accessory');
        } catch (e) {
            // ignore: index may not exist yet
        }
        try {
            await AssetAccessoryCatalog.collection.createIndex(
                { assetItemId: 1, assetAccessoryId: 1 },
                {
                    unique: true,
                    name: 'instance_asset_accessory',
                    partialFilterExpression: { recordType: 'instance' }
                }
            );
        } catch (e) {
            console.error('[AssetAccessoryCatalog index ensure] Non-fatal:', e?.message || e);
        }
    });
} catch (e) {
    // non-fatal
}

export default AssetAccessoryCatalog;
