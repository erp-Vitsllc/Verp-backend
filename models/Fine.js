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
        fineStatus: {
            type: String,
            required: true,
            enum: ['Draft', 'Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization', 'Approved', 'Active', 'Completed', 'Cancelled', 'Rejected'],
            default: 'Draft'
        },
        fineAmount: {
            type: Number,
            required: true
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
        }]
    },
    { timestamps: true }
);

// Index for faster queries
fineSchema.index({ "assignedEmployees.employeeId": 1 });
fineSchema.index({ fineStatus: 1 });
fineSchema.index({ fineType: 1 });
fineSchema.index({ createdAt: -1 });

export default mongoose.model("Fine", fineSchema);
