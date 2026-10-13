import mongoose from 'mongoose';

/**
 * A manual attendance edit that is not live yet.
 * Primary reportee approves first, then flowchart HR applies it.
 */
const attendanceChangeRequestSchema = new mongoose.Schema(
    {
        date: {
            type: String,
            required: true,
            trim: true,
            index: true,
        },
        employeeMongoId: {
            type: String,
            required: true,
            trim: true,
            index: true,
        },
        employeeId: { type: String, default: '', trim: true },
        employeeName: { type: String, default: '', trim: true },
        stage: {
            type: String,
            enum: ['pending_reportee', 'pending_hr', 'approved', 'rejected', 'superseded'],
            default: 'pending_reportee',
            index: true,
        },
        /**
         * mark = status/time edit.
         * map = copy another employee's punches for this day.
         * flexible_ot = apply overtime, or mark a chosen day present from that overtime.
         * hour_adjust = hour approval.
         * clear = clear the day back to its baseline.
         */
        action: {
            type: String,
            enum: ['mark', 'map', 'flexible_ot', 'hour_adjust', 'clear'],
            default: 'mark',
        },
        proposed: {
            statusKey: { type: String, default: '', trim: true },
            statusLabel: { type: String, default: '', trim: true },
            leavePayType: { type: String, default: '', trim: true },
            timeIn: { type: String, default: '', trim: true },
            timeOut: { type: String, default: '', trim: true },
            reason: { type: String, default: '', trim: true },
            attachmentName: { type: String, default: '', trim: true },
            punchSource: { type: String, default: '', trim: true },
            checkOutSource: { type: String, default: '', trim: true },
            punchMappedFromEmployeeMongoId: { type: String, default: '', trim: true },
            checkInLocation: {
                latitude: { type: Number, default: null },
                longitude: { type: Number, default: null },
                accuracy: { type: Number, default: null },
                label: { type: String, default: '', trim: true },
                source: { type: String, default: '', trim: true },
            },
            checkOutLocation: {
                latitude: { type: Number, default: null },
                longitude: { type: Number, default: null },
                accuracy: { type: Number, default: null },
                label: { type: String, default: '', trim: true },
                source: { type: String, default: '', trim: true },
            },
            attendanceId: { type: String, default: '', trim: true },
            flexibleOtApprovedHours: { type: Number, default: 0 },
            confirmNextDay: { type: Boolean, default: false },
            targetDate: { type: String, default: '', trim: true },
            hourAdjustKind: { type: String, default: '', trim: true },
            hoursTaken: { type: Number, default: 0 },
            hoursMax: { type: Number, default: 0 },
            hoursApproved: { type: Number, default: 0 },
        },
        previous: {
            statusKey: { type: String, default: '', trim: true },
            statusLabel: { type: String, default: '', trim: true },
            timeIn: { type: String, default: '', trim: true },
            timeOut: { type: String, default: '', trim: true },
            reason: { type: String, default: '', trim: true },
        },
        requestedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'EmployeeBasic',
            default: null,
        },
        requestedByName: { type: String, default: '', trim: true },
        reporteeId: { type: String, default: '', trim: true, index: true },
        hrId: { type: String, default: '', trim: true },
        decidedByReportee: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'EmployeeBasic',
            default: null,
        },
        decidedAtReportee: { type: Date, default: null },
        decidedByHr: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'EmployeeBasic',
            default: null,
        },
        decidedAtHr: { type: Date, default: null },
    },
    { timestamps: true },
);

attendanceChangeRequestSchema.index({ date: 1, employeeMongoId: 1, stage: 1 });

export default mongoose.model('AttendanceChangeRequest', attendanceChangeRequestSchema);
