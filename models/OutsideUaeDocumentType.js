import mongoose from "mongoose";

const outsideUaeDocumentTypeSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            unique: true,
            trim: true,
        },
        status: {
            type: String,
            enum: ["Active", "Inactive"],
            default: "Active",
        },
    },
    { timestamps: true },
);

export default mongoose.model("OutsideUaeDocumentType", outsideUaeDocumentTypeSchema);
