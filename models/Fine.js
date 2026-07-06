import mongoose from "mongoose";

/**
 * Fine Schema
 * Tracks employee fines with auto-generated fine IDs
 */
const fineSchema = new mongoose.Schema(
    {
        fineId: {
            type: String,
            required: true,
            index: true
        },
        category: {
            type: String,
            required: true,
            enum: ['Violation', 'Damage', 'Other'],
            default: 'Other'
        },
        subCategory: {
            type: String,
            default: ''
        },
        fineType: {
            type: String,
            default: 'Other'
        },
        vehicleId: {
            type: String,
            default: null
        },
        assetId: {
            type: String,
            default: null
        },
        assetName: {
            type: String,
            default: ''
        },
        assetObjectId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AssetItem',
            default: null
        },
        accessoryId: {
            type: String,
            default: null
        },
        accessoryName: {
            type: String,
            default: ''
        },
        projectId: {
            type: String,
            default: null
        },
        projectName: {
            type: String,
            default: ''
        },
        engineerName: {
            type: String,
            default: ''
        },
        assignedEmployees: [{
            employeeId: {
                type: String,
                required: true
            },
            employeeName: {
                type: String,
                required: true
            },
            daysWorked: {
                type: Number,
                required: false, // Changed from true to support Safety/Other fines
                min: 0 // Allow 0 if not applicable
            },
            approvalStatus: {
                type: String,
                enum: ['Pending', 'Pending Authorization', 'Approved', 'Rejected'],
                default: 'Pending'
            },
            approvedBy: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'User',
                default: null
            },
            approvedAt: {
                type: Date,
                default: null
            },
            individualAmount: {
                type: Number,
                default: 0
            }
        }],
        responsibleFor: {
            type: String,
            enum: ['Employee', 'Company', 'Employee & Company', null],
            default: null
        },
        employeeAmount: {
            type: Number,
            default: 0
        },
        companyAmount: {
            type: Number,
            default: 0
        },
        company: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Company',
            index: true,
            default: null
        },
        companyName: {
            type: String,
            default: ''
        },
        payableDuration: {
            type: Number,
            min: 1,
            max: 6,
            default: null
        },
        monthStart: {
            type: String,
            default: ''
        },
        /** Frozen at approval — used for Current Deduction Schedule on Fine Form */
        originalMonthStart: {
            type: String,
            default: ''
        },
        originalPayableDuration: {
            type: Number,
            min: 1,
            max: 6,
            default: null
        },
        fineStatus: {
            type: String,
            required: true,
            enum: ['Draft', 'Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization', 'Approved', 'Active', 'Completed', 'Paid', 'Cancelled', 'Rejected'],
            default: 'Draft'
        },
        fineAmount: {
            type: Number,
            required: true
        },
        totalFineAmount: {
            type: Number,
            default: 0
        },
        serviceCharge: {
            type: Number,
            default: 0
        },
        sourceOfIncome: {
            type: String,
            enum: ['Salary', 'End of Service', null],
            default: 'Salary',
        },
        assetDepreciationAmount: {
            type: Number,
            default: 0,
        },
        assetPurchaseDate: {
            type: String,
            default: '',
        },
        paidAmount: {
            type: Number,
            default: 0
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
        attachment: {
            url: { type: String },
            publicId: { type: String },
            data: { type: String },
            name: { type: String },
            mimeType: { type: String }
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },
        managerApprovedBy: {
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
        rejectedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null
        },
        rejectedDate: {
            type: Date,
            default: null
        },
        rejectionReason: {
            type: String,
            default: ''
        },
        // NEW: Workflow Array for detailed tracking
        workflow: [{
            role: { type: String, required: true }, // e.g., 'Manager', 'HR', 'Accounts'
            assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
            assignedAt: { type: Date, default: Date.now },
            actionedAt: { type: Date },
            comment: { type: String }
        }],
        excludedAccessoryIds: {
            type: [String],
            default: []
        },
        /** When accessories were last excluded — used for workflow timeline ordering (not fine.updatedAt). */
        accessoryExcludedAt: {
            type: Date,
            default: null,
        },
        /** Links a vehicle handover fine to a specific accessory or body-condition item. */
        handoverApprovalContext: {
            historyId: { type: String, default: null },
            vehicleId: { type: String, default: null },
            itemType: { type: String, enum: ['accessory', 'body', null], default: null },
            itemKey: { type: String, default: null },
            itemLabel: { type: String, default: '' },
        },
        handoverHrApproval: {
            type: Boolean,
            default: false,
        },
        breakdownItems: [{
            kind: { type: String, enum: ['main', 'accessory'] },
            assetId: { type: String },
            accessoryObjectId: { type: mongoose.Schema.Types.ObjectId },
            accessoryId: { type: String },
            name: { type: String },
            amount: { type: Number }
        }],
        /** Files included in the management approval email (supporting doc + approved form PDF). */
        approvalAttachments: [{
            label: { type: String, default: '' },
            name: { type: String, default: '' },
            url: { type: String, default: '' },
            publicId: { type: String, default: '' },
            mimeType: { type: String, default: 'application/pdf' },
            source: {
                type: String,
                enum: ['supporting', 'approved-form', 'asset-loss-report'],
                default: 'approved-form',
            },
            addedAt: { type: Date, default: Date.now },
        }],
        /** Full log of every approval PDF generation (initial + each HR / edit regeneration). */
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
            scheduleFromMonth: { type: String, default: '' },
            scheduleToMonth: { type: String, default: '' },
            durationFrom: { type: Number, default: null },
            durationTo: { type: Number, default: null },
        }],
    },
    { timestamps: true }
);

// Index for faster queries
fineSchema.index({ "assignedEmployees.employeeId": 1 });
fineSchema.index({ fineStatus: 1 });
fineSchema.index({ fineType: 1 });
fineSchema.index({ createdAt: -1 });

export default mongoose.model("Fine", fineSchema);
