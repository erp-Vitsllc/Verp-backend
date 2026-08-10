import mongoose from "mongoose";

/**
 * Reward Schema
 * Tracks employee rewards with auto-generated reward IDs
 */
const rewardSchema = new mongoose.Schema(
    {
        rewardId: {
            type: String,
            required: true,
            unique: true,
            index: true
        },
        employeeId: {
            type: String,
            required: true,
            ref: "EmployeeBasic"
        },
        employeeName: {
            type: String,
            required: true
        },
        rewardType: {
            type: String,
            required: true,
            enum: ['Cash Reward', 'Gift Reward', 'Certificate', 'Performance Bonus', 'Employee of the Month', 'Long Service Award', 'Project Completion', 'Attendance Bonus', 'Other'],
            default: 'Other'
        },
        rewardStatus: {
            type: String,
            required: true,
            enum: [
                'Draft',
                'Pending',
                'Pending HR',
                'Pending Accounts',
                'Pending Authorization',
                'Approved', // Cash/Gift: approved, awaiting payment (Not Paid). Certificate: final.
                'Approved (Paid)',
                'Rejected',
                'Cancelled',
            ],
            default: 'Draft'
        },
        approvalStatus: {
            type: String,
            enum: [
                'Draft',
                'Pending',
                'Pending HR',
                'Pending Accounts',
                'Pending Authorization',
                'Approved',
                'Approved (Paid)',
                'Rejected',
                'Cancelled',
            ],
            default: 'Draft'
        },
        amount: {
            type: Number,
            default: null
        },
        paidAmount: {
            type: Number,
            default: 0
        },
        /** Cash/Gift: Pending after management approval; Billed after Accounts Zoho Expense. Certificate: N/A. */
        paymentStatus: {
            type: String,
            enum: ['N/A', 'Pending', 'Billed', 'Not Paid', 'Paid'],
            default: 'N/A',
        },
        description: {
            type: String,
            default: ''
        },
        awardedDate: {
            type: Date,
            default: Date.now
        },
        approvedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null
        },
        // SNAPSHOT: User who received the request
        submittedTo: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null
        },
        approvedDate: {
            type: Date,
            default: null
        },
        remarks: {
            type: String,
            default: ''
        },
        title: {
            type: String,
            required: true
        },
        certHeader: {
            type: String,
            default: 'Certificate'
        },
        certSubHeader: {
            type: String,
            default: 'Of Appreciation'
        },
        certPresentationText: {
            type: String,
            default: 'This certificate is presented to'
        },
        certSigner1Name: {
            type: String,
            default: 'Nivil Ali'
        },
        certSigner1Title: {
            type: String,
            default: 'Managing Director'
        },
        certSigner2Name: {
            type: String,
            default: 'Raseel Muhammad'
        },
        certSigner2Title: {
            type: String,
            default: 'CEO'
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null
        },
        hrApprovedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null
        },
        accountsApprovedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null
        },
        attachment: {
            url: { type: String },
            publicId: { type: String },
            name: { type: String },
            mimeType: { type: String }
        },
        /** Generated certificate PDF saved on final approval */
        certificateAttachment: {
            url: { type: String },
            publicId: { type: String },
            name: { type: String },
            mimeType: { type: String }
        },
        // NEW: Workflow Array for detailed tracking
        workflow: [{
            role: { type: String, required: true },
            assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            status: { type: String, enum: ['Draft', 'Pending', 'Approved', 'Rejected', 'Cancelled'], default: 'Pending' },
            assignedAt: { type: Date, default: Date.now },
            actionedAt: { type: Date },
            comment: { type: String }
        }],
        /** Zoho Books posting (Cash/Gift: Expense on Accounts approve; journal legacy on pay) */
        zohoOrganizationId: { type: String, default: '' },
        paidThroughAccountId: { type: String, default: '' },
        paidThroughAccountName: { type: String, default: '' },
        expenseAccountId: { type: String, default: '' },
        expenseAccountName: { type: String, default: '' },
        zohoExpenseId: { type: String, default: '' },
        zohoExpenseNumber: { type: String, default: '' },
        zohoJournalId: { type: String, default: '' },
        zohoSyncedAt: { type: Date, default: null },
        zohoSyncError: { type: String, default: '' },
    },
    { timestamps: true }
);

// Index for faster queries
rewardSchema.index({ employeeId: 1 });
rewardSchema.index({ rewardStatus: 1 });
rewardSchema.index({ rewardType: 1 });
rewardSchema.index({ createdAt: -1 });

export default mongoose.model("Reward", rewardSchema);

