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
    }
}, {
    timestamps: true
});

const AssetAccessoryCatalog = mongoose.model('AssetAccessoryCatalog', assetAccessoryCatalogSchema);

export default AssetAccessoryCatalog;
