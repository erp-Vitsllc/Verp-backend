import mongoose from 'mongoose';

const assetTypeSchema = new mongoose.Schema({
    assetId: {
        type: String,
        required: [true, 'Asset ID is required'],
        trim: true,
        unique: true
    },
    type: { // "Name" of the asset type
        type: String,
        required: [true, 'Asset Type/Name is required'],
        trim: true
    },
    category: {
        type: String,
        required: [true, 'Category is required'],
        trim: true
    },
    total: {
        type: Number,
        default: 0
    },
    assigned: {
        type: Number,
        default: 0
    },
    unassigned: {
        type: Number,
        default: 0
    },
    description: {
        type: String,
        trim: true
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true
});

const AssetType = mongoose.model('AssetType', assetTypeSchema);

export default AssetType;
