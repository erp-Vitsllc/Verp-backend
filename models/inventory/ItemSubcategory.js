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
        imageData: { type: String, default: '' },
        imageName: { type: String, default: '' },
    },
    { timestamps: true },
);

itemSubcategorySchema.index({ nameKey: 1 }, { unique: true });

export default mongoose.model('InventoryItemSubcategory', itemSubcategorySchema);
