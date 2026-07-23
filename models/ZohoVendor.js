import mongoose from 'mongoose';

const zohoVendorSchema = new mongoose.Schema(
    {
        zohoContactId: { type: String, required: true },
        zohoVendorId: { type: String, default: '' },
        organizationId: { type: String, required: true },
        contactName: { type: String, default: '' },
        companyName: { type: String, default: '' },
        email: { type: String, default: '' },
        phone: { type: String, default: '' },
        mobile: { type: String, default: '' },
        outstandingPayableAmount: { type: Number, default: 0 },
        currencyCode: { type: String, default: 'AED' },
        locationId: { type: String, default: '' },
        locationName: { type: String, default: '' },
        paymentTerms: { type: mongoose.Schema.Types.Mixed, default: null },
        paymentTermsLabel: { type: String, default: '' },
        placeOfContact: { type: String, default: '' },
        isActive: { type: Boolean, default: true },
        lastSyncedAt: { type: Date },
        /** Set on each Refresh chunk; rows without the final token are pruned. */
        lastSyncToken: { type: String, default: '', index: true },
        zohoRaw: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    {
        timestamps: true,
        strict: true,
    },
);

zohoVendorSchema.index({ organizationId: 1, zohoContactId: 1 }, { unique: true });
zohoVendorSchema.index({ organizationId: 1, isActive: 1, contactName: 1 });
zohoVendorSchema.index({ organizationId: 1, isActive: 1, companyName: 1 });
zohoVendorSchema.index({ organizationId: 1, isActive: 1, email: 1 });

const ZohoVendor = mongoose.model('ZohoVendor', zohoVendorSchema);

export default ZohoVendor;
