import mongoose from 'mongoose';

const locatorGpsSnapshotSchema = new mongoose.Schema(
    {
        deviceId: { type: Number, required: true, index: true },
        deviceName: { type: String, default: '' },
        uniqueId: { type: String, default: '', index: true },
        odometer: { type: Number, default: 0 },
        totalDistanceM: { type: Number, default: 0 },
        state: { type: String, default: '' },
        speedKmh: { type: Number, default: 0 },
        capturedAt: { type: Date, default: Date.now },
    },
    { timestamps: true },
);

locatorGpsSnapshotSchema.index({ deviceId: 1, capturedAt: -1 });
locatorGpsSnapshotSchema.index({ capturedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 400 });

export default mongoose.model('LocatorGpsSnapshot', locatorGpsSnapshotSchema);
