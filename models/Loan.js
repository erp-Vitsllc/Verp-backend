import mongoose from "mongoose";

const loanSchema = new mongoose.Schema({
    employeeId: {
        type: String,
        required: true,
        ref: 'EmployeeBasic' // Assuming referencing by custom ID, but technically usually ObjectId
    },
    employeeObjectId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EmployeeBasic',
        required: true
    },
    loanId: {
        type: String
        // Not making it required yet to avoid breaking existing records without migration
    },
    type: {
        type: String,
        enum: ['Loan', 'Advance'],
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    paidAmount: {
        type: Number,
        default: 0
    },
    duration: {
        type: Number,
        required: true // in months
    },
    monthStart: {
        type: String,
        required: false, // Optional for legacy records
        default: ''
    },
    /** Frozen at approval — used for Current Deduction Schedule / history */
    originalMonthStart: {
        type: String,
        default: ''
    },
    originalDuration: {
        type: Number,
        default: null
    },
    reason: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['Draft', 'Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization', 'Approved', 'Rejected', 'Cancelled', 'Paid'],
        default: 'Draft'
    },
    approvalStatus: {
        type: String,
        enum: ['Draft', 'Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization', 'Approved', 'Rejected', 'Cancelled', 'Paid'],
        default: 'Draft'
    },
    appliedDate: {
        type: Date,
        default: Date.now
    },
    approvedDate: {
        type: Date
    },
    approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EmployeeBasic'
    },
    // SNAPSHOT: Manager who received the request
    submittedTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    // Persistent Tracking for the 5-step workflow
    managerApprovedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EmployeeBasic'
    },
    hrApprovedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EmployeeBasic'
    },
    accountsApprovedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EmployeeBasic'
    },
    rejectedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EmployeeBasic'
    },
    rejectedDate: {
        type: Date
    },
    rejectionReason: {
        type: String
    },
    // NEW: Workflow Array for detailed tracking
    workflow: [{
        role: { type: String, required: true },
        assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
        assignedAt: { type: Date, default: Date.now },
        actionedAt: { type: Date },
        comment: { type: String }
    }],
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    attachment: {
        url: { type: String },
        publicId: { type: String },
        name: { type: String },
        mimeType: { type: String }
    },
    /** Management-approved acknowledgment PDF (email + Attachment tab). */
    approvalAttachments: [{
        label: { type: String, default: '' },
        name: { type: String, default: '' },
        url: { type: String, default: '' },
        publicId: { type: String, default: '' },
        mimeType: { type: String, default: 'application/pdf' },
        source: {
            type: String,
            enum: ['acknowledgment', 'supporting'],
            default: 'acknowledgment',
        },
        addedAt: { type: Date, default: Date.now },
    }],
    approvalAttachmentHistory: [{
        label: { type: String, default: '' },
        name: { type: String, default: '' },
        url: { type: String, default: '' },
        publicId: { type: String, default: '' },
        mimeType: { type: String, default: 'application/pdf' },
        source: { type: String, default: '' },
        addedAt: { type: Date, default: Date.now },
        trigger: {
            type: String,
            enum: ['management-approval', 'schedule-edit', 'accessory-edit', 'regenerated'],
            default: 'management-approval',
        },
    }],
}, { timestamps: true });

const Loan = mongoose.model("Loan", loanSchema);
export default Loan;
