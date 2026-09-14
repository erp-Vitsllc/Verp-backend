import User from "../../models/User.js";
import Group from "../../models/Group.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { escapeRegex } from "../../utils/regexHelper.js";
import { normalizeLoginThrough } from "../../utils/loginThrough.js";
// Get all users with optional filters and pagination
export const getUsers = async (req, res) => {
    try {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 1000);
        const skip = (page - 1) * limit;

        // Build filters
        const filters = {};
        const { status, search, group } = req.query;

        if (status && status !== 'All') {
            filters.status = status;
        }

        if (group && group !== 'All') {
            filters.group = group;
        }

        if (search) {
            const regex = new RegExp(escapeRegex(search), 'i');
            filters.$or = [
                { name: regex },
                { email: regex },
                { employeeId: regex },
            ];
        }

        // Include system admin user in list (don't exclude it)
        const adminUsername = process.env.ADMIN_USERNAME || 'admin';

        // Get users with populated group
        const [users, total] = await Promise.all([
            User.find(filters)
                .select('-password') // Don't send password
                .populate('group', 'name')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            User.countDocuments(filters),
        ]);

        // Get employee designations for all users with employeeId
        const employeeIds = users
            .filter(u => u.employeeId)
            .map(u => u.employeeId);

        const employees = await EmployeeBasic.find({ employeeId: { $in: employeeIds } })
            .select('employeeId designation _id loginThrough enablePortalAccess')
            .lean();

        const designationMap = {};
        const employeeIdMap = {};
        const loginThroughMap = {};
        employees.forEach(emp => {
            designationMap[emp.employeeId] = emp.designation;
            employeeIdMap[emp.employeeId] = emp._id;
            loginThroughMap[emp.employeeId] = normalizeLoginThrough(emp);
        });

        // Format users for response
        const formattedUsers = await Promise.all(users.map(async (user, index) => {
            const designation = user.employeeId ? designationMap[user.employeeId] : null;
            const employeeObjectId = user.employeeId ? employeeIdMap[user.employeeId] : null;
            const isAdministrator = designation && designation.toLowerCase() === 'administrator';

            // Check if this is the system admin user
            const isSystemAdmin = user.username?.toLowerCase() === adminUsername.toLowerCase();

            return {
                id: user._id,
                number: skip + index + 1,
                username: user.username,
                name: user.name,
                email: user.email,
                companyEmail: user.companyEmail,
                employeeId: isSystemAdmin ? 'System Users' : (user.employeeId || '---'),
                group: isSystemAdmin ? 'NO group Member Full Access permission' : (isAdministrator ? 'Administrator' : (user.group?.name || user.groupName || '-Not Assigned-')),
                groupId: isSystemAdmin ? null : (isAdministrator ? 'administrator' : (user.group?._id || user.group || null)),
                status: user.status || 'Active',
                enablePortalAccess: user.enablePortalAccess,
                lastLogin: user.lastLogin,
                createdAt: user.createdAt,
                isAdministrator: isAdministrator,
                isSystemAdmin: isSystemAdmin,
                designation: designation || null,
                employeeObjectId: employeeObjectId || null,
                loginThrough: isSystemAdmin
                    ? { portalApp: true, web: true }
                    : (loginThroughMap[user.employeeId] || { portalApp: true, web: true }),
            };
        }));

        return res.status(200).json({
            message: "Users fetched successfully",
            users: formattedUsers,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.max(1, Math.ceil(total / limit)),
            },
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        return res.status(500).json({ message: error.message });
    }
};

