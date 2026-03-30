import mongoose from "mongoose";

/**
 * EmployeeEducation - Education details
 * Contains: Education history array
 */
const educationDetailSchema = new mongoose.Schema(
    {
        universityOrBoard: { type: String },
        collegeOrInstitute: { type: String },
        course: { type: String },
        fieldOfStudy: { type: String },
        completedYear: { type: String },
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

const employeeEducationSchema = new mongoose.Schema(
    {
        employeeId: {
            type: String,
            required: true,
            ref: "EmployeeBasic"
        },

        // EDUCATION DETAILS
        educationDetails: [educationDetailSchema],
    },
    { timestamps: true }
);

// Index for faster queries
// Ensure one education record per employee
employeeEducationSchema.index({ employeeId: 1 }, { unique: true });

export default mongoose.model("EmployeeEducation", employeeEducationSchema);

