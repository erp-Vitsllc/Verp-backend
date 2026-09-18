import mongoose from "mongoose";

/**
 * User Model - Separate from Employee
 * An Employee can become a User if added to the system
 * Users have login access and are assigned to groups
 */
const userSchema = new mongoose.Schema(
    {
        // User Identity
        username: { type: String, required: true, unique: true, trim: true },
        name: { type: String, required: true },
        email: { type: String, required: true, unique: true },
        companyEmail: { type: String, default: '', trim: true, lowercase: true },
        password: { type: String, required: false }, // hashed - optional for system admin (password stored in .env)

        // Link to Employee (optional - Employee can become a User)
        employeeId: {
            type: String,
            ref: "EmployeeBasic",
            default: null,
            index: true
        },

        // Group Assignment
        group: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Group",
            default: null
        },
        groupName: { type: String, default: null }, // Denormalized for quick access

        // Status
        status: {
            type: String,
            enum: ["Active", "Inactive", "Suspended", "Locked"],
            default: "Active"
        },

        // Access Control
        enablePortalAccess: { type: Boolean, default: true },
        isAdmin: { type: Boolean, default: false }, // Admin users get all permissions automatically
        lastLogin: { type: Date, default: null },
        lastLoginIp: { type: String, default: '' },
        /** Current VeRP mobile app device. status fixed = only that phone may log in. */
        mobileDevice: {
            deviceId: { type: String, default: '', trim: true },
            deviceName: { type: String, default: '', trim: true },
            location: { type: String, default: '', trim: true },
            latitude: { type: Number, default: null },
            longitude: { type: Number, default: null },
            ipAddress: { type: String, default: '', trim: true },
            lastSeenAt: { type: Date, default: null },
            status: {
                type: String,
                enum: ['not_fixed', 'fixed'],
                default: 'not_fixed',
            },
        },
        passwordExpiryDate: { type: Date, default: null }, // Password expires in 180 days
        passwordHistory: [{ type: String }], // Array of hashed previous passwords

        // Login Protection
        loginAttempts: { type: Number, default: 0 },
        lockUntil: { type: Date, default: null },

        // Profile Picture
        profilePicture: { type: String, default: null },

        // Metadata
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

// Indexes for faster queries
// Note: username and email already have indexes from unique: true
// Note: employeeId already has index from index: true in field definition
userSchema.index({ group: 1 });
userSchema.index({ status: 1 });
userSchema.index({ name: 1 });

export default mongoose.model("User", userSchema);

