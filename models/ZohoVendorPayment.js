import mongoose from 'mongoose';

const zohoVendorPaymentSchema = new mongoose.Schema(
    {
        zohoPaymentId: { type: String, required: true },
        organizationId: { type: String, required: true },
        date: { type: String, default: '' },
        paymentNumber: { type: String, default: '' },
        referenceNumber: { type: String, default: '' },
        vendorId: { type: String, default: '' },
        vendorName: { type: String, default: '' },
        billNumbers: { type: String, default: '' },
        paymentMode: { type: String, default: '' },
        status: { type: String, default: '' },
        amount: { type: Number, default: 0 },
        balance: { type: Number, default: 0 },
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

zohoVendorPaymentSchema.index({ organizationId: 1, zohoPaymentId: 1 }, { unique: true });
zohoVendorPaymentSchema.index({ organizationId: 1, isActive: 1, date: -1 });

const ZohoVendorPayment = mongoose.model('ZohoVendorPayment', zohoVendorPaymentSchema);

export default ZohoVendorPayment;
