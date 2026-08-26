import mongoose from 'mongoose';

/**
 * One enrollment per employee. They appear on every salary month from fromMonth onward.
 * salaryDate / processDate are the per-employee values copied from policy at enroll (editable).
 */
const salaryEnrollmentSchema = new mongoose.Schema(
    {
        employeeId: { type: String, required: true, trim: true },
        fromMonth: { type: String, required: true, trim: true },
        salaryDate: { type: String, default: '' },
        processDate: { type: String, default: '' },
        policy: { type: mongoose.Schema.Types.Mixed, default: null },
        enrolledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { timestamps: true },
);

salaryEnrollmentSchema.index({ employeeId: 1 }, { unique: true });
salaryEnrollmentSchema.index({ fromMonth: 1 });

export default mongoose.model('SalaryEnrollment', salaryEnrollmentSchema);
