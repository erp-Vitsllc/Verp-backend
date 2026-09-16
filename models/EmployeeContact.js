import mongoose from "mongoose";

/**
 * EmployeeContact - Contact information and addresses
 * Contains: Contact number, Permanent Address, Current Address
 */
const employeeContactSchema = new mongoose.Schema(
    {
        employeeId: {
            type: String,
            required: true,
            ref: "EmployeeBasic"
        },

        // CONTACT INFO
        contactNumber: { type: String, required: true },
        /** Optional WhatsApp Cloud API number. Used only for WP send, not contact number. */
        whatsappNumber: { type: String, default: '', trim: true },

        // PERMANENT ADDRESS
        addressLine1: { type: String },
        addressLine2: { type: String },
        country: { type: String },
        state: { type: String },
        city: { type: String },
        postalCode: { type: String },

        // CURRENT ADDRESS
        currentAddressLine1: { type: String },
        currentAddressLine2: { type: String },
        currentCity: { type: String },
        currentState: { type: String },
        currentCountry: { type: String },
        currentPostalCode: { type: String },
    },
    { timestamps: true }
);

// Index for faster queries
employeeContactSchema.index({ contactNumber: 1 });

// Ensure one contact record per employee
employeeContactSchema.index({ employeeId: 1 }, { unique: true });

export default mongoose.model("EmployeeContact", employeeContactSchema);

