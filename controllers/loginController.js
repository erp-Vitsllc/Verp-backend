import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import User from "../models/User.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import WebLoginOtp from "../models/WebLoginOtp.js";
import { getUserPermissions } from "../services/permissionService.js";
import { getClientIp, recordActivityAsync } from "../utils/activityLog.js";
import { normalizeLoginThrough } from "../utils/loginThrough.js";
import { parsePunchLocation } from "../utils/attendancePunchMeta.js";
import {
    applyWebDeviceTrust,
    expireWebTrustIfNeeded,
    getWebDeviceTrust,
    isWebDeviceTrusted,
    osFromUserAgent,
    recordWebLoginOnUser,
    resolvePublicClientIp,
    serializeWebLogin,
    webDeviceLoginDenied,
} from "../utils/userMobileDevice.js";

function hashOtp(otp) {
    return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

function maskEmail(email) {
    const value = String(email || "").trim().toLowerCase();
    const at = value.indexOf("@");
    if (at < 1) return "company email";
    return `${value.slice(0, 1)}****${value.slice(at)}`;
}

async function readWebDeviceFromRequest(req) {
    const body = req?.body && typeof req.body === "object" ? req.body : {};
    const userAgent = String(req.headers?.["user-agent"] || "").slice(0, 240);
    return {
        deviceId: String(body.deviceId || body.webDeviceId || "").trim(),
        deviceName: String(body.deviceName || "").trim(),
        os: String(body.os || osFromUserAgent(userAgent)).trim(),
        userAgent,
        ipAddress: await resolvePublicClientIp(req),
    };
}

async function resolveCompanyEmail(user) {
    const fromUser = String(user?.companyEmail || "").trim().toLowerCase();
    if (fromUser) return fromUser;
    if (!user?.employeeId) return "";
    const emp = await EmployeeBasic.findOne({ employeeId: user.employeeId })
        .select("companyEmail")
        .lean();
    return String(emp?.companyEmail || "").trim().toLowerCase();
}

async function sendWebLoginOtpEmail(to, otp, name) {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) {
        const error = new Error("Email is not configured. Cannot send login OTP.");
        error.status = 502;
        throw error;
    }
    const transporter = nodemailer.createTransport({
        host: "smtp.office365.com",
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });
    await transporter.sendMail({
        from: `"VeRP Portal" <${emailUser}>`,
        to,
        subject: "Your VERP login OTP",
        html: `
            <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.6;">
                <p>Hello ${String(name || "User").replace(/[<>]/g, "")},</p>
                <p>Your VERP website login OTP is <strong>${otp}</strong>.</p>
                <p>It is valid for 5 minutes. Do not share this code.</p>
            </div>
        `,
        text: `Your VERP website login OTP is ${otp}. It is valid for 5 minutes. Do not share this code.`,
    });
}

async function sendWebLoginOtp(user, deviceId) {
    const email = await resolveCompanyEmail(user);
    if (!email) {
        const error = new Error("No company email on this user. Ask admin to add it.");
        error.status = 400;
        throw error;
    }

    await WebLoginOtp.deleteMany({ userId: user._id });
    const otp = String(crypto.randomInt(100000, 1000000));
    const otpToken = crypto.randomUUID();
    await WebLoginOtp.create({
        otpToken,
        userId: user._id,
        otpHash: hashOtp(otp),
        deviceId: String(deviceId || "").trim(),
        email,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    try {
        await sendWebLoginOtpEmail(email, otp, user.name || user.username);
    } catch (err) {
        await WebLoginOtp.deleteMany({ otpToken });
        if (err.status) throw err;
        const error = new Error(err.message || "Could not send login OTP email.");
        error.status = 502;
        throw error;
    }

    const maskedEmail = maskEmail(email);
    console.log("[webLogin] OTP sent to company email", {
        username: user.username,
        maskedEmail,
    });
    return { otpToken, maskedEmail };
}

async function completeWebLogin(req, res, { user, isSystemAdmin, webLocation, incomingDevice, fixDevice }) {
    expireWebTrustIfNeeded(user);
    const deviceDenied = webDeviceLoginDenied(user, incomingDevice, { isSystemAdmin });
    if (deviceDenied) {
        return res.status(403).json({ message: deviceDenied });
    }

    const loginIp = incomingDevice.ipAddress || getClientIp(req);
    user.lastLogin = new Date();
    user.lastLoginIp = loginIp || user.lastLoginIp || "";
    recordWebLoginOnUser(user, {
            latitude: webLocation.latitude,
            longitude: webLocation.longitude,
            location: webLocation.label || "",
            ipAddress: loginIp,
            userAgent: incomingDevice.userAgent,
            deviceId: incomingDevice.deviceId,
            deviceName: incomingDevice.deviceName,
            os: incomingDevice.os,
        });
    if (!isSystemAdmin && fixDevice) {
        applyWebDeviceTrust(user, true);
    }
    await user.save();

    const permissionData = await getUserPermissions(user._id, isSystemAdmin);
    const permissions = permissionData?.permissions || {};
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });

    let employeeObjectId = null;
    if (user.employeeId) {
        const emp = await EmployeeBasic.findOne({ employeeId: user.employeeId }).select("_id");
        if (emp) employeeObjectId = emp._id;
    }

    recordActivityAsync({
        req,
        module: "Settings",
        action: "login",
        entityType: "User",
        entityId: String(user._id),
        summary: `logged in${loginIp ? ` from IP ${loginIp}` : ""}`,
        viewHref: "/Settings/User",
        ip: loginIp,
        actor: {
            userId: user._id,
            name: user.name || user.username || "User",
            employeeId: user.employeeId || "",
        },
        metadata: {
            actorName: user.name || user.username || "",
            employeeId: user.employeeId || "",
            username: user.username || "",
            email: user.email || "",
        },
    });

    return res.status(200).json({
        needsOtp: false,
        message: "Login successful",
        token,
        user: {
            id: user._id,
            name: user.name,
            email: user.email,
            username: user.username,
            employeeId: user.employeeId,
            employeeObjectId,
            isSystemSuperUser: isSystemAdmin,
            isAdmin: isSystemAdmin,
            isAdministrator: isSystemAdmin,
        },
        permissions,
        isSystemSuperUser: isSystemAdmin,
        isAdmin: isSystemAdmin,
        isAdministrator: isSystemAdmin,
        webLogin: serializeWebLogin(user),
        deviceTrust: getWebDeviceTrust(user),
    });
}


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

            if (user.employeeId) {
                const linkedEmployee = await EmployeeBasic.findOne({ employeeId: user.employeeId })
                    .select('loginThrough')
                    .lean();
                const through = normalizeLoginThrough(linkedEmployee);
                const isAppLogin = req.body?.source === 'portalApp' || req.body?.channel === 'app';
                if (isAppLogin && !through.portalApp) {
                    return res.status(403).json({
                        message: "You don't have permission to login ERP application",
                    });
                }
                if (!isAppLogin && !through.web) {
                    return res.status(403).json({ message: 'Web login is not enabled for this employee.' });
                }
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

        const incomingDevice = await readWebDeviceFromRequest(req);
        expireWebTrustIfNeeded(user);
        const deviceDenied = webDeviceLoginDenied(user, incomingDevice, { isSystemAdmin });
        if (deviceDenied) {
            if (user.isModified?.()) await user.save();
            return res.status(403).json({ message: deviceDenied });
        }

        if (!isSystemAdmin) {
            user.loginAttempts = 0;
            user.lockUntil = null;
        }

        const trusted = isSystemAdmin || isWebDeviceTrusted(user, incomingDevice.deviceId, incomingDevice.os);
        if (!trusted) {
            if (user.isModified?.()) await user.save();
            const otp = await sendWebLoginOtp(user, incomingDevice.deviceId);
            return res.status(200).json({
                needsOtp: true,
                otpToken: otp.otpToken,
                maskedEmail: otp.maskedEmail,
                message: `OTP sent to company email ${otp.maskedEmail}`,
            });
        }

        const webLocation = parsePunchLocation(req.body, "web");
        if (!webLocation) {
            if (user.isModified?.()) await user.save();
            return res.status(400).json({
                code: "LOCATION_REQUIRED",
                message: "Location is off. Turn on location, then login.",
            });
        }
        return completeWebLogin(req, res, {
            user,
            isSystemAdmin,
            webLocation,
            incomingDevice,
            fixDevice: false,
        });
    } catch (error) {
        console.error("Login error:", error);
        return res.status(error.status || 500).json({ message: error.message });
    }
};

