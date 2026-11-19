import mongoose from 'mongoose';

const deliveryLineSchema = new mongoose.Schema(
    {
        categoryId: { type: String, default: '' },
        categoryName: { type: String, default: '' },
        subcategoryId: { type: String, default: '' },
        subcategoryName: { type: String, default: '' },
        itemOptionId: { type: String, default: '' },
        itemName: { type: String, default: '' },
        brandId: { type: String, default: '' },
        brandName: { type: String, default: '' },
        modelNumber: { type: String, default: '' },
        inventoryItemId: { type: String, default: '' },
        description: { type: String, default: '' },
        detail: { type: String, default: '' },
        quantity: { type: Number, required: true, min: 1 },
        unit: { type: String, default: '' },
    },
    { _id: false },
);

const deliveryOrderSchema = new mongoose.Schema(
    {
        deliveryNo: { type: String, required: true, unique: true, immutable: true },
        deliveryType: { type: String, enum: ['Project', 'Annual', 'Manual'], required: true },
        status: { type: String, enum: ['Draft', 'Submitted', 'Confirming', 'Confirmed', 'Rejected'], default: 'Draft' },
        doDate: { type: String, default: '' },
        projectName: { type: String, default: '' },
        workOrderId: { type: String, default: '' },
        workOrderNo: { type: String, default: '' },
        customerId: { type: String, default: '' },
        customerName: { type: String, default: '' },
        deliveryAddress: { type: String, default: '' },
        contactPersonName: { type: String, default: '' },
        contactNumber: { type: String, default: '' },
        note: { type: String, default: '' },
        lines: { type: [deliveryLineSchema], default: [] },
        stockApplied: { type: Boolean, default: false },
        approverName: { type: String, default: '' },
        createdBy: { type: String, default: '' },
        createdByName: { type: String, default: '' },
    },
    { timestamps: true },
);

deliveryOrderSchema.index({ createdAt: -1 });

export default mongoose.model('DeliveryOrder', deliveryOrderSchema);
