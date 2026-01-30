import User from "../../models/User.js";
import Group from "../../models/Group.js";

// Delete user
export const deleteUser = async (req, res) => {
    try {
        const { id } = req.params;

        const user = await User.findById(id);
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        // Prevent deletion of system admin user
        const adminUsername = process.env.ADMIN_USERNAME || 'admin';
        const isSystemAdmin = user.username?.toLowerCase() === adminUsername.toLowerCase();

        if (isSystemAdmin) {
            return res.status(403).json({
                message: "Cannot delete system admin user. This user is protected and cannot be deleted."
            });
        }

        // Dependency Checks
        const [
            linkedEmployee,
            fineCreations,
            rewardCreations,
            loanCreations,
            fineActions,
            rewardActions,
            loanActions
        ] = await Promise.all([
            import("../../models/EmployeeBasic.js").then(m => m.default.findOne({ email: user.email })), // Check by email as well to be safe
            import("../../models/Fine.js").then(m => m.default.countDocuments({ createdBy: id })),
            import("../../models/Reward.js").then(m => m.default.countDocuments({ createdBy: id })),
            import("../../models/Loan.js").then(m => m.default.countDocuments({ createdBy: id })),
            import("../../models/Fine.js").then(m => m.default.countDocuments({
                $or: [{ approvedBy: id }, { managerApprovedBy: id }, { hrApprovedBy: id }, { accountsApprovedBy: id }]
            })),
            import("../../models/Reward.js").then(m => m.default.countDocuments({ approvedBy: id })),
            import("../../models/Loan.js").then(m => m.default.countDocuments({
                $or: [{ approvedBy: id }, { managerApprovedBy: id }, { hrApprovedBy: id }, { accountsApprovedBy: id }]
            }))
        ]);

        if (linkedEmployee) {
            return res.status(400).json({
                message: "Cannot delete user. This account is linked to an active employee profile. Deactivate the employee first."
            });
        }

        const totalActions = fineCreations + rewardCreations + loanCreations + fineActions + rewardActions + loanActions;
        if (totalActions > 0) {
            return res.status(400).json({
                message: `Cannot delete user. This account has ${totalActions} associated records (creations or approvals) in the system. Reassign or archive records before deleting the user profile.`
            });
        }

        // If user is in a group, remove them from the group's users array
        if (user.group) {
            await Group.findByIdAndUpdate(
                user.group,
                { $pull: { users: id } }
            );
        }

        // Delete the user
        await User.findByIdAndDelete(id);

        return res.status(200).json({
            message: "User deleted successfully",
        });
    } catch (error) {
        console.error('Error deleting user:', error);
        return res.status(500).json({
            message: error.message || 'Internal server error'
        });
    }
};















