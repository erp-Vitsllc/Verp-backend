import jwt from "jsonwebtoken";
import User from "../models/User.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import { isUsernameSystemSuperUser } from "../utils/systemSuperUser.js";

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

        // Check if user still exists and is active
        const user = await User.findById(decoded.id).select('_id name username status enablePortalAccess email isAdmin companyEmail employeeId groupName');

        if (!user) {
            return res.status(401).json({ message: "User not found" });
        }

        if (user.status !== 'Active') {
            return res.status(401).json({ message: "User account is not active" });
        }

        if (!user.enablePortalAccess) {
            return res.status(401).json({ message: "Portal access is disabled for this user" });
        }

        // Find linked employee record if available (exact match, then space/case-tolerant match)
        let employeeObjectId = null;
        if (user.employeeId) {
            let emp = await EmployeeBasic.findOne({ employeeId: user.employeeId }).select('_id');
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
                    }).select('_id');
                }
            }
            if (emp) employeeObjectId = emp._id;
        }

        const isSystemSuperUser = isUsernameSystemSuperUser(user.username);

        // Attach user info to request
        req.user = {
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
            ...decoded
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
