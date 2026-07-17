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
        total: { type: Number, default: 0 },
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

zohoBillSchema.index({ organizationId: 1, zohoBillId: 1 }, { unique: true });
zohoBillSchema.index({ organizationId: 1, isActive: 1, date: -1 });

const ZohoBill = mongoose.model('ZohoBill', zohoBillSchema);

export default ZohoBill;
