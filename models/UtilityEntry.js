import mongoose from 'mongoose';

/**
 * Utility account / line under a utility type (Internet, Etisalat line, etc.).
 * Uses string `_id` so legacy localStorage ids and payment `entryId` refs stay stable.
 */
const utilityEntrySchema = new mongoose.Schema(
    {
        _id: { type: String },
        type: { type: String, required: true, trim: true },
        status: {
            type: String,
            enum: ['Active', 'Inactive'],
            default: 'Active',
        },
        values: { type: mongoose.Schema.Types.Mixed, default: {} },
        assignedTo: { type: String, default: '', trim: true },
        assignedToType: {
            type: String,
            enum: ['Employee', 'Company', ''],
            default: '',
        },
        assignedToId: { type: String, default: '', trim: true },
        assignedAt: { type: Date, default: null },
        pendingStatusChange: { type: mongoose.Schema.Types.Mixed, default: null },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
    },
    { timestamps: true },
);

utilityEntrySchema.index({ type: 1, status: 1 });
utilityEntrySchema.index({ assignedToId: 1, assignedToType: 1 });

export default mongoose.model('UtilityEntry', utilityEntrySchema);
