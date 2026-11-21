import mongoose from 'mongoose';

const workOrderSchema = new mongoose.Schema(
    {
        workOrderNo: { type: String, required: true, unique: true, immutable: true },
        createdOn: { type: String, required: true, immutable: true },
        year: { type: Number, required: true, immutable: true },
        sequence: { type: Number, required: true, immutable: true },
        customer: { type: String, required: true, trim: true },
        quotationRef: { type: String, default: '', trim: true },
        quotationId: { type: String, default: '', trim: true },
        quotationDate: { type: String, default: '' },
        valueExclVat: { type: Number, default: 0, min: 0 },
        vatAmount: { type: Number, default: 0, min: 0 },
        lpoNo: { type: String, default: '', trim: true },
        confirmationDate: { type: String, default: '' },
        location: { type: String, default: '', trim: true },
        description: { type: String, default: '', trim: true },
        salespersonId: { type: String, default: '' },
        salespersonEmployeeId: { type: String, default: '' },
        salespersonName: { type: String, default: '', trim: true },
        draftForEmployeeIds: { type: [String], default: [] },
        lpoMode: {
            type: String,
            enum: ['required', 'not_required', 'received'],
            default: 'required',
        },
        lpos: {
            type: [
                {
                    lpoNo: { type: String, default: '', trim: true },
                    lpoDate: { type: String, default: '' },
                    lpoValue: { type: Number, default: 0, min: 0 },
                    attachmentName: { type: String, default: '' },
                    attachmentMime: { type: String, default: '' },
                    attachmentData: { type: String, default: '' },
                    attachmentBytes: { type: Number, default: 0 },
                },
            ],
            default: [],
        },
        attachmentPending: { type: Boolean, default: false },
        lpoAlert: {
            active: { type: Boolean, default: false },
            kind: { type: String, default: '' },
            message: { type: String, default: '' },
            sentAt: { type: Date },
            sentByName: { type: String, default: '' },
            sentById: { type: String, default: '' },
            attachmentName: { type: String, default: '' },
            attachmentMime: { type: String, default: '' },
            attachmentData: { type: String, default: '' },
            attachmentBytes: { type: Number, default: 0 },
            emailed: { type: Boolean, default: false },
            emailTo: { type: String, default: '' },
            forEmployeeIds: { type: [String], default: [] },
        },
        status: {
            type: String,
            enum: ['Draft', 'Not Started', 'Awaiting LPO', 'In Progress', 'Fully Invoiced', 'Completed'],
            default: 'Draft',
        },
        type: {
            type: String,
            enum: ['Standalone', 'Main WO', 'Variation'],
            default: 'Standalone',
        },
        value: { type: Number, default: 0, min: 0 },
        invoicedAmount: { type: Number, default: 0, min: 0 },
        projectName: { type: String, default: '', trim: true },
        createdBy: { type: String, default: '' },
        createdByName: { type: String, default: '' },
    },
    { timestamps: true },
);

workOrderSchema.index({ year: 1, sequence: 1 }, { unique: true });

export default mongoose.model('WorkOrder', workOrderSchema);
