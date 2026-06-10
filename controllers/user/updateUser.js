import User from "../../models/User.js";
import { resolveFrontendBaseUrl, emailFrontendUrl } from '../../utils/resolveFrontendBaseUrl.js';
import Group from "../../models/Group.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import jwt from "jsonwebtoken";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sendPasswordResetCredentialsEmail = async ({
    recipientEmail,
    username,
    fullName,
    newPassword,
    resetUrl,
}) => {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass || !recipientEmail) {
        console.warn('[updateUser] Unlock/reset email skipped. Missing EMAIL_USER/EMAIL_PASS/recipientEmail.');
        return;
    }

    const transporter = nodemailer.createTransport({
        host: "smtp.office365.com",
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass }
    });

    await transporter.sendMail({
        from: `"VeRP Portal" <${emailUser}>`,
        to: recipientEmail,
        subject: "Your VeRP account has been unlocked",
        html: `
            <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.6;">
                <h3 style="margin-bottom: 8px;">Account Unlocked - New Login Credentials</h3>
                <p>Hello ${fullName || "User"},</p>
                <p>Your account was locked due to failed login attempts. The administrator has re-activated your account.</p>
                <p><strong>Username:</strong> ${username}</p>
                ${newPassword ? `<p><strong>New Password:</strong> ${newPassword}</p>` : ""}
                ${newPassword ? `<p><strong>Confirm Password:</strong> ${newPassword}</p>` : ""}
                <p>${newPassword
                ? "Please use these credentials to sign in, then change your password immediately."
                : "Please click the button below to set a new password, then login normally."}
                </p>
                ${resetUrl ? `
                <p style="margin-top: 16px;">
                    <a href="${resetUrl}" style="display: inline-block; background: #2563eb; color: #fff; text-decoration: none; padding: 10px 16px; border-radius: 6px; font-weight: 600;">
                        Change Password
                    </a>
                </p>` : ""}
            </div>
        `
    });
};

// Update user
// Note: Rate limiting for this sensitive endpoint should be handled by a global middleware (e.g., express-rate-limit)
import rateLimit from 'express-rate-limit';

// Rate limiter for update operations
const updateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // Limit each IP to 10 requests per windowMs
    message: "Too many update requests from this IP, please try again after 15 minutes",
    standardHeaders: true,
    legacyHeaders: false,
});