export const verifyWebOtp = async (req, res) => {
    try {
        const otpToken = String(req.body?.otpToken || "").trim();
        const otp = String(req.body?.otp || "").replace(/\s/g, "");
        if (!otpToken || !otp) {
            return res.status(400).json({ message: "Enter the OTP sent to your company email." });
        }

        const challenge = await WebLoginOtp.findOne({ otpToken });
        if (!challenge || challenge.expiresAt.getTime() < Date.now()) {
            return res.status(400).json({ message: "OTP expired. Sign in again." });
        }
        if (challenge.attempts >= 5) {
            await challenge.deleteOne();
            return res.status(400).json({ message: "Too many attempts. Sign in again." });
        }
        if (challenge.otpHash !== hashOtp(otp)) {
            challenge.attempts += 1;
            if (challenge.attempts >= 5) {
                await challenge.deleteOne();
                return res.status(400).json({ message: "Too many attempts. Sign in again." });
            }
            await challenge.save();
            return res.status(400).json({ message: "Wrong OTP. Check your company email and try again." });
        }

        const webLocation = parsePunchLocation(req.body, "web");
        if (!webLocation) {
            return res.status(400).json({
                message: "Location is off. Turn on location, then login.",
            });
        }

        const user = await User.findById(challenge.userId);
        if (!user || user.status !== "Active") {
            await challenge.deleteOne();
            return res.status(401).json({ message: "User is no longer allowed to sign in." });
        }

        const incomingDevice = await readWebDeviceFromRequest(req);
        if (!incomingDevice.deviceId) incomingDevice.deviceId = challenge.deviceId;
        await challenge.deleteOne();
        return completeWebLogin(req, res, {
            user,
            isSystemAdmin: false,
            webLocation,
            incomingDevice,
            fixDevice: true,
        });
    } catch (error) {
        console.error("[verifyWebOtp]", error);
        return res.status(error.status || 500).json({ message: error.message || "OTP check failed." });
    }
};

export const resendWebOtp = async (req, res) => {
    try {
        const otpToken = String(req.body?.otpToken || "").trim();
        if (!otpToken) {
            return res.status(400).json({ message: "OTP session is missing. Sign in again." });
        }
        const challenge = await WebLoginOtp.findOne({ otpToken });
        if (!challenge) {
            return res.status(400).json({ message: "OTP expired. Sign in again." });
        }
        const user = await User.findById(challenge.userId);
        if (!user) {
            return res.status(401).json({ message: "User not found" });
        }
        const otp = await sendWebLoginOtp(user, challenge.deviceId);
        return res.status(200).json({
            needsOtp: true,
            otpToken: otp.otpToken,
            maskedEmail: otp.maskedEmail,
            message: `OTP sent to company email ${otp.maskedEmail}`,
        });
    } catch (error) {
        console.error("[resendWebOtp]", error);
        return res.status(error.status || 500).json({ message: error.message || "Could not resend OTP." });
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