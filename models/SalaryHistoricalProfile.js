import mongoose from 'mongoose';

const attachmentSchema = new mongoose.Schema(
    {
        name: { type: String, default: '' },
        mimeType: { type: String, default: '' },
        publicId: { type: String, default: '' },
        url: { type: String, default: '' },
    },
    { _id: false },
);

const leaveRecordSchema = new mongoose.Schema(
    {
        leaveType: { type: String, default: 'sick' },
        fromDate: { type: String, default: '' },
        toDate: { type: String, default: '' },
        calendarDays: { type: Number, default: 0 },
        actualDays: { type: Number, default: 0 },
        eligibleWorkingDays: { type: Number, default: 0 },
        multiplier: { type: Number, default: 1 },
        rule: { type: Number, default: 1 },
        deductionDays: { type: Number, default: 0 },
        deduction: { type: Number, default: 0 },
        source: { type: String, default: 'manual' },
        status: { type: String, default: 'draft' },
        remarks: { type: String, default: '' },
        attachment: { type: attachmentSchema, default: null },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        createdByName: { type: String, default: '' },
        verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        verifiedByName: { type: String, default: '' },
        verifiedAt: { type: Date, default: null },
    },
    { _id: true },
);

const annualLeaveSchema = new mongoose.Schema(
    {
        startDate: { type: String, default: '' },
        endDate: { type: String, default: '' },
        returnToWorkDate: { type: String, default: '' },
        calendarDays: { type: Number, default: 0 },
        eligibleWorkingDays: { type: Number, default: 0 },
        status: { type: String, default: 'draft' },
        source: { type: String, default: 'manual' },
        remarks: { type: String, default: '' },
        attachment: { type: attachmentSchema, default: null },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        createdByName: { type: String, default: '' },
        verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        verifiedByName: { type: String, default: '' },
        verifiedAt: { type: Date, default: null },
    },
    { _id: true },
);

const paymentCycleSchema = new mongoose.Schema(
    {
        cycleNumber: { type: Number, default: 1 },
        eligibilityStartDate: { type: String, default: '' },
        eligibilityEndDate: { type: String, default: '' },
        entitlementDays: { type: Number, default: 300 },
        qualifyingDays: { type: Number, default: 0 },
        leaveSalaryPaymentDate: { type: String, default: '' },
        leaveSalaryAmount: { type: Number, default: 0 },
        ticketPaymentDate: { type: String, default: '' },
        ticketAmount: { type: Number, default: 0 },
        paymentDate: { type: String, default: '' },
        leaveSalary: { type: Number, default: 0 },
        currency: { type: String, default: 'AED' },
        paymentReference: { type: String, default: '' },
        paymentStatus: { type: String, default: 'draft' },
        verificationStatus: { type: String, default: 'pending' },
        status: { type: String, default: 'draft' },
        remarks: { type: String, default: '' },
        annualLeaveKey: { type: String, default: '' },
        attachment: { type: attachmentSchema, default: null },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        createdByName: { type: String, default: '' },
        verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        verifiedByName: { type: String, default: '' },
        verifiedAt: { type: Date, default: null },
    },
    { _id: true },
);

const auditEntrySchema = new mongoose.Schema(
    {
        action: { type: String, default: '' },
        recordType: { type: String, default: '' },
        previousValue: { type: mongoose.Schema.Types.Mixed, default: null },
        newValue: { type: mongoose.Schema.Types.Mixed, default: null },
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        changedByName: { type: String, default: '' },
        at: { type: Date, default: Date.now },
        reason: { type: String, default: '' },
        verificationStatus: { type: String, default: '' },
    },
    { _id: true },
);

const salaryHistoricalProfileSchema = new mongoose.Schema(
    {
        employeeId: { type: String, required: true, trim: true, unique: true },
        status: { type: String, enum: ['draft', 'created'], default: 'draft' },
        workflowStatus: {
            type: String,
            enum: ['draft', 'correction', 'verified', 'pending_hr', 'locked', 'reopened'],
            default: 'draft',
        },
        contractJoiningDate: { type: String, default: '' },
        originalContractJoiningDate: { type: String, default: '' },
        verpStartDate: { type: String, default: '' },
        companyMolCode: { type: String, default: '' },
        employeeMolId: { type: String, default: '' },
        leaveRecords: { type: [leaveRecordSchema], default: () => [] },
        annualLeaveRecords: { type: [annualLeaveSchema], default: () => [] },
        paymentCycles: { type: [paymentCycleSchema], default: () => [] },
        cycleDays: { type: Number, default: 300 },
        leaveHistoryComplete: { type: Boolean, default: false },
        annualLeaveComplete: { type: Boolean, default: false },
        benefitsComplete: { type: Boolean, default: false },
        auditLog: { type: [auditEntrySchema], default: () => [] },
        verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        verifiedByName: { type: String, default: '' },
        verifiedByDepartment: { type: String, default: '' },
        verifiedAt: { type: Date, default: null },
        lockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        lockedByName: { type: String, default: '' },
        lockedAt: { type: Date, default: null },
        reopenedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        reopenedByName: { type: String, default: '' },
        reopenedAt: { type: Date, default: null },
        reopenReason: { type: String, default: '' },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        createdProfileAt: { type: Date, default: null },
        submittedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic', default: null },
        submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        submittedByName: { type: String, default: '' },
        submittedByEmail: { type: String, default: '' },
        submittedAt: { type: Date, default: null },
        lastRejectReason: { type: String, default: '' },
    },
    { timestamps: true },
);

salaryHistoricalProfileSchema.index({ employeeId: 1 }, { unique: true });
salaryHistoricalProfileSchema.index({ employeeId: 1, verpStartDate: 1 });

export default mongoose.model('SalaryHistoricalProfile', salaryHistoricalProfileSchema);
