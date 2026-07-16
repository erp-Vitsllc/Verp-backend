import mongoose from 'mongoose';

/**
 * Created utility tab: type name + Yes/No field toggles.
 * One active config per type name.
 */
const utilityConfigSchema = new mongoose.Schema(
    {
        type: { type: String, required: true, trim: true },
        status: {
            type: String,
            enum: ['Active', 'Inactive'],
            default: 'Active',
        },
        fields: { type: mongoose.Schema.Types.Mixed, default: {} },
        attachment: { type: mongoose.Schema.Types.Mixed, default: null },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
    },
    { timestamps: true },
);

utilityConfigSchema.index(
    { type: 1 },
    { unique: true, collation: { locale: 'en', strength: 2 } },
);

export default mongoose.model('UtilityConfig', utilityConfigSchema);
