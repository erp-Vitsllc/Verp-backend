import mongoose from "mongoose";

const visaDocumentSchema = new mongoose.Schema(
    {
        number: { type: String },
        issueDate: { type: Date },
        expiryDate: { type: Date },
        sponsor: { type: String },
        document: {
            data: { type: String },
            name: { type: String },
            mimeType: { type: String },
        },
        lastUpdated: { type: Date },
    },
    { _id: false }
);

const employeeSchema = new mongoose.Schema(
    {
        // BASIC INFO
        firstName: { type: String, required: true },
        lastName: { type: String, required: true },
        employeeId: { type: String, required: true, unique: true }, // Ex: VITS001
        role: { type: String, default: '' }, // HR Manager, Developer…
        department: { type: String, default: '' }, // Administration, HR, IT…
        designation: { type: String, default: '' },
        status: {
            type: String,
            enum: ["Probation", "Permanent", "Temporary", "Notice"],
            default: "Probation",
        },
        probationPeriod: {
            type: Number,
            enum: [1, 2, 3, 4, 5, 6],
            default: null,
        },
        reportingAuthority: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
        overtime: { type: Boolean, default: false },
        profileApprovalStatus: {
            type: String,
            enum: ["draft", "submitted", "active"],
            default: "draft"
        },
        profileStatus: {
            type: String,
            enum: ["active", "inactive"],
            default: "inactive"
        },

        // LOGIN & ACCESS
        email: { type: String, required: true, unique: true },
        companyEmail: { type: String, default: '', trim: true, lowercase: true },
        password: { type: String }, // hashed (only if enablePortalAccess is true)
        enablePortalAccess: { type: Boolean, default: false },

        // EMPLOYMENT INFO
        dateOfJoining: { type: Date, required: true },

        // CONTACT INFO
        contactNumber: { type: String, required: true },
        addressLine1: { type: String },
        addressLine2: { type: String },
        country: { type: String },
        state: { type: String },
        city: { type: String },
        postalCode: { type: String },
        currentAddressLine1: { type: String },
        currentAddressLine2: { type: String },
        currentCity: { type: String },
        currentState: { type: String },
        currentCountry: { type: String },
        currentPostalCode: { type: String },

        // PERSONAL DETAILS
        gender: {
            type: String,
            enum: ["male", "female", "other"],
            required: true,
        },
        dateOfBirth: { type: Date },
        age: { type: Number },
        maritalStatus: { type: String },
        nationality: { type: String },
        fathersName: { type: String },

        // DOCUMENT EXPIRY DETAILS
        passportExp: { type: Date },
        eidExp: { type: Date },
        medExp: { type: Date },

        // PASSPORT DETAILS
        passportDetails: {
            number: { type: String },
            nationality: { type: String },
            issueDate: { type: Date },
            expiryDate: { type: Date },
            placeOfIssue: { type: String },
            document: {
                data: { type: String },
                name: { type: String },
                mimeType: { type: String },
            },
            lastUpdated: { type: Date },
        },

        // VISA DETAILS
        visaDetails: {
            visit: { type: visaDocumentSchema, default: undefined },
            employment: { type: visaDocumentSchema, default: undefined },
            spouse: { type: visaDocumentSchema, default: undefined },
        },

        // SALARY STRUCTURE
        monthlySalary: { type: Number, default: 0 },
        basic: { type: Number, default: 0 },
        basicPercentage: { type: Number, default: 60 }, // auto calculation possible
        houseRentAllowance: { type: Number, default: 0 },
        houseRentPercentage: { type: Number, default: 20 },
        otherAllowance: { type: Number, default: 0 },
        otherAllowancePercentage: { type: Number, default: 20 },
        additionalAllowances: [
            {
                type: { type: String },
                amount: { type: Number, default: 0 },
                percentage: { type: Number, default: 0 },
            },
        ],

        // PROFILE PICTURE
        profilePicture: { type: String }, // Cloudinary URL

        // BANK DETAILS
        bankName: { type: String },
        accountName: { type: String },
        accountNumber: { type: String },
        ibanNumber: { type: String },
        swiftCode: { type: String },
        bankOtherDetails: { type: String },

        // EMERGENCY CONTACTS
        emergencyContacts: [
            {
                name: { type: String },
                relation: { type: String, default: 'Self' },
                number: { type: String }
            }
        ],

        // EDUCATION DETAILS
        educationDetails: [
            {
                universityOrBoard: { type: String },
                collegeOrInstitute: { type: String },
                course: { type: String },
                fieldOfStudy: { type: String },
                completedYear: { type: String },
                certificate: {
                    data: { type: String },
                    name: { type: String },
                    mimeType: { type: String }
                }
            }
        ],

        // EXPERIENCE DETAILS
        experienceDetails: [
            {
                company: { type: String },
                designation: { type: String },
                startDate: { type: Date },
                endDate: { type: Date },
                certificate: {
                    data: { type: String },
                    name: { type: String },
                    mimeType: { type: String }
                }
            }
        ],

        // DOCUMENTS
        documents: [
            {
                type: { type: String },
                description: { type: String },
                document: {
                    url: { type: String }, // Cloudinary URL (preferred)
                    data: { type: String }, // Base64 data (legacy/fallback)
                    name: { type: String },
                    mimeType: { type: String }
                }
            }
        ],

        // TRAINING DETAILS
        trainingDetails: [
            {
                trainingName: { type: String },
                trainingDetails: { type: String },
                trainingFrom: { type: String },
                trainingDate: { type: Date },
                trainingCost: { type: Number },
                certificate: {
                    url: { type: String }, // Cloudinary URL (preferred)
                    data: { type: String }, // Base64 data (legacy/fallback)
                    name: { type: String },
                    mimeType: { type: String }
                }
            }
        ],

        // SALARY HISTORY
        salaryHistory: [
            {
                month: { type: String }, // e.g., "January 2024"
                fromDate: { type: Date },
                toDate: { type: Date, default: null }, // null for current/active entry
                basic: { type: Number, default: 0 },
                houseRentAllowance: { type: Number, default: 0 },
                otherAllowance: { type: Number, default: 0 },
                vehicleAllowance: { type: Number, default: 0 },
                totalSalary: { type: Number, default: 0 },
                createdAt: { type: Date, default: Date.now }
            }
        ],

        // NOTICE REQUEST
        noticeRequest: {
            duration: { type: String }, // "1 Month", "2 Months", "3 Months"
            reason: { type: String, enum: ["Termination", "Resignation"] },
            attachment: {
                url: { type: String },
                name: { type: String },
                mimeType: { type: String },
                data: { type: String },
                publicId: { type: String }
            },
            status: { type: String, enum: ["Pending", "Approved", "Rejected"] },
            originalStatus: { type: String }, // To revert if rejected
            requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // Or Employee ID string depending on auth
            requestedAt: { type: Date, default: Date.now },
            actionedAt: { type: Date },
            actionedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" }
        }
    },
    { timestamps: true }
);

export default mongoose.model("Employee", employeeSchema);


