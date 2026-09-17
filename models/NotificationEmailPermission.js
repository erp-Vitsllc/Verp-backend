import mongoose from 'mongoose';

const notificationEmailPermissionSchema = new mongoose.Schema(
    {
        eventKey: { type: String, required: true, unique: true, trim: true },
        notification: { type: Boolean, default: true },
        email: { type: Boolean, default: true },
        whatsapp: { type: Boolean, default: true },
        updatedByName: { type: String, default: '' },
        updatedByUserId: { type: String, default: '' },
    },
    { timestamps: true },
);

export default mongoose.model(
    'NotificationEmailPermission',
    notificationEmailPermissionSchema,
);
