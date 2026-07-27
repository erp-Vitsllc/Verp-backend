import mongoose from 'mongoose';

/** Idempotency log: one email/bell per entry + contract end date + stage. */
const utilityContractExpiryReminderLogSchema = new mongoose.Schema(
    {
        entryId: { type: String, required: true, trim: true },
        /** Contract end date as YYYY-MM-DD */
        contractEndKey: { type: String, required: true, trim: true },
        /** 10 | 5 | 0 (days before / on expiry) */
        daysBefore: { type: Number, required: true },
        contractEnd: { type: Date, required: true },
        sentAt: { type: Date, default: Date.now },
    },
    { timestamps: true },
);

utilityContractExpiryReminderLogSchema.index(
    { entryId: 1, contractEndKey: 1, daysBefore: 1 },
    { unique: true },
);

export default mongoose.model(
    'UtilityContractExpiryReminderLog',
    utilityContractExpiryReminderLogSchema,
);
