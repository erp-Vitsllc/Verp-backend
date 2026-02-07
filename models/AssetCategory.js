import mongoose from 'mongoose';

const assetCategorySchema = new mongoose.Schema({
    categoryId: {
        type: String,
        required: true,
        unique: true
    },
    name: {
        type: String,
        required: true,
        trim: true,
        unique: true
    },
    imagePreview: {
        type: String,
        default: null
    },
    typeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AssetType',
        required: true
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true
});

const AssetCategory = mongoose.model('AssetCategory', assetCategorySchema);

export default AssetCategory;
