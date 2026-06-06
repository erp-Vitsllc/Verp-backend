import mongoose from "mongoose";

const expiryReminderLogSchema = new mongoose.Schema(
    {
        targetType: { type: String, enum: ["company", "employee"], required: true },
        targetId: { type: String, required: true }, // Company/Employee object id as string
        docKey: { type: String, required: true }, // Stable unique key per expiring doc
        daysBefore: { type: Number, required: true }, // 30 / 20 / 10 / 0 ; negative reserved for post-expiry markers
        expiryDate: { type: Date, required: true },
        metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
        sentAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

expiryReminderLogSchema.index({ targetType: 1, targetId: 1, docKey: 1, daysBefore: 1 }, { unique: true });
expiryReminderLogSchema.index({ createdAt: 1 });

export default mongoose.model("ExpiryReminderLog", expiryReminderLogSchema);
