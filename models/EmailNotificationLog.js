import mongoose from 'mongoose';

/**
 * Idempotency log for ERP operational emails.
 * dedupeKey should encode recordId + emailType + stage + event (+ cycle for reminders).
 */
const emailNotificationLogSchema = new mongoose.Schema(
    {
        dedupeKey: { type: String, required: true },
        module: { type: String, default: '' },
        emailType: { type: String, default: '' },
        recordId: { type: String, default: '' },
        to: [{ type: String }],
        cc: [{ type: String }],
        subject: { type: String, default: '' },
        sentAt: { type: Date, default: Date.now },
        metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    { timestamps: true },
);

emailNotificationLogSchema.index({ dedupeKey: 1 }, { unique: true });
emailNotificationLogSchema.index({ recordId: 1, emailType: 1, sentAt: -1 });
emailNotificationLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 400 });

export default mongoose.model('EmailNotificationLog', emailNotificationLogSchema);
