import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import { getUserPermissions } from "../services/permissionService.js";
import { getClientIp, recordActivityAsync } from "../utils/activityLog.js";


export const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password)
            return res.status(400).json({ message: "Email/Username and Password are required" });

        if (typeof email !== 'string' || typeof password !== 'string') {
            return res.status(400).json({ message: "Email and Password must be strings" });
        }

        const emailOrUsername = email.trim();
        const adminUsername = process.env.ADMIN_USERNAME || 'admin';
        const adminPassword = process.env.ADMIN_PASSWORD;

        if (!adminPassword) {
            console.warn("ADMIN_PASSWORD is not set in environment variables. Admin login disabled.");
        }

        // Check if this is the admin user from .env
        const isAdminLogin = emailOrUsername.toLowerCase() === adminUsername.toLowerCase() && password === adminPassword;

        let user;
        let isSystemAdmin = false;

        if (isAdminLogin) {
            // This is the system admin - check if user exists, if not create it
            user = await User.findOne({
                $or: [
                    { username: adminUsername.toLowerCase() },
                    { email: process.env.SYSTEM_ADMIN_EMAIL || 'verp@vitsllc.com' }
                ]
            });

            if (!user) {
                // Create admin user if it doesn't exist (NO PASSWORD IN DATABASE - password only in .env)
                const passwordExpiryDate = new Date();
                passwordExpiryDate.setDate(passwordExpiryDate.getDate() + 180);

                user = new User({
                    username: adminUsername.toLowerCase(),
                    name: 'Super User(System)',
                    email: process.env.SYSTEM_ADMIN_EMAIL || 'verp@vitsllc.com',
                    password: null, // Admin password is NOT stored in MongoDB - only in .env
                    employeeId: null,
                    group: null,
                    groupName: null,
                    status: 'Active',
                    enablePortalAccess: true,
                    passwordExpiryDate: passwordExpiryDate,
                });
                await user.save();
                console.log('System admin user created (password stored only in .env)');
            } else {
                // Update admin user details if they exist but don't match
                if (user.username !== adminUsername.toLowerCase()) {
                    user.username = adminUsername.toLowerCase();
                }
                if (user.name !== 'Super User(System)') {
                    user.name = 'Super User(System)';
                }
                if (user.email !== (process.env.SYSTEM_ADMIN_EMAIL || 'verp@vitsllc.com')) {
                    user.email = process.env.SYSTEM_ADMIN_EMAIL || 'verp@vitsllc.com';
                }
                if (user.employeeId !== null) {
                    user.employeeId = null;
                }
                // Ensure admin user has no group (system admin doesn't belong to any group)
                if (user.group !== null) {
                    user.group = null;
                    user.groupName = null;
                }
                // Remove password from database if it exists (admin password should only be in .env)
                if (user.password !== null && user.password !== undefined) {
                    user.password = null;
                    console.log('Admin password removed from database (password stored only in .env)');
                }
                await user.save();
            }
            isSystemAdmin = true;
        } else {
            // Regular user login - find user by email or username first
            console.log(`[Login] Attempting login for: '${emailOrUsername}'`);

            const escapedInput = emailOrUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            user = await User.findOne({
                $or: [
                    // 1. Exact Match (Best case)
                    { email: emailOrUsername },
                    { username: emailOrUsername },
                    // 2. Case Insensitive (Matches 'ramees' to 'Ramees')
                    { email: { $regex: new RegExp(`^${escapedInput}$`, 'i') } },
                    { username: { $regex: new RegExp(`^${escapedInput}$`, 'i') } },
                    // 3. Loose Match (Handles spaces like ' Ramees ')
                    { email: { $regex: new RegExp(`^\\s*${escapedInput}\\s*$`, 'i') } },
                    { username: { $regex: new RegExp(`^\\s*${escapedInput}\\s*$`, 'i') } }
                ]
            });
            if (user) {
                console.log(`User found: ${user.username} (${user.email})`);
            } else {
                console.log(`User NOT found for input: '${emailOrUsername}'`);
            }

            if (!user) {
                return res.status(404).json({ message: "User not found" });
            }

            if (user.status !== 'Active') {
                if (user.status === 'Locked') {
                    return res.status(423).json({
                        message: "Your account is locked after multiple failed login attempts. Please contact administrator."
                    });
                }
                return res.status(403).json({ message: `Your account is ${user.status}. Please contact administrator.` });
            }

            // Check if account is temporarily locked (1 hour block)
            // if (user.lockUntil && user.lockUntil > Date.now()) {
            //     const remainingMinutes = Math.ceil((user.lockUntil - Date.now()) / (60 * 1000));
            //     return res.status(403).json({
            //         message: `Too many failed attempts. Your account is locked for ${remainingMinutes} more minutes.`
            //     });
            // }
        }

        // Check if password exists (skip for system admin as password is already validated from .env)
        if (!isAdminLogin && !user.password) {
            return res.status(401).json({ message: "Password not set for this user" });
        }

        // Compare password (already validated if isAdminLogin is true)
        const validPassword = isAdminLogin ? true : await bcrypt.compare(password, user.password);

        if (!validPassword) {
            // Increment failed attempts for non-admin logins
            if (!isAdminLogin) {
                user.loginAttempts = (user.loginAttempts || 0) + 1;
                const maxAttempts = 5;

                // Lock account after 5 failed attempts. Admin must reset password/unlock.
                if (user.loginAttempts >= maxAttempts) {
                    user.status = "Locked";
                    user.lockUntil = null;
                    await user.save();
                    return res.status(423).json({
                        message: "Too many failed attempts. Your account has been locked. Contact administrator."
                    });
                }

                await user.save();
                return res.status(401).json({
                    message: `Invalid credentials. ${maxAttempts - user.loginAttempts} attempt(s) remaining before account lock.`
                });
            }
            return res.status(401).json({ message: "Invalid credentials" });
        }

        // Login success - Reset attempts and lockout
        if (!isAdminLogin) {
            user.loginAttempts = 0;
            user.lockUntil = null;
        }

        // Get user permissions (for system admin, this will return all permissions)
        const permissionData = await getUserPermissions(user._id, isSystemAdmin);

        // Extract permissions object from the response
        const permissions = permissionData?.permissions || {};

        // Update last login
        const loginIp = getClientIp(req);
        user.lastLogin = new Date();
        user.lastLoginIp = loginIp || user.lastLoginIp || '';
        await user.save();

        // Long-lived JWT; session end is enforced by frontend idle logout (1 hour of inactivity).
        const token = jwt.sign(
            { id: user._id },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        // Find associated EmployeeBasic record to get its ObjectId
        let employeeObjectId = null;
        if (user.employeeId) {
            const emp = await EmployeeBasic.findOne({ employeeId: user.employeeId }).select('_id');
            if (emp) employeeObjectId = emp._id;
        }

        recordActivityAsync({
            req,
            module: 'Settings',
            action: 'login',
            entityType: 'User',
            entityId: String(user._id),
            summary: `logged in${loginIp ? ` from IP ${loginIp}` : ''}`,
            viewHref: '/Settings/User',
            ip: loginIp,
            actor: {
                userId: user._id,
                name: user.name || user.username || 'User',
                employeeId: user.employeeId || '',
            },
            metadata: {
                actorName: user.name || user.username || '',
                employeeId: user.employeeId || '',
                username: user.username || '',
                email: user.email || '',
            },
        });

        return res.status(200).json({
            message: "Login successful",
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                username: user.username,
                employeeId: user.employeeId,
                employeeObjectId: employeeObjectId, // Added for frontend logic
                isSystemSuperUser: isSystemAdmin,
                isAdmin: isSystemAdmin,
                isAdministrator: isSystemAdmin
            },
            permissions: permissions,
            // Top-level flags must match portal Super User only (never Flowchart Admin Officer).
            isSystemSuperUser: isSystemAdmin,
            isAdmin: isSystemAdmin,
            isAdministrator: isSystemAdmin,
        });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ message: error.message });
    }
};

