import mongoose from 'mongoose';

/** One Access Fuel monthly-limit create per month. */
const vehicleAccessFuelMonthlyLimitLogSchema = new mongoose.Schema(
    {
        monthKey: { type: String, required: true, trim: true, unique: true },
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
