import mongoose from 'mongoose';

const itemSubcategorySchema = new mongoose.Schema(
    {
        categoryId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'InventoryItemCategory',
            required: true,
            index: true,
        },
        name: { type: String, required: true, trim: true },
        nameKey: { type: String, required: true },
        imageData: { type: String, required: true },
        imageName: { type: String, default: '' },
    },
    { timestamps: true },
);

itemSubcategorySchema.index({ categoryId: 1, nameKey: 1 }, { unique: true });

export default mongoose.model('InventoryItemSubcategory', itemSubcategorySchema);
