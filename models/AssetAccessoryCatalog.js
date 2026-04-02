import mongoose from 'mongoose';

const assetAccessoryCatalogSchema = new mongoose.Schema({
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
        enum: ['Unattached', 'Pending', 'Attached'],
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
            enum: ['created', 'attach_requested', 'attach_rejected', 'attached', 'unattached', 'updated', 'removed']
        },
        message: { type: String, required: true, trim: true },
        assetId: { type: String, trim: true },
        assetName: { type: String, trim: true },
        assetObjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'AssetItem', default: null }
    }]
}, {
    timestamps: true
});

const AssetAccessoryCatalog = mongoose.model('AssetAccessoryCatalog', assetAccessoryCatalogSchema);

export default AssetAccessoryCatalog;
