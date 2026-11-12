import mongoose from 'mongoose';

const itemCategorySchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        nameKey: { type: String, required: true, unique: true },
    },
    { timestamps: true },
);

export default mongoose.model('InventoryItemCategory', itemCategorySchema);
