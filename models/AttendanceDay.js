import mongoose from 'mongoose';

/**
 * Daily attendance cycle (Asia/Dubai midnight).
 * Previous day stays stored in Attendance collection; new day opens empty for marking.
 */
const attendanceDaySchema = new mongoose.Schema(
    {
        date: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            match: /^\d{4}-\d{2}-\d{2}$/,
            index: true,
        },
        status: {
            type: String,
            enum: ['open', 'closed'],
            default: 'open',
            index: true,
        },
        openedAt: {
            type: Date,
            default: null,
        },
        closedAt: {
            type: Date,
            default: null,
        },
        markedCount: {
            type: Number,
            default: 0,
        },
        note: {
            type: String,
            default: '',
        },
    },
    { timestamps: true },
);

export default mongoose.model('AttendanceDay', attendanceDaySchema);
