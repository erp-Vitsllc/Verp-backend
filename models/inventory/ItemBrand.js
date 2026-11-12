import mongoose from 'mongoose';

const itemBrandSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        nameKey: { type: String, required: true, unique: true },
        imageData: { type: String, default: '' },
        imageName: { type: String, default: '' },
    },
    { timestamps: true },
);

export default mongoose.model('InventoryItemBrand', itemBrandSchema);
