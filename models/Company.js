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
        status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
    },
    { timestamps: true }
);

export default mongoose.model("Company", companySchema);
