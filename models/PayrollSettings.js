import mongoose from 'mongoose';

const processingRulesSchema = new mongoose.Schema(
    {
        allAttendanceMarked: { type: Boolean, default: false },
        allPendingApprovalsCompleted: { type: Boolean, default: false },
        overtimeApprovedByHr: { type: Boolean, default: false },
        overtimeApprovedByHod: { type: Boolean, default: false },
        allSickLeaveApproval: { type: Boolean, default: false },
        allAuthorizedLeaves: { type: Boolean, default: false },
        allUnauthorizedLeave: { type: Boolean, default: false },
        pendingAttendanceApproval: { type: Boolean, default: false },
        pendingOtApproval: { type: Boolean, default: false },
        pendingAuthorizedLeaveApproval: { type: Boolean, default: false },
        pendingUnauthorizedLeaveApproval: { type: Boolean, default: false },
        pendingSickLeaveApproval: { type: Boolean, default: false },
        pendingLateEarlyCompoffAdjustment: { type: Boolean, default: false },
        fine: { type: Boolean, default: false },
        reward: { type: Boolean, default: false },
        ncr: { type: Boolean, default: false },
        loan: { type: Boolean, default: false },
        advance: { type: Boolean, default: false },
        utilityBillExcess: { type: Boolean, default: false },
        salaryProcessReminderToAccounts: { type: Boolean, default: false },
        otherDeptHodsPendingApproval: { type: Boolean, default: false },
        utilityBill: { type: Boolean, default: false },
        salikExcess: { type: Boolean, default: false },
        sandwichLeave: { type: Boolean, default: false },
        gratuityCalculationRequired: { type: Boolean, default: false },
    },
    { _id: false },
);

const lateDeductRuleSchema = new mongoose.Schema(
    {
        minutes: { type: Number, default: null },
        events: { type: Number, default: null },
        deduct: { type: String, default: '' },
    },
    { _id: false },
);

const salaryProcessReminderSchema = new mongoose.Schema(
    {
        daysBefore: { type: Number, default: null },
        forWhom: { type: String, default: '' },
    },
    { _id: false },
);

const payrollSettingsSchema = new mongoose.Schema(
    {
        key: { type: String, default: 'default', unique: true },
        salaryProcessingDate: { type: String, default: '' },
        salaryProcessStartMonth: { type: String, default: '' },
        salaryCutoffDate: { type: String, default: '' },
        processingRules: { type: processingRulesSchema, default: () => ({}) },
        workingDaysRequiredToEligible: { type: Number, default: null },
        leaveSalaryWorkingDays: { type: Number, default: 300 },
        workingDaysRequiredForAirTicket: { type: Number, default: null },
        authorizedLeaveDeductionDays: { type: Number, default: null },
        unauthorizedLeaveDeductionDays: { type: Number, default: null },
        lateInRules: { type: [lateDeductRuleSchema], default: () => [] },
        lateOutRules: { type: [lateDeductRuleSchema], default: () => [] },
        salaryProcessReminders: { type: [salaryProcessReminderSchema], default: () => [] },
        hiddenSalaryMonths: { type: [String], default: () => [] },
        attachment: {
            name: { type: String, default: '' },
            mimeType: { type: String, default: '' },
            publicId: { type: String, default: '' },
            url: { type: String, default: '' },
        },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { timestamps: true },
);

export default mongoose.model('PayrollSettings', payrollSettingsSchema);
