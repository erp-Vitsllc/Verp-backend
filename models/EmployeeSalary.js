import mongoose from "mongoose";

/**
 * EmployeeSalary - Salary structure and history
 * Contains: Current salary structure, Salary history
 */
const additionalAllowanceSchema = new mongoose.Schema(
    {
        type: { type: String },
        amount: { type: Number, default: 0 },
        percentage: { type: Number, default: 0 },
    },
    { _id: false }
);

const salaryHistorySchema = new mongoose.Schema(
    {
        month: { type: String }, // e.g., "January 2024"
        fromDate: { type: Date },
        toDate: { type: Date, default: null }, // null for current/active entry
        basic: { type: Number, default: 0 },
        houseRentAllowance: { type: Number, default: 0 },
        otherAllowance: { type: Number, default: 0 },
        vehicleAllowance: { type: Number, default: 0 },
        fuelAllowance: { type: Number, default: 0 },
        additionalAllowances: [additionalAllowanceSchema], // Store all additional allowances
        totalSalary: { type: Number, default: 0 },
        attachment: {
            url: { type: String }, // Cloudinary URL (preferred)
            data: { type: String }, // Base64 data (legacy, for backward compatibility)
            name: { type: String },
            mimeType: { type: String },
        },
        offerLetter: {
            url: { type: String }, // Cloudinary URL (preferred)
            data: { type: String }, // Base64 data (legacy, for backward compatibility)
            name: { type: String },
            mimeType: { type: String },
        },
        createdAt: { type: Date, default: Date.now }
    },
    { _id: true }
);

const employeeSalarySchema = new mongoose.Schema(
    {
        employeeId: {
            type: String,
            required: true,
            ref: "EmployeeBasic"
        },

        // SALARY STRUCTURE
        workLocation: { type: String, enum: ['uae', 'outside_uae'], default: 'uae' },
        workingFromCountry: { type: String, default: '', trim: true },
        workingFromCountryCode: { type: String, default: '', trim: true, uppercase: true },
        salaryCurrency: { type: String, default: 'AED', trim: true, uppercase: true },
        workTimeZone: { type: String, default: 'Asia/Dubai', trim: true },
        monthlySalary: { type: Number, default: 0 },
        totalSalary: { type: Number, default: 0 }, // Total salary calculated and stored
        basic: { type: Number, default: 0 },
        basicPercentage: { type: Number, default: 60 }, // auto calculation possible
        houseRentAllowance: { type: Number, default: 0 },
        houseRentPercentage: { type: Number, default: 20 },
        otherAllowance: { type: Number, default: 0 },
        otherAllowancePercentage: { type: Number, default: 20 },
        additionalAllowances: [additionalAllowanceSchema],
        offerLetter: {
            url: { type: String }, // Cloudinary URL (preferred)
            data: { type: String }, // Base64 data (legacy, for backward compatibility)
            name: { type: String },
            mimeType: { type: String },
        },

        // SALARY HISTORY
        salaryHistory: [salaryHistorySchema],
    },
    { timestamps: true }
);

// Index for faster queries
employeeSalarySchema.index({ monthlySalary: 1 });

// Ensure one salary record per employee
employeeSalarySchema.index({ employeeId: 1 }, { unique: true });

export default mongoose.model("EmployeeSalary", employeeSalarySchema);

