import mongoose from 'mongoose';

/**
 * Assignment timeline for a utility entry (assign / reassign / return).
 */
const utilityEntryAssignmentHistorySchema = new mongoose.Schema(
    {
        entryId: { type: String, required: true, trim: true, index: true },
        utilityType: { type: String, default: '', trim: true },
        action: {
            type: String,
            enum: ['assign', 'reassign', 'return'],
            required: true,
            index: true,
        },
        fromAssignedTo: { type: String, default: '', trim: true },
        fromAssignedToType: {
            type: String,
            enum: ['Employee', 'Company', ''],
            default: '',
        },
        fromAssignedToId: { type: String, default: '', trim: true },
        toAssignedTo: { type: String, default: '', trim: true },
        toAssignedToType: {
            type: String,
            enum: ['Employee', 'Company', ''],
            default: '',
        },
        toAssignedToId: { type: String, default: '', trim: true },
        performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        performedByName: { type: String, default: '', trim: true },
        note: { type: String, default: '', trim: true },
        occurredAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: true },
);

utilityEntryAssignmentHistorySchema.index({ entryId: 1, occurredAt: -1 });

export default mongoose.model(
    'UtilityEntryAssignmentHistory',
    utilityEntryAssignmentHistorySchema,
);
