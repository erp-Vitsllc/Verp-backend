import mongoose from 'mongoose';

const vehicleMechanicalServiceTypeSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },
        active: {
            type: Boolean,
            default: true,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
    },
    { timestamps: true },
);

vehicleMechanicalServiceTypeSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

export default mongoose.model('VehicleMechanicalServiceType', vehicleMechanicalServiceTypeSchema);
