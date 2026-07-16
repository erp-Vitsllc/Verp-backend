import mongoose from 'mongoose';

/**
 * Activate / deactivate a utility entry — requires HR approval.
 * Entry records live in the browser; this store drives email + dashboard task + final status sync.
 */
const attachmentSchema = new mongoose.Schema(
    {
        name: { type: String, default: '' },
        mime: { type: String, default: '' },
        dataUrl: { type: String, default: '' },
    },
    { _id: false },
);

const utilityEntryStatusChangeSchema = new mongoose.Schema(
    {
        entryId: { type: String, required: true, trim: true, index: true },
        utilityType: { type: String, default: '', trim: true },
        accountNo: { type: String, default: '', trim: true },
        provider: { type: String, default: '', trim: true },
        currentStatus: {
            type: String,
            enum: ['Active', 'Inactive'],
            required: true,
        },
        requestedStatus: {
            type: String,
            enum: ['Active', 'Inactive'],
            required: true,
        },
        reason: { type: String, required: true, trim: true },
        attachment: { type: attachmentSchema, default: () => ({}) },
        status: {
            type: String,
            enum: ['Pending', 'Approved', 'Rejected'],
            default: 'Pending',
            index: true,
        },
        requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic', default: null },
        requestedByName: { type: String, default: '' },
        pendingWith: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic', default: null },
        pendingWithName: { type: String, default: '' },
        actionedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic', default: null },
        actionedByName: { type: String, default: '' },
        actionedAt: { type: Date, default: null },
        hrComment: { type: String, default: '' },
    },
    { timestamps: true },
);

utilityEntryStatusChangeSchema.index({ entryId: 1, status: 1, createdAt: -1 });

export default mongoose.model('UtilityEntryStatusChange', utilityEntryStatusChangeSchema);
