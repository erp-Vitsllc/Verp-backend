import User from "../../models/User.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { signOrKeepAttachmentUrl } from "../../utils/s3Upload.js";
import { serializeMobileDevice } from "../../utils/userMobileDevice.js";

const USER_DETAIL_SELECT =
    "username name email companyEmail employeeId group groupName status enablePortalAccess isAdmin lastLogin lastLoginIp profilePicture createdAt mobileDevice";

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
                .select("employeeId firstName lastName email designation profilePicture")
                .lean();
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
                      designation: employee.designation,
                  }
                : null,
            designation: employee?.designation || null,
            profilePicture: await resolveProfilePicture(storedPicture),
            employeeId: isSystemAdmin ? "System Users" : user.employeeId || null,
            isSystemAdmin,
            mobileDevice: serializeMobileDevice(user),
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
