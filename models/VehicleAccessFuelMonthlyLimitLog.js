import mongoose from 'mongoose';

/** One Access Fuel monthly-limit log per month, with the vehicles already set. */
const vehicleAccessFuelMonthlyLimitLogSchema = new mongoose.Schema(
    {
        monthKey: { type: String, required: true, trim: true, unique: true },
        vehicleIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AssetItem' }],
        vehicleCount: { type: Number, default: 0 },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        createdAt: { type: Date, default: Date.now },
    },
    { timestamps: true },
);

export default mongoose.model(
    'VehicleAccessFuelMonthlyLimitLog',
    vehicleAccessFuelMonthlyLimitLogSchema,
);
