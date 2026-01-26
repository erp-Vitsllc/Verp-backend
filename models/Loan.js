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
    duration: {
        type: Number,
        required: true // in months
    },
    monthStart: {
        type: String,
        required: false, // Optional for legacy records
        default: ''
    },
    reason: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['Draft', 'Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization', 'Approved', 'Rejected', 'Cancelled'],
        default: 'Draft'
    },
    approvalStatus: {
        type: String,
        enum: ['Draft', 'Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization', 'Approved', 'Rejected', 'Cancelled'],
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
        ref: 'EmployeeBasic'
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
        assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic' }, // Note: Loans mostly ref EmployeeBasic but we should stick to User if updating auth logic or accept mixed. For consistency with others, User is better, but existing Loan fields ref EmployeeBasic. Let's stick to User for the *User* dashboard, or keep it generic. Dashboard uses `manager._id` (EmployeeBasic). Let's use `ref: 'User'` for consistency with `submittedTo` fix.
        // Wait, Loan.submittedTo refs EmployeeBasic currently. Let's check Loan.js again.
        // Line 55: ref: 'EmployeeBasic'.
        // IF I change to User here, I must ensure controllers find User ID.
        // The dashboard logic I wrote earlier relies on `manager._id` (EmployeeBasic) for Loans.
        // Let's use EmployeeBasic for Loan workflow to match existing Loan patterns IF the dashboard expects EmployeeBasic ID.
        // BUT `getUserActivityStats` checks `submittedTo: manager._id`.
        // So `assignedTo` should ref `EmployeeBasic`.
        status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
        assignedAt: { type: Date, default: Date.now },
        actionedAt: { type: Date }
    }]
}, { timestamps: true });

const Loan = mongoose.model("Loan", loanSchema);
export default Loan;
