import mongoose from 'mongoose';

const UNITS = ['Box', 'Metre', 'Quantity'];
const STATUSES = ['Active', 'Low Stock', 'Out of Stock'];

const inventoryItemSchema = new mongoose.Schema(
    {
        itemCode: { type: String, required: true, unique: true },
        categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItemCategory', required: true },
        subcategoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItemSubcategory', required: true },
        itemOptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItemOption', default: null },
        brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItemBrand', required: true },
        description: { type: String, required: true, trim: true },
        moreDescription: { type: String, default: '', trim: true },
        copyToDescription: { type: Boolean, default: false },
        modelNumber: { type: String, default: '', trim: true },
        unitOfMeasure: { type: String, enum: UNITS, required: true },
        manufacturerPartNumber: { type: String, default: '', trim: true },
        reservationQuantity: { type: Number, default: 0, min: 0 },
        hsCode: { type: String, default: '', trim: true },
        countryOfOrigin: { type: String, default: '', trim: true },
        status: { type: String, enum: STATUSES, default: 'Active' },
        availableQuantity: { type: Number, default: 0, min: 0 },
    },
    { timestamps: true },
);

export const INVENTORY_UNITS = UNITS;
export const INVENTORY_STATUSES = STATUSES;
export default mongoose.model('InventoryItem', inventoryItemSchema);