export const completePasswordReset = async (req, res) => {
    try {
        const { token, password, confirmPassword } = req.body || {};

        if (!token || !password || !confirmPassword) {
            return res.status(400).json({ message: "Token, password and confirmPassword are required." });
        }
        if (password !== confirmPassword) {
            return res.status(400).json({ message: "Password and confirm password do not match." });
        }
        if (password.length < 8) {
            return res.status(400).json({ message: "Password must be at least 8 characters" });
        }
        if (!/[A-Z]/.test(password)) {
            return res.status(400).json({ message: "Password must contain at least one uppercase letter" });
        }
        if (!/[a-z]/.test(password)) {
            return res.status(400).json({ message: "Password must contain at least one lowercase letter" });
        }
        if (!/[0-9]/.test(password)) {
            return res.status(400).json({ message: "Password must contain at least one number" });
        }

        if (!process.env.JWT_SECRET) {
            return res.status(500).json({ message: "JWT secret is not configured." });
        }

        let decoded;
        try {
            decoded = jwt.verify(String(token), process.env.JWT_SECRET);
        } catch {
            return res.status(400).json({ message: "Reset link is invalid or expired." });
        }

        if (!decoded?.id || decoded?.purpose !== "password-reset") {
            return res.status(400).json({ message: "Invalid reset token." });
        }

        const user = await User.findById(decoded.id);
        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }

        if (user.password) {
            const isCurrentMatch = await bcrypt.compare(password, user.password);
            if (isCurrentMatch) {
                return res.status(400).json({ message: "New password must be different from current password." });
            }
        }

        if (user.passwordHistory && user.passwordHistory.length > 0) {
            for (const oldHash of user.passwordHistory) {
                const isHistoryMatch = await bcrypt.compare(password, oldHash);
                if (isHistoryMatch) {
                    return res.status(400).json({ message: "New password must be different from recently used passwords." });
                }
            }
        }

        const newHistory = [...(user.passwordHistory || [])];
        if (user.password) {
            newHistory.push(user.password);
            if (newHistory.length > 5) newHistory.shift();
        }

        user.password = await bcrypt.hash(password, 10);
        user.passwordHistory = newHistory;
        user.status = "Active";
        user.loginAttempts = 0;
        user.lockUntil = null;
        const newExpiry = new Date();
        newExpiry.setDate(newExpiry.getDate() + 180);
        user.passwordExpiryDate = newExpiry;
        await user.save();

        return res.status(200).json({ message: "Password updated successfully. You can now login." });
    } catch (error) {
        console.error("completePasswordReset error:", error);
        return res.status(500).json({ message: error.message || "Failed to reset password." });
    }
};


//her is hashed password compared so we have to set the password hash when the user generated by the admin 