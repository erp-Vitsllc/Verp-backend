import mongoose from 'mongoose';

const zohoExpenseSchema = new mongoose.Schema(
    {
        zohoExpenseId: { type: String, required: true },
        organizationId: { type: String, required: true },
        date: { type: String, default: '' },
        accountName: { type: String, default: '' },
        vendorId: { type: String, default: '' },
        vendorName: { type: String, default: '' },
        customerName: { type: String, default: '' },
        referenceNumber: { type: String, default: '' },
        status: { type: String, default: '' },
        total: { type: Number, default: 0 },
        currencyCode: { type: String, default: 'AED' },
        isActive: { type: Boolean, default: true },
        lastSyncedAt: { type: Date },
        zohoRaw: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    {
        timestamps: true,
        strict: true,
    },
);

zohoExpenseSchema.index({ organizationId: 1, zohoExpenseId: 1 }, { unique: true });
zohoExpenseSchema.index({ organizationId: 1, isActive: 1, date: -1 });

const ZohoExpense = mongoose.model('ZohoExpense', zohoExpenseSchema);

export default ZohoExpense;
