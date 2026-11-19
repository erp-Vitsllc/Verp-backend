import mongoose from 'mongoose';

const crmCustomerSchema = new mongoose.Schema(
    {
        customerCode: { type: String, required: true, unique: true, trim: true },
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
        paymentTerms: { type: String, default: '', trim: true },
        status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
        suppressedZohoContactIds: { type: [String], default: [] },
    },
    { timestamps: true },
);

crmCustomerSchema.index({ nameKey: 1 });
crmCustomerSchema.index({ status: 1, customerCode: 1 });

export default mongoose.model('CrmCustomer', crmCustomerSchema);
