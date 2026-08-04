import mongoose from "mongoose";

/**
 * Payment Schema
 * Tracks payment records with auto-generated payment IDs
 */
const paymentSchema = new mongoose.Schema(
    {
        paymentId: {
            type: String,
            required: false, // Will be auto-generated in pre-save hook
            unique: true,
            index: true
        },
        paymentType: {
            type: String,
            required: true,
            enum: [
                'Salary',
                'Loan',
                'Advance',
                'Reward',
                'Fine',
                'UtilityBill',
                'Reimbursement',
                'Bonus',
                'Other',
            ],
            default: 'Other'
        },
        paidBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'EmployeeBasic',
            required: true
        },
        paidByName: {
            type: String,
            default: ''
        },
        amount: {
            type: Number,
            required: true,
            min: 0
        },
        status: {
            type: String,
            required: true,
            enum: ['Pending', 'Processing', 'Completed', 'Paid', 'Failed', 'Cancelled', 'Rejected'],
            default: 'Pending'
        },
        paymentDate: {
            type: Date,
            default: Date.now
        },
        description: {
            type: String,
            default: ''
        },
        referenceId: {
            type: String,
            default: null
        },
        relatedEntityType: {
            type: String,
            enum: [
                'Loan',
                'Advance',
                'LoanRepayment',
                'AdvanceRepayment',
                'Reward',
                'Fine',
                'Salary',
                'UtilityBill',
                null,
            ],
            default: null
        },
        relatedEntityId: {
            type: mongoose.Schema.Types.ObjectId,
            default: null
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        updatedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null
        },
        remarks: {
            type: String,
            default: ''
        },
        paymentSource: {
            type: String,
            enum: ['Salary', 'End of Benefits', 'Cash', null],
            default: null,
        },
        /** Zoho Books org / COA posting for cash reward (and similar) payouts */
        zohoOrganizationId: { type: String, default: '' },
        paidThroughAccountId: { type: String, default: '' },
        paidThroughAccountName: { type: String, default: '' },
        expenseAccountId: { type: String, default: '' },
        expenseAccountName: { type: String, default: '' },
        zohoJournalId: { type: String, default: '' },
        zohoExpenseId: { type: String, default: '' },
        zohoSyncError: { type: String, default: '' },
        /** Persisted for Zoho Expense Refund retry */
        locationId: { type: String, default: '' },
        taxTreatment: { type: String, default: '' },
        placeOfSupply: { type: String, default: '' },
        taxId: { type: String, default: '' },
        isInclusiveTax: { type: Boolean, default: true },
        vendorId: { type: String, default: '' },
        vendorName: { type: String, default: '' },
        paymentMode: { type: String, default: '' },
        attachment: {
            url: { type: String },
            publicId: { type: String },
            data: { type: String },
            name: { type: String },
            mimeType: { type: String }
        }
    },
    {
        timestamps: true
    }
);

// Auto-generate paymentId before saving
paymentSchema.pre('save', async function (next) {
    if (!this.paymentId) {
        try {
            const count = await mongoose.model('Payment').countDocuments();
            this.paymentId = `PAY-${String(count + 1).padStart(6, '0')}`;
        } catch (error) {
            return next(error);
        }
    }
    next();
});

const Payment = mongoose.model("Payment", paymentSchema);
export default Payment;
