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
        trim: true
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

// Only one *active* row per name. Inactive/legacy rows can share a name; reuse after delete works.
// If migrate fails with duplicate index, drop the old global unique: db.assetcategories.dropIndex("name_1")
assetCategorySchema.index(
    { name: 1 },
    { unique: true, partialFilterExpression: { isActive: true } }
);

const AssetCategory = mongoose.model('AssetCategory', assetCategorySchema);

export default AssetCategory;
