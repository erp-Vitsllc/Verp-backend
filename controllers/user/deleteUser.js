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
            import("../../models/EmployeeBasic.js").then(m => m.default.findOne({ email: user.email })),
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

        const blockers = [];

        // Check if linked to an employee with active responsibilities
        if (linkedEmployee) {
            const [reportees, companyResponsibilities] = await Promise.all([
                import("../../models/EmployeeBasic.js").then(m => m.default.find({
                    $or: [
                        { reportingAuthority: linkedEmployee._id },
                        { primaryReportee: linkedEmployee._id },
                        { secondaryReportee: linkedEmployee._id }
                    ]
                }).select('firstName lastName employeeId')),
                import("../../models/Company.js").then(m => m.default.find({
                    "responsibilities.empObjectId": linkedEmployee._id
                }).select('name responsibilities'))
            ]);

            if (reportees.length > 0) {
                const reporteeNames = reportees.map(r => `${r.firstName} ${r.lastName} (${r.employeeId})`).slice(0, 5).join(', ');
                const moreText = reportees.length > 5 ? ` and ${reportees.length - 5} others` : '';
                blockers.push(`User is a Reporting Authority for: ${reporteeNames}${moreText}.`);
            }

            if (companyResponsibilities.length > 0) {
                companyResponsibilities.forEach(comp => {
                    const roles = comp.responsibilities
                        .filter(r => r.empObjectId?.toString() === linkedEmployee._id.toString())
                        .map(r => r.category)
                        .filter((v, i, a) => a.indexOf(v) === i); // Unique categories
                    blockers.push(`User is assigned as ${roles.join(', ')} for company "${comp.name}".`);
                });
            }
        }

        if (blockers.length > 0) {
            return res.status(400).json({
                message: `Cannot delete user. ${blockers.join(' ')} Please reassign these responsibilities before deleting the profile.`
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

        // BIDIRECTIONAL SYNC: Disable portal access on Employee profile
        if (user.employeeId) {
            try {
                const EmployeeBasic = (await import("../../models/EmployeeBasic.js")).default;
                await EmployeeBasic.findOneAndUpdate(
                    { employeeId: user.employeeId },
                    { $set: { enablePortalAccess: false } }
                );
            } catch (err) {
                console.error('[deleteUser] Error disabling portal access for:', user.employeeId, err);
            }
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















