import User from "../../models/User.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import Attendance from "../../models/Attendance.js";
import { signOrKeepAttachmentUrl } from "../../utils/s3Upload.js";
import { serializeMobileDevice, serializeWebLogin } from "../../utils/userMobileDevice.js";
import { listUserDevices } from "./userMobileDeviceController.js";
import { normalizeLoginThrough } from "../../utils/loginThrough.js";

const USER_DETAIL_SELECT =
    "username name email companyEmail employeeId group groupName status enablePortalAccess isAdmin lastLogin lastLoginIp profilePicture createdAt mobileDevice webLogin webLoginDevices";

function getDubaiDateKey(date = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Dubai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(date);
}

async function resolveProfilePicture(stored) {
    if (!stored || typeof stored !== "string") return null;
    if (stored.startsWith("data:")) return stored;
    try {
        return (await signOrKeepAttachmentUrl(stored)) || stored;
    } catch {
        return stored;
    }
}

// Get single user by ID
export const getUserById = async (req, res) => {
    try {
        const { id } = req.params;
        if (String(id || '').trim().toLowerCase() === 'devices') {
            return listUserDevices(req, res);
        }

        if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(400).json({ message: "Invalid user ID format" });
        }

        const user = await User.findById(id)
            .select(USER_DETAIL_SELECT)
            .populate("group", "name")
            .lean();

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        const adminUsername = process.env.ADMIN_USERNAME || "admin";
        const isSystemAdmin = user.username?.toLowerCase() === adminUsername.toLowerCase();

        let employee = null;
        if (user.employeeId) {
            employee = await EmployeeBasic.findOne({ employeeId: user.employeeId })
                .select("_id employeeId firstName lastName email companyEmail designation profilePicture loginThrough")
                .lean();
        }

        let todayAttendance = null;
        if (employee?._id) {
            const rec = await Attendance.findOne({
                date: getDubaiDateKey(),
                employeeMongoId: String(employee._id),
            })
                .select("date timeIn timeOut punchSource checkOutSource checkInLocation checkOutLocation statusKey statusLabel")
                .lean();
            if (rec) {
                todayAttendance = {
                    date: rec.date,
                    timeIn: rec.timeIn || "",
                    timeOut: rec.timeOut || "",
                    punchSource: rec.punchSource || "",
                    checkOutSource: rec.checkOutSource || "",
                    checkInLocation: rec.checkInLocation || null,
                    checkOutLocation: rec.checkOutLocation || null,
                    statusKey: rec.statusKey || "",
                    statusLabel: rec.statusLabel || "",
                };
            }
        }

        const storedPicture = employee?.profilePicture || user.profilePicture || null;

        const userResponse = {
            ...user,
            employee: employee
                ? {
                      employeeId: employee.employeeId,
                      firstName: employee.firstName,
                      lastName: employee.lastName,
                      email: employee.email,
                      companyEmail: employee.companyEmail || '',
                      designation: employee.designation,
                      loginThrough: normalizeLoginThrough(employee),
                  }
                : null,
            designation: employee?.designation || null,
            profilePicture: await resolveProfilePicture(storedPicture),
            employeeId: isSystemAdmin ? "System Users" : user.employeeId || null,
            isSystemAdmin,
            loginThrough: isSystemAdmin
                ? { portalApp: true, web: true }
                : normalizeLoginThrough(employee),
            mobileDevice: serializeMobileDevice(user),
            webLogin: serializeWebLogin(user),
            todayAttendance,
        };

        return res.status(200).json({
            message: "User fetched successfully",
            user: userResponse,
        });
    } catch (error) {
        console.error("Error in getUserById:", error);
        return res.status(500).json({
            message: error.message || "Internal server error",
            error: process.env.NODE_ENV === "development" ? error.stack : undefined,
        });
    }
};
