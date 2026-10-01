import mongoose from 'mongoose';

const locatorDailySummarySchema = new mongoose.Schema(
    {
        deviceId: { type: Number, required: true, index: true },
        /** Inclusive Asia/Dubai report bounds sent to Locator, DD-MM-YYYY HH:mm:ss. */
        rangeFrom: { type: String, required: true },
        rangeTo: { type: String, required: true },
        reportDate: { type: String, default: '' },
        raw: { type: mongoose.Schema.Types.Mixed, default: null },
        distanceKm: { type: Number, default: null },
        drivingTimeMs: { type: Number, default: null },
        idleTimeMs: { type: Number, default: null },
        drivingTimeLabel: { type: String, default: '' },
        idleTimeLabel: { type: String, default: '' },
        averageSpeedKmh: { type: Number, default: null },
        maxSpeedKmh: { type: Number, default: null },
        totalTrips: { type: Number, default: null },
        startOdometerKm: { type: Number, default: null },
        endOdometerKm: { type: Number, default: null },
        currentBattery: { type: mongoose.Schema.Types.Mixed, default: null },
        syncedAt: { type: Date, default: null },
        syncStatus: { type: String, default: 'ok' },
        errorMessage: { type: String, default: '' },
    },
    { timestamps: true },
);

locatorDailySummarySchema.index({ deviceId: 1, rangeFrom: 1, rangeTo: 1 }, { unique: true });

export default mongoose.model('LocatorDailySummary', locatorDailySummarySchema);
