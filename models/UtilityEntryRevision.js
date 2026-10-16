import mongoose from 'mongoose';

/**
 * SIM / utility record as it stood from a bill month onward.
 * Months before the current open bill month keep the revision that was in
 * effect then. A later edit writes a new row for the open month only.
 */
const utilityEntryRevisionSchema = new mongoose.Schema(
    {
        entryId: { type: String, required: true, trim: true },
        /** YYYY-MM inclusive, or 0000-01 for the state before the first tracked edit. */
        fromMonth: { type: String, required: true, trim: true },
        values: { type: mongoose.Schema.Types.Mixed, default: {} },
        assignedTo: { type: String, default: '', trim: true },
        assignedToType: {
            type: String,
            enum: ['Employee', 'Company', ''],
            default: '',
        },
        assignedToId: { type: String, default: '', trim: true },
    },
    { timestamps: true },
);

utilityEntryRevisionSchema.index({ entryId: 1, fromMonth: 1 }, { unique: true });

export default mongoose.model('UtilityEntryRevision', utilityEntryRevisionSchema);
