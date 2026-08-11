import mongoose from 'mongoose';

const ATTENDANCE_STATUS_KEYS = [
    'work_from_home',
    'on_office',
    'on_leave',
    'sick_leave',
    'unauthorized_leave',
    'late_arrived',
    'not_marked',
];

/**
 * One attendance mark per employee per calendar day (yyyy-MM-dd).
 */
const attendanceSchema = new mongoose.Schema(
    {
        date: {
            type: String,
            required: true,
            index: true,
            trim: true,
            match: /^\d{4}-\d{2}-\d{2}$/,
        },
        employeeMongoId: {
            type: String,
            required: true,
            index: true,
            trim: true,
        },
        employeeId: {
            type: String,
            default: '',
            trim: true,
        },
        employeeName: {
            type: String,
            default: '',
            trim: true,
        },
        statusKey: {
            type: String,
            required: true,
            enum: ATTENDANCE_STATUS_KEYS,
        },
        statusLabel: {
            type: String,
            required: true,
            trim: true,
        },
        timeIn: {
            type: String,
            default: '',
            trim: true,
        },
        timeOut: {
            type: String,
            default: '',
            trim: true,
        },
        reason: {
            type: String,
            default: '',
            trim: true,
        },
        attachmentName: {
            type: String,
            default: '',
            trim: true,
        },
        markedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
    },
    { timestamps: true },
);

attendanceSchema.index({ date: 1, employeeMongoId: 1 }, { unique: true });

export { ATTENDANCE_STATUS_KEYS };
export default mongoose.model('Attendance', attendanceSchema);
