import mongoose from "mongoose";

const companySchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
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
        documents: [
            {
                type: { type: String },
                description: { type: String },
                document: {
                    url: { type: String },
                    name: { type: String },
                    mimeType: { type: String }
                },
                expiryDate: { type: Date }
            }
        ],
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
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
    },
    { timestamps: true }
);

export default mongoose.model("Company", companySchema);
