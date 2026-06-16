import mongoose from "mongoose";

const birthdayReminderLogSchema = new mongoose.Schema(
    {
        employeeId: { type: String, required: true },
        year: { type: Number, required: true },
        sentTo: [{ type: String }],
        sentAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

birthdayReminderLogSchema.index({ employeeId: 1, year: 1 }, { unique: true });

export default mongoose.model("BirthdayReminderLog", birthdayReminderLogSchema);
