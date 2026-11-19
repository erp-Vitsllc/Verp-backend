import mongoose from 'mongoose';

const crmCustomerContactSchema = new mongoose.Schema(
    {
        customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmCustomer', required: true, index: true },
        zohoPersonId: { type: String, default: '', trim: true },
        name: { type: String, required: true, trim: true },
        designation: { type: String, default: '', trim: true },
        emails: { type: [String], default: [] },
        phones: { type: [String], default: [] },
        isPrimary: { type: Boolean, default: false },
    },
    { timestamps: true },
);

crmCustomerContactSchema.index({ customerId: 1, isPrimary: -1, createdAt: 1 });

export default mongoose.model('CrmCustomerContact', crmCustomerContactSchema);
