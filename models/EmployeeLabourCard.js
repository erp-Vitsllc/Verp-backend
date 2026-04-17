import mongoose from "mongoose";

/**
 * EmployeeLabourCard - Labour Card details
 * Contains: Number, Issue Date, Expiry Date, Attachment
 */
const labourCardDocumentSchema = new mongoose.Schema(
    {
        number: { type: String },
        issueDate: { type: Date },
        expiryDate: { type: Date },
        document: {
            url: { type: String }, // Cloudinary URL (preferred)
            publicId: { type: String }, // Cloudinary public ID for deletion
            data: { type: String }, // Base64 data (legacy, for backward compatibility)
            name: { type: String },
            mimeType: { type: String },
        },
        labourContractAttachment: {
            url: { type: String },
            publicId: { type: String },
            data: { type: String },
            name: { type: String },
            mimeType: { type: String },
        },
        lastUpdated: { type: Date },
    },
    { _id: false }
);

const employeeLabourCardSchema = new mongoose.Schema(
    {
        employeeId: {
            type: String,
            required: true,
            ref: "EmployeeBasic"
        },

        // LABOUR CARD DETAILS
        labourCard: { type: labourCardDocumentSchema, default: undefined },
    },
    { timestamps: true }
);

// Index for faster queries
employeeLabourCardSchema.index({ "labourCard.expiryDate": 1 });

// Ensure one Labour Card record per employee
employeeLabourCardSchema.index({ employeeId: 1 }, { unique: true });

export default mongoose.model("EmployeeLabourCard", employeeLabourCardSchema);












