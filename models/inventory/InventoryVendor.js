import mongoose from 'mongoose';

const inventoryVendorSchema = new mongoose.Schema(
    {
        vendorCode: { type: String, required: true, unique: true, trim: true },
        zohoContactId: { type: String, required: true, unique: true, trim: true },
        name: { type: String, required: true, trim: true },
        nameKey: { type: String, required: true },
        location: { type: String, default: '', trim: true },
        address: { type: String, default: '', trim: true },
        primaryContact: { type: String, default: '', trim: true },
        email: { type: String, default: '', trim: true },
        phone: { type: String, default: '', trim: true },
        website: { type: String, default: '', trim: true },
        taxRegNo: { type: String, default: '', trim: true },
        brands: { type: [String], default: [] },
        productCount: { type: Number, default: null },
        vendorType: { type: String, default: '', trim: true },
        paymentTerms: { type: String, default: '', trim: true },
        status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
    },
    { timestamps: true },
);

inventoryVendorSchema.index({ nameKey: 1 });
inventoryVendorSchema.index({ status: 1, vendorCode: 1 });

export default mongoose.model('InventoryVendor', inventoryVendorSchema);
