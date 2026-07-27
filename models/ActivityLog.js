import mongoose from 'mongoose';

const activityLogSchema = new mongoose.Schema(
    {
        module: {
            type: String,
            required: true,
            index: true,
            default: 'General',
        },
        action: {
            type: String,
            required: true,
            index: true,
            enum: [
                'create',
                'update',
                'delete',
                'approve',
                'reject',
                'restore',
                'assign',
                'unassign',
                'login',
                'view',
                'other',
            ],
            default: 'other',
        },
        entityType: {
            type: String,
            default: '',
            index: true,
        },
        entityId: {
            type: String,
            default: '',
            index: true,
        },
        /** Human-readable line, e.g. "created employee Adarsh Kumar" */
        summary: {
            type: String,
            required: true,
        },
        actor: {
            userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            name: { type: String, default: '' },
            employeeId: { type: String, default: '' },
        },
        /** Frontend path to open the related record */
        viewHref: {
            type: String,
            default: '',
        },
        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
        method: { type: String, default: '' },
        path: { type: String, default: '' },
        ip: { type: String, default: '' },
    },
    { timestamps: true }
);

activityLogSchema.index({ createdAt: -1 });
activityLogSchema.index({ module: 1, createdAt: -1 });
activityLogSchema.index({ 'actor.userId': 1, createdAt: -1 });
activityLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

export default mongoose.models.ActivityLog || mongoose.model('ActivityLog', activityLogSchema);
