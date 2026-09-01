import mongoose from 'mongoose';

/** Idempotency: one email per salary month + days-before stage + recipient. */
const salaryProcessReminderLogSchema = new mongoose.Schema(
    {
        yearMonth: { type: String, required: true, trim: true },
        daysBefore: { type: Number, required: true },
        email: { type: String, required: true, trim: true, lowercase: true },
        employeeId: { type: String, default: '', trim: true },
        dueDate: { type: Date, required: true },
        sentAt: { type: Date, default: Date.now },
    },
    { timestamps: true },
);

salaryProcessReminderLogSchema.index(
    { yearMonth: 1, daysBefore: 1, email: 1 },
    { unique: true },
);

export default mongoose.model('SalaryProcessReminderLog', salaryProcessReminderLogSchema);
