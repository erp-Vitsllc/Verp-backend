import Group from "../../models/Group.js";
import User from "../../models/User.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";

// Delete group
export const deleteGroup = async (req, res) => {
    try {
        const { id } = req.params;

        const group = await Group.findById(id);
        if (!group) {
            return res.status(404).json({ message: "Group not found" });
        }

        // Prevent deletion of system groups (like Admin)
        if (group.isSystemGroup) {
            return res.status(403).json({ 
                message: "Cannot delete system group. This group is protected and cannot be deleted." 
            });
        }

        // Remove group reference from all users assigned to this group
        await User.updateMany(
            { group: id },
            { $set: { group: null, groupName: null } }
        );

        const groupSnapshot = group.toObject ? group.toObject() : group;
        if (await isReqUserAdmin(req.user)) {
            await awaitAdminDeletionArchive(req, {
                moduleName: 'Group',
                recordId: group.name || String(group._id),
                details: `Permission group (${(group.users || []).length} users)`,
                deletedPayload: groupSnapshot,
            });
        }

        await Group.findByIdAndDelete(id);

        return res.status(200).json({
            message: "Group deleted successfully",
        });
    } catch (error) {
        console.error('Error deleting group:', error);
        return res.status(500).json({
            message: error.message || 'Internal server error'
        });
    }
};















