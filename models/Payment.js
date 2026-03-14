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
            enum: ['Salary', 'Loan', 'Advance', 'Reward', 'Fine', 'Reimbursement', 'Bonus', 'Other'],
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
            enum: ['Loan', 'Reward', 'Fine', 'Salary', null],
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
