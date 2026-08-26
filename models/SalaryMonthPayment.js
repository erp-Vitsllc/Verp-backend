import mongoose from 'mongoose';

/**
 * One processed payment card on a salary month (Process payment → Done).
 * Employees on a card cannot be selected again for that month.
 */
const salaryMonthPaymentSchema = new mongoose.Schema(
    {
        monthKey: { type: String, required: true, trim: true },
        paymentNo: { type: Number, required: true, min: 1 },
        employeeIds: { type: [String], default: () => [] },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { timestamps: true },
);

salaryMonthPaymentSchema.index({ monthKey: 1, paymentNo: 1 }, { unique: true });
salaryMonthPaymentSchema.index({ monthKey: 1 });

export default mongoose.model('SalaryMonthPayment', salaryMonthPaymentSchema);
