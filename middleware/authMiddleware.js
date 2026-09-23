import jwt from "jsonwebtoken";
import User from "../models/User.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import { isUsernameSystemSuperUser } from "../utils/systemSuperUser.js";
import { normalizeLoginThrough } from "../utils/loginThrough.js";
import { isWebDeviceTrusted, noteWebDeviceIp, resolvePublicClientIp } from "../utils/userMobileDevice.js";

/**
 * Authentication middleware - verifies JWT token and attaches user to request
 */
export const protect = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(" ")[1];

        if (!token) {
            return res.status(401).json({ message: "Not authorized, no token" });
        }

        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (decoded.actor === 'employee') {
            const employee = await EmployeeBasic.findById(decoded.id).select(
                '_id firstName lastName employeeId email companyEmail profilePicture status',
            );

            const name = employee
                ? [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim()
                : decoded.employeeId || 'Employee';
            req.user = {
                ...decoded,
                id: employee ? employee._id.toString() : String(decoded.id),
                _id: employee?._id || decoded.id,
                name,
                username: employee?.employeeId || decoded.employeeId || 'employee',
                email: employee?.email || '',
                isSystemSuperUser: false,
                isAdmin: false,
                isAdministrator: false,
                companyEmail: employee?.companyEmail || '',
                employeeId: employee?.employeeId || decoded.employeeId || '',
                employeeObjectId: employee?._id || null,
                role: null,
                groupName: null,
            };
            return next();
        }

        // Check if user still exists and is active
        const user = await User.findById(decoded.id).select('_id name username status email isAdmin companyEmail employeeId groupName webLogin webLoginDevices');

        if (!user) {
            return res.status(401).json({ message: "User not found" });
        }

        if (user.status !== 'Active') {
            return res.status(401).json({ message: "User account is not active" });
        }

        // Find linked employee record if available (exact match, then space/case-tolerant match)
        let employeeObjectId = null;
        let linkedEmployee = null;
        if (user.employeeId) {
            let emp = await EmployeeBasic.findOne({ employeeId: user.employeeId }).select('_id loginThrough');
            if (!emp) {
                const norm = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
                const userNorm = norm(user.employeeId);
                if (userNorm) {
                    emp = await EmployeeBasic.findOne({
                        $expr: {
                            $eq: [
                                {
                                    $replaceAll: {
                                        input: { $toLower: { $ifNull: ['$employeeId', ''] } },
                                        find: ' ',
                                        replacement: ''
                                    }
                                },
                                userNorm
                            ]
                        }
                    }).select('_id loginThrough');
                }
            }
            if (emp) {
                employeeObjectId = emp._id;
                linkedEmployee = emp;
            }
        }

        // Fallback: link by company / portal email when User.employeeId is missing
        if (!employeeObjectId) {
            const emails = [user.companyEmail, user.email]
                .map((e) => String(e || '').trim().toLowerCase())
                .filter(Boolean);
            if (emails.length) {
                const empByEmail = await EmployeeBasic.findOne({
                    $or: [
                        { companyEmail: { $in: emails } },
                        { workEmail: { $in: emails } },
                        { email: { $in: emails } },
                    ],
                }).select('_id loginThrough');
                if (empByEmail) {
                    employeeObjectId = empByEmail._id;
                    linkedEmployee = empByEmail;
                }
            }
        }

        const isSystemSuperUser = isUsernameSystemSuperUser(user.username);
        const isAppLogin = decoded.typ === 'access';

        if (!isAppLogin) {
            const deviceId = String(req.headers['x-verp-device-id'] || '').trim();
            if (!isWebDeviceTrusted(user, deviceId)) {
                if (user.isModified?.()) await user.save();
                return res.status(401).json({
                    code: 'SESSION_TERMINATED',
                    message: 'This device was signed out. Sign in again.',
                });
            }
            noteWebDeviceIp(user, deviceId, await resolvePublicClientIp(req));
            if (user.isModified?.()) await user.save();
        }

        if (!isSystemSuperUser && linkedEmployee) {
            const through = normalizeLoginThrough(linkedEmployee);
            if (isAppLogin && !through.portalApp) {
                return res.status(403).json({
                    message: "You don't have permission to login ERP application",
                });
            }
            if (!isAppLogin && !through.web) {
                return res.status(403).json({ message: 'Web login is not enabled for this employee.' });
            }
        }

        // Attach user info to request (decoded last would overwrite live fields — keep it first)
        req.user = {
            ...decoded,
            id: user._id.toString(),
            _id: user._id,
            name: user.name,
            username: user.username,
            email: user.email,
            isSystemSuperUser,
            isAdmin: isSystemSuperUser,
            isAdministrator: isSystemSuperUser,
            companyEmail: user.companyEmail,
            employeeId: user.employeeId,
            employeeObjectId: employeeObjectId, // Linked EmployeeBasic ObjectId
            role: user.groupName || decoded.role || null,
            groupName: user.groupName,
        };

        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ message: "Invalid token" });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ message: "Token expired" });
        }
        console.error('Auth middleware error:', error);
        return res.status(401).json({ message: "Authentication failed" });
    }
};
