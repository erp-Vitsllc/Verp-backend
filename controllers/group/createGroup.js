import Group from "../../models/Group.js";
import User from "../../models/User.js";
import { isUserAdministrator, getAllPermissions } from "../../services/permissionService.js";
import { escapeRegex } from "../../utils/regexHelper.js";

// Create new group
export const createGroup = async (req, res) => {
    try {
        const { name: rawName, users = [], permissions = {}, status = 'Active' } = req.body;
        const userId = req.user?.id;

        // Strict type check to satisfy Snyk "Externally-controlled format string"
        if (typeof rawName !== 'string') {
            return res.status(400).json({ message: "Invalid group name type" });
        }
        const name = rawName.trim();

        if (name === '') {
            return res.status(400).json({
                message: "Group name is required"
            });
        }

        // Check if trying to create a group named "Admin"
        const normalizedName = name.trim();
        const isAdminGroup = normalizedName.toLowerCase() === 'admin';
        if (isAdminGroup) {
            // Only admin users can create Admin group
            const isAdmin = await isUserAdministrator(userId);
            if (!isAdmin) {
                return res.status(403).json({
                    message: "Only administrators can create the Admin group."
                });
            }
        }

        // Check if group name already exists
        const existingGroup = await Group.findOne({
            name: { $regex: new RegExp(`^${escapeRegex(normalizedName)}$`, 'i') }
        });
        if (existingGroup) {
            return res.status(400).json({ message: "Group name already exists" });
        }

        // Validate that all users exist and don't already have a group
        if (users && users.length > 0) {
            // Normalize users array - extract IDs if they're objects
            const userIds = users.map(user => {
                if (typeof user === 'string') {
                    return user;
                } else if (user && typeof user === 'object') {
                    // If it's an object, try to get _id or id
                    return user._id || user.id || user;
                }
                return user;
            }).filter(id => id != null); // Remove null/undefined values

            const usersToAssign = await User.find({ _id: { $in: userIds } });
            if (usersToAssign.length !== userIds.length) {
                return res.status(400).json({ message: "One or more users not found" });
            }

            // Check if any user already has a group
            const usersWithGroup = usersToAssign.filter(u => u.group);
            if (usersWithGroup.length > 0) {
                return res.status(400).json({
                    message: "One or more users are already assigned to a group"
                });
            }
        }

        // Normalize users array for storage
        const normalizedUsers = users && users.length > 0
            ? users.map(user => {
                if (typeof user === 'string') {
                    return user;
                } else if (user && typeof user === 'object') {
                    return user._id || user.id || user;
                }
                return user;
            }).filter(id => id != null)
            : [];

        // Create group with permissions as Map
        // If creating Admin group, mark it as system group and give it all permissions
        const groupPermissions = isAdminGroup ? getAllPermissions() : (permissions || {});

        const newGroup = new Group({
            name: name.trim(),
            users: normalizedUsers,
            permissions: groupPermissions,
            status: status,
            isSystemGroup: isAdminGroup
        });

        const savedGroup = await newGroup.save();

        // Update users to assign them to this group
        if (normalizedUsers && normalizedUsers.length > 0) {
            await User.updateMany(
                { _id: { $in: normalizedUsers } },
                {
                    $set: {
                        group: savedGroup._id,
                        groupName: savedGroup.name
                    }
                }
            );
        }

        return res.status(201).json({
            message: "Group created successfully",
            group: savedGroup,
        });
    } catch (error) {
        console.error('Error creating group:', error);
        if (error.code === 11000) {
            return res.status(400).json({
                message: "Group name already exists"
            });
        }
        return res.status(500).json({
            message: error.message || 'Internal server error'
        });
    }
};

