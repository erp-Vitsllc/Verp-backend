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
            enum: ["draft", "submitted", "active"],
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
            status: { type: String, enum: ['submitted', 'active'], default: 'submitted' },
            assignedAt: { type: Date, default: Date.now },
            actionedAt: { type: Date }
        }],

        // LOGIN & ACCESS
        email: { type: String, required: true, unique: true },
        companyEmail: { type: String, default: '', trim: true, lowercase: true },
        password: { type: String }, // hashed (only if enablePortalAccess is true)
        enablePortalAccess: { type: Boolean, default: false },

        // EMPLOYMENT INFO
        dateOfJoining: { type: Date, required: true },
        contractJoiningDate: { type: Date }, // Mandatory field tracked by frontend

        // PROFILE PICTURE
        profilePicture: { type: String }, // Storage URL

        // DOCUMENTS
        documents: [
            {
                type: { type: String },
                description: { type: String },
                expiryDate: { type: Date },
                createdAt: { type: Date, default: Date.now },
                document: {
                    url: { type: String }, // Storage URL (preferred)
                    data: { type: String }, // Base64 data (legacy/fallback)
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
            status: { type: String, enum: ["Pending", "Approved", "Rejected"], default: "Pending" },
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
                actionedAt: { type: Date }
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
