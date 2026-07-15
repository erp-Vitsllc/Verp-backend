import mongoose from 'mongoose';

const utilityBillPaymentSchema = new mongoose.Schema(
    {
        entryId: { type: String, required: true, index: true },
        utilityType: { type: String, required: true, trim: true },
        amount: { type: Number, required: true, min: 0 },
        monthlyRental: { type: Number, default: 0, min: 0 },
        billMonth: { type: String, default: '' },
        notes: { type: String, default: '' },
        /** company = full bill by company; employee_balance = company covers monthly, employee pays excess */
        paymentBy: {
            type: String,
            enum: ['company', 'employee_balance'],
            default: undefined,
        },
        companyPayAmount: { type: Number, default: 0 },
        employeePayAmount: { type: Number, default: 0 },
        status: {
            type: String,
            enum: ['Approved', 'Pending HR', 'Rejected'],
            default: 'Approved',
            index: true,
        },
        requestedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'EmployeeBasic',
            default: null,
        },
        requestedByName: { type: String, default: '' },
        actionedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'EmployeeBasic',
            default: null,
        },
        actionedAt: { type: Date, default: null },
        comment: { type: String, default: '' },
    },
    { timestamps: true },
);

utilityBillPaymentSchema.index({ entryId: 1, createdAt: -1 });

export default mongoose.model('UtilityBillPayment', utilityBillPaymentSchema);
