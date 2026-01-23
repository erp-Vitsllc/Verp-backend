import User from "../../models/User.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getUserPermissions } from "../../services/permissionService.js";

// Get single user by ID
export const getUserById = async (req, res) => {
    try {
        const { id } = req.params;

        // Validate MongoDB ObjectId format
        if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(400).json({ message: "Invalid user ID format" });
        }

        const user = await User.findById(id)
            .select('-password')
            .populate('group', 'name');

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        // Check if this is the system admin user
        const adminUsername = process.env.ADMIN_USERNAME || 'admin';
        const isSystemAdmin = user.username?.toLowerCase() === adminUsername.toLowerCase();

        // If user has employeeId, fetch employee details including designation
        let employee = null;
        let designation = null;
        if (user.employeeId) {
            try {
                employee = await EmployeeBasic.findOne({ employeeId: user.employeeId })
                    .select('employeeId firstName lastName email designation');
                if (employee) {
                    designation = employee.designation;
                }
            } catch (empError) {
                console.error('Error fetching employee:', empError);
                // Continue without employee data if fetch fails
            }
        }

        // Get user permissions
        const permissions = await getUserPermissions(id, isSystemAdmin);

        const userResponse = {
            ...user.toObject(),
            employee: employee,
            designation: designation,
            permissions: permissions,
            // Prioritize employee profile picture if linked
            profilePicture: employee?.profilePicture || user.profilePicture || null,
            // For system admin, show "System Users" instead of employeeId
            employeeId: isSystemAdmin ? 'System Users' : (user.employeeId || null),
            isSystemAdmin: isSystemAdmin
        };

        return res.status(200).json({
            message: "User fetched successfully",
            user: userResponse,
        });
    } catch (error) {
        console.error('Error in getUserById:', error);
        return res.status(500).json({
            message: error.message || "Internal server error",
            error: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

