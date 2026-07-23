import mongoose from 'mongoose';

const zohoBillSchema = new mongoose.Schema(
    {
        zohoBillId: { type: String, required: true },
        organizationId: { type: String, required: true },
        date: { type: String, default: '' },
        billNumber: { type: String, default: '' },
        referenceNumber: { type: String, default: '' },
        vendorId: { type: String, default: '' },
        vendorName: { type: String, default: '' },
        status: { type: String, default: '' },
        dueDate: { type: String, default: '' },
        locationName: { type: String, default: '' },
        total: { type: Number, default: 0 },
        balance: { type: Number, default: 0 },
        currencyCode: { type: String, default: 'AED' },
        isActive: { type: Boolean, default: true },
        lastSyncedAt: { type: Date },
        /** Set on each Refresh chunk; rows without the final token are pruned. */
        lastSyncToken: { type: String, default: '', index: true },
        zohoRaw: { type: mongoose.Schema.Types.Mixed, default: null },
        /** Utility Add-more: each item row → one Zoho bill (Debit that account). */
        utilityBillPaymentId: { type: String, default: '', index: true },
        utilityParentBillNumber: { type: String, default: '', index: true },
        utilityLineIndex: { type: Number, default: null },
        utilityDebitAccountId: { type: String, default: '' },
        utilityDebitAccountName: { type: String, default: '' },
        utilityItemDescription: { type: String, default: '' },
    },
    {
        timestamps: true,
        strict: true,
    },
);

zohoBillSchema.index({ organizationId: 1, zohoBillId: 1 }, { unique: true });
zohoBillSchema.index({ organizationId: 1, isActive: 1, date: -1 });
zohoBillSchema.index({ organizationId: 1, isActive: 1, vendorName: 1 });
zohoBillSchema.index({ organizationId: 1, isActive: 1, billNumber: 1 });

const ZohoBill = mongoose.model('ZohoBill', zohoBillSchema);

export default ZohoBill;
