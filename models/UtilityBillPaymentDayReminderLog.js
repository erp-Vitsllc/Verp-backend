import mongoose from 'mongoose';

/** Idempotency log: one email/bell per entry + yearMonth + daysBefore stage. */
const utilityBillPaymentDayReminderLogSchema = new mongoose.Schema(
    {
        entryId: { type: String, required: true, trim: true },
        yearMonth: { type: String, required: true, trim: true }, // YYYY-MM of due month
        daysBefore: { type: Number, required: true }, // 10 | 5 | 0
        dueDate: { type: Date, required: true },
        sentAt: { type: Date, default: Date.now },
    },
    { timestamps: true },
);

utilityBillPaymentDayReminderLogSchema.index(
    { entryId: 1, yearMonth: 1, daysBefore: 1 },
    { unique: true },
);

export default mongoose.model(
    'UtilityBillPaymentDayReminderLog',
    utilityBillPaymentDayReminderLogSchema,
);