// Update user
// Note: Rate limiting is now applied via the array export
const updateUserHandler = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            username,
            name,
            email,
            companyEmail,
            password,
            employeeId,
            group,
            status,
            enablePortalAccess,
            isAdmin
        } = req.body;

        // Type validation
        if (typeof id !== 'string') {
            return res.status(400).json({ message: "Invalid ID format" });
        }
        if (username !== undefined && typeof username !== 'string') {
            return res.status(400).json({ message: "Username must be a string" });
        }
        if (name !== undefined && typeof name !== 'string') {
            return res.status(400).json({ message: "Name must be a string" });
        }
        if (email !== undefined && typeof email !== 'string') {
            return res.status(400).json({ message: "Email must be a string" });
        }
        if (password !== undefined && typeof password !== 'string') {
            return res.status(400).json({ message: "Password must be a string" });
        }
        if (employeeId !== undefined && (employeeId !== null && typeof employeeId !== 'string')) {
            return res.status(400).json({ message: "Employee ID must be a string or null" });
        }

        const user = await User.findById(id);
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }
        const wasLocked = user.status === "Locked";
        const willResetPassword = password !== undefined && password !== null && password !== '';
        const requestedStatus = status !== undefined ? String(status) : undefined;
        const triesUnlockByStatus = wasLocked && requestedStatus === "Active";
        const triesUnlockByPasswordReset = wasLocked && willResetPassword;
        const unlockRequested = triesUnlockByStatus || triesUnlockByPasswordReset;

        if (unlockRequested) {
            const { isUserAdministrator } = await import("../../services/permissionService.js");
            const canAdminUnlock = await isUserAdministrator(req.user?.id);
            if (!canAdminUnlock) {
                return res.status(403).json({
                    message: "Only administrator can unlock a locked user."
                });
            }
        }

        // Check if this is the system admin user
        const adminUsername = process.env.ADMIN_USERNAME || 'admin';
        const isSystemAdmin = user.username?.toLowerCase() === adminUsername.toLowerCase();

        // For system admin, password is stored ONLY in .env file, not in MongoDB
        if (isSystemAdmin) {
            // Only allow password updates for admin user
            if (password === undefined || password === null || password === '') {
                return res.status(400).json({
                    message: "Password is required to update admin password."
                });
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

            // Check if new password is different from current .env password
            const currentAdminPassword = process.env.ADMIN_PASSWORD;
            if (password === currentAdminPassword) {
                return res.status(400).json({
                    message: "New password must be different from the current password"
                });
            }

            // Update .env file with new password
            try {
                // Find .env file path
                const envPath = path.join(__dirname, '..', '..', '.env');

                // Read .env file if it exists
                let envContent = '';
                if (fs.existsSync(envPath)) {
                    envContent = fs.readFileSync(envPath, 'utf8');
                }

                // Update or add ADMIN_PASSWORD
                const adminPasswordRegex = /^ADMIN_PASSWORD=.*$/m;
                if (adminPasswordRegex.test(envContent)) {
                    envContent = envContent.replace(adminPasswordRegex, `ADMIN_PASSWORD=${password}`);
                } else {
                    envContent += (envContent ? '\n' : '') + `ADMIN_PASSWORD=${password}\n`;
                }

                // Write updated content to .env file
                fs.writeFileSync(envPath, envContent, 'utf8');

                // Update process.env for current session
                process.env.ADMIN_PASSWORD = password;

                console.log('Admin password updated in .env file:', user.username);

                return res.status(200).json({
                    message: 'Admin password updated in .env file. Please restart the server for changes to take full effect.',
                    user: await User.findById(id).select('-password').populate('group', 'name'),
                    requiresRestart: true
                });
            } catch (error) {
                console.error('Error updating .env file:', error);
                return res.status(500).json({
                    message: `Failed to update .env file: ${error.message}`
                });
            }
        }

        // Build update object
        const updateData = {};

        if (username !== undefined) {
            const newUsername = username.trim();
            // Check if username is already taken by another user
            if (newUsername !== user.username) {
                const existingUsername = await User.findOne({ username: newUsername });
                if (existingUsername) {
                    return res.status(400).json({ message: "Username already exists" });
                }
            }
            updateData.username = newUsername;
        }
        if (name !== undefined) updateData.name = name.trim();
        if (email !== undefined) {
            const newEmail = email.trim().toLowerCase();
            // Check if email is already taken by another user
            if (newEmail !== user.email) {
                const existingEmail = await User.findOne({ email: newEmail });
                if (existingEmail) {
                    return res.status(400).json({ message: "Email already exists" });
                }
            }
            updateData.email = newEmail;
        }
        if (willResetPassword) {
            // Check if password matches current password
            if (user.password) {
                const isMatch = await bcrypt.compare(password, user.password);
                if (isMatch) {
                    return res.status(400).json({
                        message: "New password must be different from the current password"
                    });
                }
            }

            // Check if password matches any in history
            if (user.passwordHistory && user.passwordHistory.length > 0) {
                for (const oldHash of user.passwordHistory) {
                    const isMatch = await bcrypt.compare(password, oldHash);
                    if (isMatch) {
                        return res.status(400).json({
                            message: "New password must be different from recently used passwords"
                        });
                    }
                }
            }

            // Update history: push current hash to history before changing
            if (user.password) {
                // Keep only last 5 passwords (optional limit, or just push)
                const newHistory = [...(user.passwordHistory || [])];
                newHistory.push(user.password);
                // Keep only last 5
                if (newHistory.length > 5) newHistory.shift();
                updateData.passwordHistory = newHistory;
            }

            updateData.password = await bcrypt.hash(password, 10);

            // Reset expiry date
            const newExpiry = new Date();
            newExpiry.setDate(newExpiry.getDate() + 180);
            updateData.passwordExpiryDate = newExpiry;

            // Password reset by admin should unlock account.
            if (wasLocked) {
                updateData.status = "Active";
                updateData.loginAttempts = 0;
                updateData.lockUntil = null;
            }
        }
        if (employeeId !== undefined) {
            if (employeeId) {
                const employee = await EmployeeBasic.findOne({ employeeId });
                if (!employee) {
                    return res.status(400).json({ message: "Employee not found" });
                }
                // Check if another user already has this employeeId
                const existingUser = await User.findOne({ employeeId, _id: { $ne: id } });
                if (existingUser) {
                    return res.status(400).json({ message: "This employee is already assigned to another user" });
                }
            }
            updateData.employeeId = employeeId || null;
        }
        if (group !== undefined) {
            updateData.group = group || null;
            // Update group name
            if (group) {
                const groupDoc = await Group.findById(group);
                if (!groupDoc) {
                    return res.status(400).json({ message: "Group not found" });
                }
                updateData.groupName = groupDoc.name;
            } else {
                updateData.groupName = null;
            }
        }
        if (status !== undefined) updateData.status = status;
        if (enablePortalAccess !== undefined) updateData.enablePortalAccess = enablePortalAccess;
        if (isAdmin !== undefined) updateData.isAdmin = isAdmin;
        if (companyEmail !== undefined) updateData.companyEmail = companyEmail;

        const updatedUser = await User.findByIdAndUpdate(
            id,
            { $set: updateData },
            { new: true, runValidators: true }
        ).select('-password').populate('group', 'name');

        // For locked users: on unlock, always send reset email to company email (or fallback email).
        if (unlockRequested) {
            try {
                const recipientEmail = (updatedUser.companyEmail || '').trim() || (updatedUser.email || '').trim();
                const baseUrl = resolveFrontendBaseUrl(req);
                let resetUrl = '';
                if (process.env.JWT_SECRET) {
                    const resetToken = jwt.sign(
                        { id: updatedUser._id.toString(), purpose: "password-reset" },
                        process.env.JWT_SECRET,
                        { expiresIn: "24h" }
                    );
                    resetUrl = `${baseUrl}/change-password?token=${encodeURIComponent(resetToken)}`;
                }
                await sendPasswordResetCredentialsEmail({
                    recipientEmail,
                    username: updatedUser.username,
                    fullName: updatedUser.name,
                    newPassword: willResetPassword ? password : '',
                    resetUrl,
                });
                console.log(`[updateUser] Unlock/reset email sent to ${recipientEmail || '(no-recipient)'}`);
            } catch (mailErr) {
                console.error('[updateUser] Failed to send unlock/reset email:', mailErr);
            }
        }

        if (updatedUser.employeeId) {
            try {
                const syncData = {};
                if (updateData.companyEmail !== undefined) syncData.companyEmail = updateData.companyEmail;
                if (updateData.enablePortalAccess !== undefined) syncData.enablePortalAccess = updateData.enablePortalAccess;

                if (Object.keys(syncData).length > 0) {
                    await EmployeeBasic.findOneAndUpdate(
                        { employeeId: updatedUser.employeeId },
                        { $set: syncData }
                    );
                }
            } catch (err) {
                console.error('[updateUser] Error syncing data to Employee record for:', updatedUser.employeeId, err);
            }
        }

        return res.status(200).json({
            message: "User updated successfully",
            user: updatedUser,
        });
    } catch (error) {
        console.error('Error updating user:', error);
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

export const updateUser = [updateLimiter, updateUserHandler];

