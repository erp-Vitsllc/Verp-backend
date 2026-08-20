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
        fine: { type: Boolean, default: false },
        reward: { type: Boolean, default: false },
        ncr: { type: Boolean, default: false },
        loan: { type: Boolean, default: false },
        advance: { type: Boolean, default: false },
        utilityBillExcess: { type: Boolean, default: false },
        salaryProcessReminderToAccounts: { type: Boolean, default: false },
        otherDeptHodsPendingApproval: { type: Boolean, default: false },
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
        leaveSalaryWorkingDays: { type: Number, default: null },
        workingDaysRequiredForAirTicket: { type: Number, default: null },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { timestamps: true },
);

export default mongoose.model('PayrollSettings', payrollSettingsSchema);
