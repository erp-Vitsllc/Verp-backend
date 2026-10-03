import mongoose from 'mongoose';

const locatorFuelMonthStatSchema = new mongoose.Schema(
    {
        deviceId: { type: Number, required: true },
        monthKey: { type: String, required: true, trim: true },
        kmRun: { type: Number, default: 0 },
        runningKm: { type: Number, default: 0 },
        currentKm: { type: Number, default: 0 },
        idleTimeMinutes: { type: Number, default: 0 },
        idleTimeSeconds: { type: Number, default: 0 },
        idleTimeLabel: { type: String, default: '' },
        rangeStart: { type: String, default: null },
        rangeEnd: { type: String, default: null },
        summarySource: { type: String, default: '' },
        computedAt: { type: Date, default: null },
    },
    { timestamps: true },
);

locatorFuelMonthStatSchema.index({ deviceId: 1, monthKey: 1 }, { unique: true });
locatorFuelMonthStatSchema.index({ monthKey: 1 });

export default mongoose.model('LocatorFuelMonthStat', locatorFuelMonthStatSchema);
