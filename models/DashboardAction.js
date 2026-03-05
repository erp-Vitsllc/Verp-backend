import mongoose from "mongoose";

const dashboardActionSchema = new mongoose.Schema({
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic', required: true },
    assignedToEmpId: { type: String }, // Human-readable ID (e.g., VITS001) for easier querying
    requestId: { type: mongoose.Schema.Types.ObjectId, required: true },
    requestType: {
        type: String,
        required: true,
        enum: ['Loan', 'Reward', 'Fine', 'Profile Activation', 'Notice Request', 'Asset', 'Asset Overdue', 'Asset Approval']
    },
    status: {
        type: String,
        enum: ['Pending', 'Approved', 'Rejected'],
        default: 'Pending'
    },
    subjectEmployeeId: { type: String }, // The employee the request is ABOUT (e.g. VITS002)
    subjectName: { type: String }, // firstName + lastName
    requestedDate: { type: Date, default: Date.now },
    requestedByName: { type: String }, // Name of person who initiated the request
    actionedDate: { type: Date },
    actionedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic' },
    comment: { type: String },
    // Metadata for dashboard display
    extra1: { type: String },
    extra2: { type: String },
}, { timestamps: true });

// Index for fast dashboard fetching
dashboardActionSchema.index({ assignedTo: 1, status: 1 });
dashboardActionSchema.index({ assignedToEmpId: 1, status: 1 });
dashboardActionSchema.index({ requestId: 1 });

export default mongoose.model("DashboardAction", dashboardActionSchema);
