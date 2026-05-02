import mongoose from "mongoose";

const companySchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        nickName: { type: String },
        companyId: { type: String, required: true, unique: true }, // e.g., EST-001
        establishedDate: { type: Date },
        logo: { type: String }, // Storage URL
        email: { type: String, required: true },
        phone: { type: String },
        website: { type: String },
        address: { type: String },
        city: { type: String },
        state: { type: String },
        country: { type: String, default: "UAE" },
        registrationNumber: { type: String },
        vatNumber: { type: String },

        // Trade License Details
        tradeLicenseNumber: { type: String },
        tradeLicenseIssueDate: { type: Date },
        tradeLicenseExpiry: { type: Date },
        tradeLicenseOwnerName: { type: String },
        tradeLicenseAttachment: { type: String },

        owners: [
            {
                name: { type: String },
                nationality: { type: String },
                sharePercentage: { type: String },
                attachment: { type: String },
                passport: {
                    number: { type: String },
                    nationality: { type: String },
                    issueDate: { type: Date },
                    expiryDate: { type: Date },
                    countryOfIssue: { type: String },
                    placeOfIssue: { type: String },
                    attachment: { type: String }
                },
                visa: {
                    number: { type: String },
                    type: { type: String },
                    issueDate: { type: Date },
                    sponsor: { type: String },
                    expiryDate: { type: Date },
                    attachment: { type: String }
                },
                emiratesId: {
                    number: { type: String },
                    issueDate: { type: Date },
                    expiryDate: { type: Date },
                    attachment: { type: String }
                },
                medical: {
                    number: { type: String },
                    expiryDate: { type: Date },
                    attachment: { type: String }
                },
                drivingLicense: {
                    number: { type: String },
                    expiryDate: { type: Date },
                    attachment: { type: String }
                },
                labourCard: {
                    number: { type: String },
                    expiryDate: { type: Date },
                    lastUpdated: { type: Date },
                    attachment: { type: String }
                }
            }
        ],

        // Establishment Card Details
        establishmentCardNumber: { type: String },
        establishmentCardIssueDate: { type: Date },
        establishmentCardExpiry: { type: Date },
        establishmentCardAttachment: { type: String },

        status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
        activationStatus: {
            type: String,
            enum: ["draft", "submitted", "active", "rejected"],
            default: "draft",
        },
        activationSubmittedTo: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeBasic", default: null },
        activationWorkflow: [
            {
                role: { type: String, required: true }, // HR
                assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeBasic" },
                status: { type: String, enum: ["submitted", "active", "rejected"], default: "submitted" },
                assignedAt: { type: Date, default: Date.now },
                actionedAt: { type: Date },
                comment: { type: String },
                reason: { type: String, default: "" },
                description: { type: String, default: "" },
                attachment: { type: String, default: "" },
                attachmentName: { type: String, default: "" },
            },
        ],
        pendingReactivationChanges: [
            {
                card: { type: String, default: "" },
                reason: { type: String, default: "" },
                section: { type: String, default: "" },
                changeType: { type: String, enum: ["add", "update", "delete", ""], default: "" },
                targetIndex: { type: Number, default: null },
                previousData: { type: mongoose.Schema.Types.Mixed, default: null },
                proposedData: { type: mongoose.Schema.Types.Mixed, default: null },
                changedAt: { type: Date, default: Date.now },
            }
        ],

        /** HR partial hold — company stays activation submitted/inactive until full approve or resubmit. */
        activationHold: {
            type: new mongoose.Schema(
                {
                    heldAt: { type: Date },
                    unapprovedEntryIds: [{ type: String }],
                    unapprovedCards: [{ type: String }],
                    comment: { type: String, default: "" },
                },
                { _id: false },
            ),
            default: undefined,
        },

        // General Documents
        documents: [
            {
                type: { type: String },
                description: { type: String },
                context: { type: String },
                provider: { type: String },
                issueDate: { type: Date },
                startDate: { type: Date },
                expiryDate: { type: Date },
                value: { type: Number },
                document: {
                    url: { type: String },
                    name: { type: String },
                    mimeType: { type: String }
                }
            }
        ],

        // Structured Records
        insurance: [
            {
                type: { type: String }, // Medical, Liability, etc.
                provider: { type: String },
                description: { type: String },
                context: { type: String },
                issueDate: { type: Date },
                startDate: { type: Date },
                expiryDate: { type: Date },
                value: { type: Number },
                document: {
                    url: { type: String },
                    name: { type: String },
                    mimeType: { type: String }
                }
            }
        ],

        ejari: [
            {
                type: { type: String }, // Dynamic name like "Office Rental", "Warehouse Lease"
                description: { type: String },
                provider: { type: String },
                context: { type: String },
                issueDate: { type: Date },
                startDate: { type: Date },
                expiryDate: { type: Date },
                value: { type: Number },
                document: {
                    url: { type: String },
                    name: { type: String },
                    mimeType: { type: String }
                }
            }
        ],

        customTabs: [String],

        trainingDetails: [
            {
                trainingName: { type: String },
                trainingDetails: { type: String },
                provider: { type: String },
                trainingDate: { type: Date },
                trainingCost: { type: Number },
                certificate: {
                    url: { type: String },
                    name: { type: String },
                    mimeType: { type: String }
                }
            }
        ],
        responsibilities: [
            {
                category: { type: String }, // e.g., hr, accounts
                employeeId: { type: String },
                employeeName: { type: String },
                designation: { type: String },
                empObjectId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
                status: { type: String, enum: ["Pending", "Active"], default: "Pending" }
            }
        ],
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
    },
    { timestamps: true }
);

export default mongoose.model("Company", companySchema);
