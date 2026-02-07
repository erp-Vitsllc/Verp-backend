import mongoose from 'mongoose';

const assetTypeSchema = new mongoose.Schema({
    typeId: {
        type: String,
        required: true,
        unique: true
    },
    name: { // The Type Name (e.g. Laptop)
        type: String,
        required: true,
        trim: true
    },
    imagePreview: {
        type: String,
        default: null
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
