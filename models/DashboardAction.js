import mongoose from "mongoose";

const dashboardActionSchema = new mongoose.Schema({
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic', required: true },
    assignedToEmpId: { type: String }, // Human-readable ID (e.g., VITS001) for easier querying
    requestId: { type: mongoose.Schema.Types.ObjectId, required: true },
    requestType: {
        type: String,
        required: true,
        enum: ['Loan', 'Reward', 'Fine', 'Group Fine Request', 'Profile Activation', 'Notice Request', 'Company Activation', 'Asset', 'Asset Overdue', 'Asset Approval', 'Asset Assignment', 'Asset Transfer', 'Asset Loss Damage', 'Asset End of Life', 'Asset Accessory', 'Asset Accessory Approval', 'Asset Accessory Unattach', 'Asset Return', 'Responsibility Approval', 'Asset Leave', 'Asset Bulk Action', 'Asset Owner On Duty', 'Asset On Duty Request', 'Payment Approval', 'Utility Bill Payment', 'Utility Bill Payment Reminder', 'Utility Entry Status Change', 'Vehicle Service Request', 'Vehicle Profile Activation', 'Vehicle Profile Edit', 'Vehicle Inspection', 'Vehicle Mortgage Close', 'Vehicle Disposition Request', 'Vehicle Document Expiry Reminder', 'Document Expiry Reminder', 'Employee Document Expiry Reminder', 'Probation Change', 'Company Document Not Renew', 'Employee Document Not Renew', 'Card Deleted Progress']
    },
    status: {
        type: String,
        enum: ['Pending', 'Approved', 'Rejected', 'On Hold', 'Dismissed'],
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
    extra3: { type: String }, // For bulk transfer info (JSON string)
    isGlobal: { type: Boolean, default: false }
}, { timestamps: true });

// Index for fast dashboard fetching
dashboardActionSchema.index({ assignedTo: 1, status: 1 });
dashboardActionSchema.index({ assignedToEmpId: 1, status: 1 });
dashboardActionSchema.index({ requestId: 1 });

export default mongoose.model("DashboardAction", dashboardActionSchema);
