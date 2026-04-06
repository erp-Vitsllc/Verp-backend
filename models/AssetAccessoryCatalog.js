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
        default: null
    },
    /** Embedded accessory line id on the asset (e.g. VEGA-ASSET-003A) */
    assetAccessoryId: {
        type: String,
        default: null,
        trim: true
    },
    embeddedAccessoryMongoId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null
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
    { unique: true, sparse: true, name: 'instance_asset_accessory' }
);

const AssetAccessoryCatalog = mongoose.model('AssetAccessoryCatalog', assetAccessoryCatalogSchema);

export default AssetAccessoryCatalog;
