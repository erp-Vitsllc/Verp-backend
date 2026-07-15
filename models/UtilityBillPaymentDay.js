import mongoose from 'mongoose';

/**
 * Monthly payment-day registry for utility accounts (day 1–31).
 * Used by the daily reminder job (T-10 / T-5 / due day) for HR email + bell.
 */
const utilityBillPaymentDaySchema = new mongoose.Schema(
    {
        entryId: { type: String, required: true, unique: true, trim: true },
        paymentDay: { type: Number, required: true, min: 1, max: 31 },
        utilityType: { type: String, default: '', trim: true },
        accountNo: { type: String, default: '', trim: true },
        provider: { type: String, default: '', trim: true },
        status: {
            type: String,
            enum: ['Active', 'Inactive'],
            default: 'Active',
        },
    },
    { timestamps: true },
);

utilityBillPaymentDaySchema.index({ status: 1, paymentDay: 1 });

export default mongoose.model('UtilityBillPaymentDay', utilityBillPaymentDaySchema);
