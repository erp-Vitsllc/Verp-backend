import mongoose from 'mongoose';

/**
 * Admin-managed work location categories (Attendance / Leave grouping).
 * Default rows: Office and Site. Super user can add more (Warehouse, etc.).
 */
const workLocationSchema = new mongoose.Schema(
    {
        key: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            lowercase: true,
        },
        label: {
            type: String,
            required: true,
            trim: true,
        },
        status: {
            type: String,
            enum: ['Active', 'Inactive'],
            default: 'Active',
        },
        isSystem: {
            type: Boolean,
            default: false,
        },
        sortOrder: {
            type: Number,
            default: 100,
        },
    },
    { timestamps: true },
);

workLocationSchema.index({ status: 1, sortOrder: 1, label: 1 });

export default mongoose.model('WorkLocation', workLocationSchema);
