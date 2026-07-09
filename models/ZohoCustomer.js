import mongoose from 'mongoose';

const zohoCustomerSchema = new mongoose.Schema(
    {
        zohoContactId: { type: String, required: true },
        zohoCustomerId: { type: String, default: '' },
        organizationId: { type: String, required: true },
        contactName: { type: String, default: '' },
        companyName: { type: String, default: '' },
        email: { type: String, default: '' },
        phone: { type: String, default: '' },
        mobile: { type: String, default: '' },
        outstandingReceivableAmount: { type: Number, default: 0 },
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

zohoCustomerSchema.index({ organizationId: 1, zohoContactId: 1 }, { unique: true });
zohoCustomerSchema.index({ organizationId: 1, isActive: 1, contactName: 1 });

const ZohoCustomer = mongoose.model('ZohoCustomer', zohoCustomerSchema);

export default ZohoCustomer;
