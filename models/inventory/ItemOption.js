import mongoose from 'mongoose';

const itemOptionSchema = new mongoose.Schema(
    {
        subcategoryId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'InventoryItemSubcategory',
            required: true,
            index: true,
        },
        name: { type: String, required: true, trim: true },
        nameKey: { type: String, required: true },
    },
    { timestamps: true },
);

itemOptionSchema.index({ subcategoryId: 1, nameKey: 1 }, { unique: true });

export default mongoose.model('InventoryItemOption', itemOptionSchema);
