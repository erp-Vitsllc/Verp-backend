import mongoose from 'mongoose';

const dmfPersonSchema = new mongoose.Schema(
    {
        employeeObjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic', default: null },
        employeeId: { type: String, default: '' },
        name: { type: String, default: '' },
        companyEmail: { type: String, default: '' },
    },
    { _id: false },
);

export const salaryDmfStepSchema = new mongoose.Schema(
    {
        key: { type: String, required: true },
        label: { type: String, default: '' },
        role: { type: String, default: '' },
        status: {
            type: String,
            enum: ['scheduled', 'pending', 'approved', 'rejected'],
            default: 'scheduled',
        },
        assignedTo: { type: dmfPersonSchema, default: () => ({}) },
        actionedByName: { type: String, default: '' },
        actionedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        actionedAt: { type: Date, default: null },
        comment: { type: String, default: '' },
    },
    { _id: false },
);

export const salaryDmfApprovalSchema = new mongoose.Schema(
    {
        status: {
            type: String,
            enum: ['idle', 'pending', 'approved', 'rejected'],
            default: 'idle',
        },
        currentStepKey: { type: String, default: '' },
        submittedByName: { type: String, default: '' },
        submittedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        submittedAt: { type: Date, default: null },
        rejectedByName: { type: String, default: '' },
        rejectedAt: { type: Date, default: null },
        rejectReason: { type: String, default: '' },
        amount: { type: Number, default: 0 },
        currency: { type: String, default: 'AED' },
        billLabel: { type: String, default: '' },
        steps: { type: [salaryDmfStepSchema], default: () => [] },
        zohoBillId: { type: String, default: '' },
        zohoBillNumber: { type: String, default: '' },
        zohoBillStatus: { type: String, default: '' },
        zohoOrganizationId: { type: String, default: '' },
        zohoSyncedAt: { type: Date, default: null },
        zohoSyncError: { type: String, default: '' },
        zohoSkipped: { type: Boolean, default: false },
    },
    { _id: false },
);
