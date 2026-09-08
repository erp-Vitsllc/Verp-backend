import mongoose from 'mongoose';

/** Idempotency: one Access Fuel email per month per Admin Officer. */
const vehicleAccessFuelReminderLogSchema = new mongoose.Schema(
    {
        monthKey: { type: String, required: true, trim: true },
        email: { type: String, required: true, trim: true, lowercase: true },
        employeeId: { type: String, default: '', trim: true },
        missingCount: { type: Number, default: 0 },
        sentAt: { type: Date, default: Date.now },
    },
    { timestamps: true },
);

vehicleAccessFuelReminderLogSchema.index({ monthKey: 1, email: 1 }, { unique: true });

export default mongoose.model('VehicleAccessFuelReminderLog', vehicleAccessFuelReminderLogSchema);
