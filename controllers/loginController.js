import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import { getUserPermissions } from "../services/permissionService.js";


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
                    { email: 'verp@vitsllc.com' }
                ]
            });

            if (!user) {
                // Create admin user if it doesn't exist (NO PASSWORD IN DATABASE - password only in .env)
                const passwordExpiryDate = new Date();
                passwordExpiryDate.setDate(passwordExpiryDate.getDate() + 180);

                user = new User({
                    username: adminUsername.toLowerCase(),
                    name: 'Super User(System)',
                    email: 'verp@vitsllc.com',
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
                if (user.email !== 'verp@vitsllc.com') {
                    user.email = 'verp@vitsllc.com';
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
            // Regular user login
            user = await User.findOne({
                $or: [
                    { email: emailOrUsername.toLowerCase() },
                    { username: emailOrUsername }
                ],
                status: 'Active',
                enablePortalAccess: true
            });

            if (!user)
                return res.status(404).json({ message: "User not found or portal access not enabled" });

            // Check if password exists
            if (!user.password) {
                return res.status(401).json({ message: "Password not set for this user" });
            }

            // Compare password
            const validPassword = await bcrypt.compare(password, user.password);
            if (!validPassword)
                return res.status(401).json({ message: "Invalid credentials" });
        }

        // Get user permissions (for system admin, this will return all permissions)
        const permissionData = await getUserPermissions(user._id, isSystemAdmin);

        // Extract permissions object from the response
        const permissions = permissionData?.permissions || {};

        // Update last login
        user.lastLogin = new Date();
        await user.save();

        // Generate JWT token with 2 hours expiry (for inactive/offline users)
        const token = jwt.sign(
            { id: user._id },
            process.env.JWT_SECRET,
            { expiresIn: "2h" }
        );

        return res.status(200).json({
            message: "Login successful",
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                username: user.username,
                employeeId: user.employeeId,
                isAdmin: isSystemAdmin,
                isAdministrator: isSystemAdmin
            },
            permissions: permissions,
            isAdmin: isSystemAdmin || permissionData?.isAdmin || false,
            isAdministrator: isSystemAdmin || permissionData?.isAdministrator || false,
            expiresIn: "2h"
        });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ message: error.message });
    }
};


//her is hashed password compared so we have to set the password hash when the user generated by the admin 