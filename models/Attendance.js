import mongoose from 'mongoose';

const ATTENDANCE_STATUS_KEYS = [
    'work_from_home',
    'on_office',
    'on_leave',
    'sick_leave',
    'compoff_leave',
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
        /** Paid / unpaid only applies to authorized_leave. */
        leavePayType: {
            type: String,
            enum: ['', 'paid', 'unpaid'],
            default: '',
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
        /** app = mobile dashboard punch, web = website dashboard punch, manual = Mark Attendance modal */
        punchSource: {
            type: String,
            enum: ['', 'app', 'web', 'manual'],
            default: '',
            trim: true,
            index: true,
        },
        checkOutSource: {
            type: String,
            enum: ['', 'app', 'web', 'manual'],
            default: '',
            trim: true,
        },
        checkInLocation: {
            latitude: { type: Number, default: null },
            longitude: { type: Number, default: null },
            accuracy: { type: Number, default: null },
            label: { type: String, default: '', trim: true },
            source: { type: String, enum: ['', 'app', 'web', 'manual'], default: '', trim: true },
        },
        checkOutLocation: {
            latitude: { type: Number, default: null },
            longitude: { type: Number, default: null },
            accuracy: { type: Number, default: null },
            label: { type: String, default: '', trim: true },
            source: { type: String, enum: ['', 'app', 'web', 'manual'], default: '', trim: true },
        },
        /** This day's punches follow this employee. Later check-out is copied here for this date only. */
        punchMappedFromEmployeeMongoId: {
            type: String,
            default: '',
            trim: true,
            index: true,
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
            enum: ['', 'leave', 'yellow', 'future_leave', 'future_late', 'future_early', 'future_annual', 'past_late'],
            default: '',
            trim: true,
        },
        /** Full day, half day, or quarter day. AM/PM is leaveRequestSession. */
        leaveRequestDayPart: {
            type: String,
            enum: ['', 'full', 'half', 'quarter'],
            default: '',
            trim: true,
        },
        leaveRequestSession: {
            type: String,
            enum: ['', 'am', 'pm'],
            default: '',
            trim: true,
        },
        /** 1, 0.5, or 0.25 of a salary day. */
        leaveDayFraction: {
            type: Number,
            default: null,
        },
        /** 2 when an approved partial day is punched outside the allowed window. */
        leaveDeductionTimes: {
            type: Number,
            default: 1,
        },
        leaveRequestTimeIn: {
            type: String,
            default: '',
            trim: true,
        },
        leaveRequestTimeOut: {
            type: String,
            default: '',
            trim: true,
        },
        /** Range the employee asked for; every working day in it gets its own record. */
        leaveRequestFromDate: {
            type: String,
            default: '',
            trim: true,
        },
        leaveRequestToDate: {
            type: String,
            default: '',
            trim: true,
        },
        /** Shared by all days of one multi-day request so a decision applies to the whole range. */
        leaveRequestGroupId: {
            type: String,
            default: '',
            trim: true,
            index: true,
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
        annualLeaveNotEligible: {
            type: Boolean,
            default: false,
        },
        /** Flexible group only. Checkout calendar day when it is after the check-in date. */
        timeOutDate: {
            type: String,
            default: '',
            trim: true,
        },
        flexibleWorkedHours: { type: Number, default: 0 },
        flexibleRequiredHours: { type: Number, default: 0 },
        flexibleOtHours: { type: Number, default: 0 },
        flexibleOtStatus: {
            type: String,
            enum: ['', 'pending', 'approved', 'rejected'],
            default: '',
            trim: true,
        },
        flexibleOtApprovedHours: { type: Number, default: 0 },
        flexibleOtReason: { type: String, default: '', trim: true },
        flexibleOtNextDayDate: { type: String, default: '', trim: true },
        flexibleFromOtDate: { type: String, default: '', trim: true },
        /** Hour approval: unauth early go / late / mispunch / leave → approved hours only. */
        hourAdjustStatus: {
            type: String,
            enum: ['', 'pending', 'approved', 'rejected'],
            default: '',
            trim: true,
        },
        hourAdjustKind: { type: String, default: '', trim: true },
        hoursTaken: { type: Number, default: 0 },
        hoursMax: { type: Number, default: 0 },
        hoursApproved: { type: Number, default: 0 },
        hourAdjustReason: { type: String, default: '', trim: true },
        markedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
        /**
         * Comp-off settlement. Empty state means the leave day is still open
         * in the month of `date`. One jump moves chargeMonth forward once.
         */
        compOff: {
            state: {
                type: String,
                enum: ['', 'open', 'adjusted', 'jumped'],
                default: '',
            },
            chargeMonth: { type: String, default: '', trim: true },
            jumpCount: { type: Number, default: 0 },
            otHoursBefore: { type: Number, default: 0 },
            otHoursDeducted: { type: Number, default: 0 },
            otHoursAfter: { type: Number, default: 0 },
            adjustedAt: { type: Date, default: null },
        },
    },
    { timestamps: true },
);

attendanceSchema.index({ date: 1, employeeMongoId: 1 }, { unique: true });

export { ATTENDANCE_STATUS_KEYS };
export default mongoose.model('Attendance', attendanceSchema);
