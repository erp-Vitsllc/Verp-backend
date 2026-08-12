import mongoose from 'mongoose';

/**
 * Company / UAE public holidays used by attendance calendars and dashboard.
 */
const holidaySchema = new mongoose.Schema(
    {
        date: {
            type: String,
            required: true,
            trim: true,
            match: /^\d{4}-\d{2}-\d{2}$/,
            index: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
        },
        year: {
            type: Number,
            required: true,
            index: true,
        },
        addedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
        note: {
            type: String,
            default: '',
            trim: true,
        },
    },
    { timestamps: true },
);

holidaySchema.index({ date: 1 }, { unique: true });

export default mongoose.model('Holiday', holidaySchema);
