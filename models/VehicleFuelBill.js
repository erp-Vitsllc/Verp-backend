import mongoose from 'mongoose';

const fuelAttachmentSchema = new mongoose.Schema(
    {
        name: { type: String, default: '' },
        mimeType: { type: String, default: '' },
        data: { type: String, default: '' },
    },
    { _id: false },
);

const fuelEntrySchema = new mongoose.Schema(
    {
        amount: { type: Number, required: true, min: 0 },
        attachment: { type: fuelAttachmentSchema, default: null },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        createdAt: { type: Date, default: Date.now },
    },
    { _id: true },
);

const vehicleFuelBillSchema = new mongoose.Schema(
    {
        vehicleId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AssetItem',
            required: true,
            index: true,
        },
        monthKey: { type: String, required: true, trim: true },
        status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
        amountUsed: { type: Number, default: 0 },
        monthlyLimit: { type: Number, default: 0 },
        limitAlert80SentAt: { type: Date, default: null },
        limitAlert100SentAt: { type: Date, default: null },
        kmRun: { type: Number, default: 0 },
        idleTimeMinutes: { type: Number, default: 0 },
        entries: { type: [fuelEntrySchema], default: [] },
        closedAt: { type: Date, default: null },
        closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { timestamps: true },
);

vehicleFuelBillSchema.index({ vehicleId: 1, monthKey: 1 }, { unique: true });

export default mongoose.model('VehicleFuelBill', vehicleFuelBillSchema);
