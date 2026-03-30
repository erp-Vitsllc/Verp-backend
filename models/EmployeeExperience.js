import mongoose from "mongoose";

/**
 * EmployeeExperience - Work experience details
 * Contains: Experience history array
 */
const experienceDetailSchema = new mongoose.Schema(
    {
        company: { type: String },
        designation: { type: String },
        startDate: { type: Date },
        endDate: { type: Date },
        certificate: {
            data: { type: String },
            name: { type: String },
            mimeType: { type: String },
            url: { type: String },
            publicId: { type: String }
        }
    },
    { _id: true }
);

const employeeExperienceSchema = new mongoose.Schema(
    {
        employeeId: {
            type: String,
            required: true,
            ref: "EmployeeBasic"
        },

        // EXPERIENCE DETAILS
        experienceDetails: [experienceDetailSchema],
    },
    { timestamps: true }
);

// Index for faster queries
// Ensure one experience record per employee
employeeExperienceSchema.index({ employeeId: 1 }, { unique: true });

export default mongoose.model("EmployeeExperience", employeeExperienceSchema);

