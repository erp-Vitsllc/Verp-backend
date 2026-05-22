import mongoose from 'mongoose';

const adminDeletionArchiveSchema = new mongoose.Schema(
    {
        topModule: { type: String, required: true, index: true },
        category: { type: String, required: true, index: true },
        entityType: { type: String, required: true, index: true },
        moduleName: { type: String, default: '' },
        recordId: { type: String, default: '', index: true },
        title: { type: String, default: '' },
        subtitle: { type: String, default: '' },
        details: { type: String, default: '' },
        parentRef: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
        snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
        restoreDescriptor: { type: mongoose.Schema.Types.Mixed, required: true },
        status: {
            type: String,
            enum: ['pending', 'restored', 'purged'],
            default: 'pending',
            index: true,
        },
        deletedBy: {
            userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            name: { type: String, default: '' },
            employeeId: { type: String, default: '' },
        },
        deletedAt: { type: Date, default: Date.now, index: true },
        /** After this date, pending recovery is permanently purged (default: deletedAt + 60 days). */
        expiresAt: { type: Date, index: true },
        restoredBy: {
            userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            name: { type: String, default: '' },
        },
        restoredAt: { type: Date },
        purgedBy: {
            userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            name: { type: String, default: '' },
        },
        purgedAt: { type: Date },
        /** Cached count of uploaded files in snapshot (for recovery list UI). */
        attachmentCount: { type: Number, default: 0 },
        /** Copies of files kept under admin-deletion-archive/{id}/ for recovery viewing. */
        preservedAttachments: {
            type: [
                {
                    name: { type: String, default: '' },
                    label: { type: String, default: '' },
                    originalKey: { type: String, default: '' },
                    storageKey: { type: String, default: '' },
                    unavailable: { type: Boolean, default: false },
                    unavailableReason: { type: String, default: '' },
                },
            ],
            default: [],
        },
    },
    { timestamps: true }
);

adminDeletionArchiveSchema.index({ status: 1, topModule: 1, category: 1, deletedAt: -1 });
adminDeletionArchiveSchema.index({ status: 1, expiresAt: 1 });

export default mongoose.models.AdminDeletionArchive ||
    mongoose.model('AdminDeletionArchive', adminDeletionArchiveSchema);
