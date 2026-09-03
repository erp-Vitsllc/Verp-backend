import mongoose from 'mongoose';

/**
 * Edited monthly salary slip for one employee. Overrides the computed slip
 * on preview, PDF, and the enroll Salary slip tab.
 */
const salarySlipMonthSchema = new mongoose.Schema(
    {
        employeeId: { type: String, required: true, trim: true },
        monthKey: { type: String, required: true, trim: true },
        slip: { type: mongoose.Schema.Types.Mixed, default: null },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { timestamps: true },
);

salarySlipMonthSchema.index({ employeeId: 1, monthKey: 1 }, { unique: true });

export default mongoose.model('SalarySlipMonth', salarySlipMonthSchema);
