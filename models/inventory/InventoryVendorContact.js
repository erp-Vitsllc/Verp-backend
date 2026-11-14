import mongoose from 'mongoose';

const handlingLineSchema = new mongoose.Schema(
    {
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', default: null },
        itemLabel: { type: String, default: '', trim: true },
        categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItemCategory', default: null },
        categoryName: { type: String, default: '', trim: true },
        brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItemBrand', default: null },
        brandName: { type: String, default: '', trim: true },
    },
    { _id: false },
);

const inventoryVendorContactSchema = new mongoose.Schema(
    {
        vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryVendor', required: true, index: true },
        zohoPersonId: { type: String, default: '', trim: true },
        name: { type: String, required: true, trim: true },
        designation: { type: String, default: '', trim: true },
        emails: { type: [String], default: [] },
        phones: { type: [String], default: [] },
        isPrimary: { type: Boolean, default: false },
        lines: { type: [handlingLineSchema], default: [] },
    },
    { timestamps: true },
);

inventoryVendorContactSchema.index({ vendorId: 1, isPrimary: -1, createdAt: 1 });

export default mongoose.model('InventoryVendorContact', inventoryVendorContactSchema);
