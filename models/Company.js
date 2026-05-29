import mongoose from "mongoose";

/**
 * Lean company record — identity, contact, status, responsibilities.
 *
 * Heavy data lives in separate collections (same MongoDB database):
 * - CompanyCompliance   → trade license, establishment card
 * - CompanyOwners       → owners, oldOwners
 * - CompanyDocumentBundle → documents, insurance, ejari, training, oldDocuments
 * - CompanyWorkflow     → activation workflow, holds, not-renew queue
 *
 * Use `loadCompanyFullProfile()` from services/companyPartitionService.js for reads.
 * Legacy rows (dataPartitionVersion 0) may still have old fields on `companies` in DB until migration.
 */
const companySchema = new mongoose.Schema(
    {
        name: { type: String, required: true, unique: true },
        nickName: { type: String },
        companyId: { type: String, required: true, unique: true },
        establishedDate: { type: Date },
        logo: { type: String },
        email: { type: String, required: true, unique: true },
        phone: { type: String },
        phoneCountryCode: { type: String },
        website: { type: String },
        address: { type: String },
        city: { type: String },
        state: { type: String },
        country: { type: String, default: "United Arab Emirates" },
        registrationNumber: { type: String },
        vatNumber: { type: String },
        postalCode: { type: String },

        status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
        activationStatus: {
            type: String,
            enum: ["draft", "submitted", "active", "rejected"],
            default: "draft",
        },
        activationSubmittedTo: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeBasic", default: null },
        activationSubmittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeBasic", default: null },

        responsibilities: [
            {
                category: { type: String },
                employeeId: { type: String },
                employeeName: { type: String },
                designation: { type: String },
                empObjectId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
                status: { type: String, enum: ["Pending", "Active"], default: "Pending" },
            },
        ],

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

        /** @see scripts/migrateCompanyPartitions.js */
        dataPartitionVersion: { type: Number, default: 0 },
    },
    {
        timestamps: true,
        strict: true,
    },
);

companySchema.index({ createdAt: -1 });
companySchema.index({ status: 1, createdAt: -1 });

export default mongoose.model("Company", companySchema);
