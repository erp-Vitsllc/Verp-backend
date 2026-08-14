import mongoose from 'mongoose';

const ATTENDANCE_STATUS_KEYS = [
    'work_from_home',
    'on_office',
    'on_leave',
    'sick_leave',
    'authorized_leave',
    'unauthorized_leave',
    'late_arrived',
    'early_go',
    'mispunch',
    'not_marked',
    'holiday',
    'weekly_off',
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
        /** HR review queue — pending marks show on Attendance bell + sidebar badge. */
        approvalStatus: {
            type: String,
            enum: ['', 'pending', 'approved', 'rejected'],
            default: '',
            trim: true,
            index: true,
        },
        /**
         * Employee leave change request (red day → Unauthorized / Authorized / Sick).
         * Status on the day stays unchanged until primary reportee approves.
         */
        leaveRequestStatus: {
            type: String,
            enum: ['', 'pending', 'approved', 'rejected'],
            default: '',
            trim: true,
            index: true,
        },
        requestedStatusKey: {
            type: String,
            default: '',
            trim: true,
        },
        requestedStatusLabel: {
            type: String,
            default: '',
            trim: true,
        },
        previousStatusKey: {
            type: String,
            default: '',
            trim: true,
        },
        previousStatusLabel: {
            type: String,
            default: '',
            trim: true,
        },
        leaveRequestReason: {
            type: String,
            default: '',
            trim: true,
        },
        /** 'leave' = red-day leave change; 'yellow' = late/early/mispunch → Present;
         *  future_* = planned request on an upcoming working day */
        leaveRequestKind: {
            type: String,
            enum: ['', 'leave', 'yellow', 'future_leave', 'future_late', 'future_early'],
            default: '',
            trim: true,
        },
        leaveRequestedAt: {
            type: Date,
            default: null,
        },
        leaveDecidedAt: {
            type: Date,
            default: null,
        },
        leaveDecidedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'EmployeeBasic',
            default: null,
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
