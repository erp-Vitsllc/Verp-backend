import mongoose from "mongoose";

/**
 * EmployeeBasic - Core employee information
 * Contains: Basic info, Login & Access, Employment info
 */
const employeeBasicSchema = new mongoose.Schema(
    {
        // BASIC INFO
        firstName: { type: String, required: true },
        lastName: { type: String, required: true },
        employeeId: { type: String, required: true, unique: true }, // Ex: VITS001
        role: { type: String, default: '' }, // HR Manager, Developer…
        department: { type: String, default: '' }, // Administration, HR, IT…
        designation: { type: String, default: '' },
        company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", default: null },
        status: {
            type: String,
            enum: ["Probation", "Permanent", "Temporary", "Notice"],
            default: "Probation",
        },
        probationPeriod: {
            type: Number,
            enum: [1, 2, 3, 4, 5, 6],
            default: null,
        },
        reportingAuthority: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeBasic", default: null },
        primaryReportee: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeBasic", default: null },
        secondaryReportee: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeBasic", default: null },
        overtime: { type: Boolean, default: false },
        profileApprovalStatus: {
            type: String,
            enum: ["draft", "submitted", "active", "rejected"],
            default: "draft"
        },
        profileStatus: {
            type: String,
            enum: ["active", "inactive"],
            default: "inactive"
        },
        // SNAPSHOT: Manager who received the profile submission
        profileSubmittedTo: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeBasic", default: null },

        // NEW: Profile Workflow Array
        profileWorkflow: [{
            role: { type: String, required: true }, // e.g. 'Manager'
            assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic' },
            status: { type: String, enum: ['submitted', 'active', 'rejected'], default: 'submitted' },
            assignedAt: { type: Date, default: Date.now },
            actionedAt: { type: Date },
            comment: { type: String },
            reason: { type: String, default: '' },
            description: { type: String, default: '' },
            attachment: { type: String, default: '' },
            attachmentName: { type: String, default: '' }
        }],

        // LOGIN & ACCESS
        email: { type: String, required: true, unique: true, trim: true, lowercase: true },
        companyEmail: { type: String, default: '', trim: true, lowercase: true },
        password: { type: String }, // hashed (only if enablePortalAccess is true)
        enablePortalAccess: { type: Boolean, default: false },

        // EMPLOYMENT INFO
        dateOfJoining: { type: Date, required: true },
        contractJoiningDate: { type: Date }, // Mandatory field tracked by frontend
        contractExpiryDate: { type: Date }, // Optional field for contract end date

        // PROFILE PICTURE
        profilePicture: { type: String }, // Storage URL

        // SIGNATURE
        signature: {
            url: { type: String }, // Storage URL (IDrive/S3)
            publicId: { type: String }, // Storage object key
            name: { type: String },
            mimeType: { type: String },
            format: { type: String },
            signedAt: { type: Date },
            ipAddress: { type: String }
        },

        // DOCUMENTS
        documents: [
            {
                type: { type: String },
                description: { type: String },
                issueDate: { type: Date },
                expiryDate: { type: Date },
                cost: { type: Number, default: null },
                basicSalary: { type: Number, default: null },
                houseRentAllowance: { type: Number, default: null },
                vehicleAllowance: { type: Number, default: null },
                fuelAllowance: { type: Number, default: null },
                otherAllowance: { type: Number, default: null },
                totalSalary: { type: Number, default: null },
                createdAt: { type: Date, default: Date.now },
                document: {
                    url: { type: String }, // Storage URL (preferred)
                    data: { type: String }, // Base64 data (legacy/fallback)
                    name: { type: String },
                    mimeType: { type: String }
                }
            }
        ],

        // Archived versions of manual documents (replaced/deleted)
        oldDocuments: [
            {
                type: { type: String },
                description: { type: String },
                issueDate: { type: Date },
                expiryDate: { type: Date },
                cost: { type: Number, default: null },
                basicSalary: { type: Number, default: null },
                houseRentAllowance: { type: Number, default: null },
                vehicleAllowance: { type: Number, default: null },
                fuelAllowance: { type: Number, default: null },
                otherAllowance: { type: Number, default: null },
                totalSalary: { type: Number, default: null },
                createdAt: { type: Date },
                archivedAt: { type: Date, default: Date.now },
                archiveReason: { type: String, enum: ['Replaced', 'Deleted'], default: 'Replaced' },
                document: {
                    url: { type: String },
                    data: { type: String },
                    name: { type: String },
                    mimeType: { type: String }
                }
            }
        ],

        // NOTICE REQUEST
        noticeRequest: {
            duration: { type: String }, // "1 Month", "2 Months", "3 Months"
            reason: { type: String, enum: ["Termination", "Resignation"] },
            attachment: {
                url: { type: String },
                name: { type: String },
                mimeType: { type: String },
                data: { type: String }
            },
            status: { type: String, enum: ["Pending", "Approved", "Rejected"] },
            originalStatus: { type: String }, // To revert if rejected
            requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeBasic" },
            // SNAPSHOT: Manager who received the request
            submittedTo: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeBasic" },
            requestedAt: { type: Date, default: Date.now },
            actionedAt: { type: Date },
            actionedBy: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeBasic" },

            // NEW: Notice Workflow Array
            workflow: [{
                role: { type: String, required: true },
                assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic' },
                status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
                assignedAt: { type: Date, default: Date.now },
                actionedAt: { type: Date },
                comment: { type: String }
            }]
        },

        // PROBATION TO PERMANENT WORKFLOW
        probationChangeRequest: {
            status: {
                type: String,
                enum: ['none', 'pending_hod', 'pending_employee', 'pending_hr_final', 'approved', 'rejected'],
                default: 'none'
            },
            probationEndDate: { type: Date, default: null },
            requestedAt: { type: Date, default: null }, // auto request after probation completion
            hodConfirmedAt: { type: Date, default: null },
            hodConfirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic', default: null },
            hrSubmittedAt: { type: Date, default: null },
            hrSubmittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic', default: null },
            employeeDecisionAt: { type: Date, default: null },
            employeeDecisionBy: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic', default: null },
            rejectionReason: { type: String, default: '' },
            workflow: [{
                role: { type: String, enum: ['HR', 'Admin', 'HOD', 'Employee'], required: true },
                assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic', default: null },
                status: { type: String, enum: ['pending', 'approved', 'rejected', 'notified'], default: 'pending' },
                assignedAt: { type: Date, default: Date.now },
                actionedAt: { type: Date, default: null },
                comment: { type: String, default: '' }
            }]
        },

        // TRAINING DETAILS
        trainingDetails: [
            {
                trainingName: { type: String },
                trainingDetails: { type: String },
                provider: { type: String },
                trainingDate: { type: Date },
                trainingCost: { type: Number },
                certificate: {
                    url: { type: String }, // Cloudinary URL (preferred)
                    data: { type: String }, // Base64 data (legacy/fallback)
                    name: { type: String },
                    mimeType: { type: String }
                }
            }
        ],
    },
    { timestamps: true }
);

// Index for faster queries
// Note: employeeId and email already have indexes from unique: true
employeeBasicSchema.index({ department: 1 });
employeeBasicSchema.index({ status: 1 });
employeeBasicSchema.index({ designation: 1 });
employeeBasicSchema.index({ profileStatus: 1 });
employeeBasicSchema.index({ createdAt: -1 }); // For sorting
// Compound indexes for common query patterns
employeeBasicSchema.index({ department: 1, status: 1 });
employeeBasicSchema.index({ status: 1, profileStatus: 1 });
employeeBasicSchema.index({ firstName: 1, lastName: 1 }); // For search queries

export default mongoose.model("EmployeeBasic", employeeBasicSchema);
