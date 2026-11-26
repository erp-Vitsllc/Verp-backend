import mongoose from 'mongoose';

const stockEntryLineSchema = new mongoose.Schema(
    {
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', default: null },
        categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItemCategory', required: true },
        subcategoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItemSubcategory', required: true },
        brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItemBrand', required: true },
        modelNumber: { type: String, default: '', trim: true },
        keepItem: { type: Boolean, default: false },
        itemName: { type: String, default: '', trim: true },
        description: { type: String, default: '', trim: true },
        quantity: { type: Number, default: 0, min: 0 },
        unitPrice: { type: Number, default: 0, min: 0 },
        total: { type: Number, default: 0, min: 0 },
    },
    { _id: false },
);

const inventoryStockEntrySchema = new mongoose.Schema(
    {
        clientRequestId: { type: String, trim: true },
        purchaseSource: { type: String, enum: ['vendor', 'manual'], required: true },
        vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryVendor', default: null },
        purchaseDate: { type: Date, default: null },
        billNo: { type: String, default: '', trim: true },
        lpoNo: { type: String, default: '', trim: true },
        note: { type: String, default: '', trim: true },
        lines: { type: [stockEntryLineSchema], default: [] },
        attachment: {
            name: { type: String, default: '' },
            mimeType: { type: String, default: '' },
            publicId: { type: String, default: '' },
            url: { type: String, default: '' },
        },
        status: { type: String, enum: ['draft', 'posting', 'posted', 'pending'], default: 'draft' },
        postedCount: { type: Number, default: 0, min: 0 },
        postedAt: { type: Date, default: null },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        submittedByName: { type: String, default: '', trim: true },
        approverName: { type: String, default: '', trim: true },
        approverEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic', default: null },
        editPending: { type: Boolean, default: false },
        pendingEdit: {
            purchaseSource: { type: String, default: '' },
            vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryVendor', default: null },
            purchaseDate: { type: Date, default: null },
            billNo: { type: String, default: '' },
            lpoNo: { type: String, default: '' },
            note: { type: String, default: '' },
            lines: { type: [stockEntryLineSchema], default: [] },
            attachment: {
                name: { type: String, default: '' },
                mimeType: { type: String, default: '' },
                publicId: { type: String, default: '' },
                url: { type: String, default: '' },
            },
            submittedByName: { type: String, default: '' },
            submittedAt: { type: Date, default: null },
        },
    },
    { timestamps: true },
);

inventoryStockEntrySchema.index({ clientRequestId: 1 }, { unique: true, sparse: true });
inventoryStockEntrySchema.index({ status: 1, updatedAt: -1 });

export default mongoose.model('InventoryStockEntry', inventoryStockEntrySchema);
