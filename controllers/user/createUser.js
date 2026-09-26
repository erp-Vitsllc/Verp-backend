import User from "../../models/User.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import Group from "../../models/Group.js";
import bcrypt from "bcryptjs";
import { isWhatsAppEnabled } from "../../config/whatsapp.js";
import { resolveEmployeeWhatsAppPhone } from "../../utils/sendToolsAssetWhatsAppReport.js";
import { sendPortalCredentialsWhatsApp } from "../../utils/sendPortalCredentialsWhatsApp.js";

// Create new user
export const createUser = async (req, res) => {
    try {
        const {
            username,
            name,
            email,
            companyEmail,
            password,
            employeeId,
            group,
            status = 'Active',
            enablePortalAccess = true,
            isAdmin = false,
            sendCredentialsViaWhatsApp = false,
        } = req.body;

        const shouldSendWhatsApp = sendCredentialsViaWhatsApp === true;

        // Validate required fields and types
        if (typeof username !== 'string' || !username.trim() ||
            typeof name !== 'string' || !name.trim() ||
            typeof email !== 'string' || !email.trim() ||
            typeof password !== 'string' || !password) {
            return res.status(400).json({
                message: "Username, name, email, and password are required strings"
            });
        }

        if (employeeId && typeof employeeId !== 'string') {
            return res.status(400).json({ message: "Employee ID must be a string" });
        }

        // Validate password requirements
        if (password.length < 8) {
            return res.status(400).json({
                message: "Password must be at least 8 characters"
            });
        }
        if (!/[A-Z]/.test(password)) {
            return res.status(400).json({
                message: "Password must contain at least one uppercase letter"
            });
        }
        if (!/[a-z]/.test(password)) {
            return res.status(400).json({
                message: "Password must contain at least one lowercase letter"
            });
        }
        if (!/[0-9]/.test(password)) {
            return res.status(400).json({
                message: "Password must contain at least one number"
            });
        }

        // Check if username already exists
        const existingUsername = await User.findOne({ username: username.trim() });
        if (existingUsername) {
            return res.status(400).json({ message: "Username already exists" });
        }

        // Check if email already exists
        const existingEmail = await User.findOne({ email: email.trim().toLowerCase() });
        if (existingEmail) {
            return res.status(400).json({ message: "Email already exists" });
        }

        // If employeeId is provided, verify employee exists
        if (employeeId) {
            const employee = await EmployeeBasic.findOne({ employeeId });
            if (!employee) {
                return res.status(400).json({ message: "Employee not found" });
            }

            // Check if employee is already a user
            const existingUser = await User.findOne({ employeeId });
            if (existingUser) {
                return res.status(400).json({ message: "This employee is already a user" });
            }
        }

        if (shouldSendWhatsApp) {
            if (!employeeId) {
                return res.status(400).json({
                    message: "Select an existing employee to send the username and password on WhatsApp.",
                });
            }
            if (!isWhatsAppEnabled()) {
                return res.status(400).json({
                    message: "WhatsApp is turned off, so the login details cannot be sent. Create the user without that option, or turn WhatsApp on first.",
                });
            }
            const whatsappPhone = await resolveEmployeeWhatsAppPhone(employeeId);
            if (!whatsappPhone) {
                return res.status(400).json({
                    message: "This employee has no WhatsApp number. Add one on their profile, or create the user without sending WhatsApp.",
                });
            }
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Get group name if group is provided
        let groupName = null;
        if (group) {
            const groupDoc = await Group.findById(group);
            if (!groupDoc) {
                return res.status(400).json({ message: "Group not found" });
            }
            groupName = groupDoc.name;
        }

        // Calculate password expiry date (180 days from now)
        const passwordExpiryDate = new Date();
        passwordExpiryDate.setDate(passwordExpiryDate.getDate() + 180);

        // Create user
        const newUser = new User({
            username: username.trim(),
            name: name.trim(),
            email: email.trim().toLowerCase(),
            companyEmail: companyEmail || '',
            password: hashedPassword,
            employeeId: employeeId || null,
            group: group || null,
            groupName: groupName || null,
            status: status,
            enablePortalAccess: enablePortalAccess,
            isAdmin: isAdmin || false,
            passwordExpiryDate: passwordExpiryDate,
        });

        const savedUser = await newUser.save();

        // BIDIRECTIONAL SYNC: Update Employee profile if user was created with a companyEmail
        if (companyEmail && employeeId) {
            try {
                await EmployeeBasic.findOneAndUpdate(
                    { employeeId: employeeId },
                    {
                        $set: {
                            companyEmail: companyEmail || '',
                            enablePortalAccess: enablePortalAccess
                        }
                    }
                );
            } catch (err) {
                console.error('[createUser] Error syncing companyEmail to Employee record for:', employeeId, err);
            }
        }

        // Remove password from response
        const userResponse = savedUser.toObject();
        delete userResponse.password;

        const whatsapp = { requested: shouldSendWhatsApp, sent: false };
        if (shouldSendWhatsApp) {
            try {
                const delivery = await sendPortalCredentialsWhatsApp({
                    employeeId,
                    name: name.trim(),
                    username: username.trim(),
                    password,
                    actor: req.user,
                    req,
                });
                whatsapp.sent = delivery.sent === true;
                if (!whatsapp.sent) {
                    whatsapp.error = delivery.error || "WhatsApp could not send the login details. The user was still created.";
                }
            } catch (whatsappError) {
                console.error("[createUser] WhatsApp credentials send failed:", whatsappError?.message || whatsappError);
                whatsapp.sent = false;
                whatsapp.error = "WhatsApp could not send the login details. The user was still created.";
            }
        }

        return res.status(201).json({
            message: whatsapp.requested
                ? (whatsapp.sent
                    ? "User created and login details sent on WhatsApp"
                    : "User created, but WhatsApp could not send the login details")
                : "User created successfully",
            user: userResponse,
            whatsapp,
        });
    } catch (error) {
        console.error('Error creating user:', error);
        if (error.code === 11000) {
            const field = Object.keys(error.keyPattern)[0];
            return res.status(400).json({
                message: `${field} already exists`
            });
        }
        return res.status(500).json({
            message: error.message || 'Internal server error'
        });
    }
};

