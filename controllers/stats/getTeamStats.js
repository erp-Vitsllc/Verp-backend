
import Loan from "../../models/Loan.js";
import Reward from "../../models/Reward.js";
import Fine from "../../models/Fine.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import mongoose from "mongoose";

/**
 * Get Aggregated Team Stats
 * Returns total counts for the entire subtree (Root + All Descendants)
 */
export const getTeamStats = async (req, res) => {
    try {
        const currentUser = req.user;
        if (!currentUser) return res.status(401).json({ message: "Unauthorized" });

        let targetEmployeeId = currentUser.employeeId;
        let targetEmail = currentUser.companyEmail;

        if (req.query.targetUserId) {
            const targetEmp = await EmployeeBasic.findById(req.query.targetUserId);
            if (targetEmp) {
                targetEmployeeId = targetEmp.employeeId;
                targetEmail = targetEmp.companyEmail;
            }
        }

        // 1. Find the Manager
        const manager = await EmployeeBasic.findOne({
            $or: [{ employeeId: targetEmployeeId }, { companyEmail: targetEmail }]
        });

        if (!manager) return res.status(200).json({ total: 0, completed: 0, overdue: 0, pending: 0, approved: 0, rejected: 0 });

        // 2. Identify Target Group: ALL Descendants (Partial Flattening)
        // The frontend table uses `getHierarchy` which returns ALL descendants (not just direct).
        // To match the table, we must iterate through EVERYONE in that hierarchy.

        const hierarchy = await EmployeeBasic.aggregate([
            { $match: { _id: manager._id } },
            {
                $graphLookup: {
                    from: "employeebasics",
                    startWith: "$_id",
                    connectFromField: "_id",
                    connectToField: "primaryReportee",
                    as: "team",
                    depthField: "depth"
                }
            },
            { $unwind: "$team" },
            {
                $project: {
                    _id: "$team._id",
                    employeeId: "$team.employeeId",
                    primaryReportee: "$team.primaryReportee"
                }
            }
        ]);

        // If the hierarchy is empty (no reportees), just return 0s (unless we want to show just manager?)
        // The table definitely shows the manager themselves if they are selected.

        let teamMembers = hierarchy;

        // 3. Include the Manager in the "Team" list
        // The frontend table logic (buildTree) often displays the root manager as the first row.
        // The user says "wanna calculate all ok displayed there", which includes the top-level user.
        // We act as if the manager is part of the list to iterate.
        teamMembers = [
            { _id: manager._id, employeeId: manager.employeeId, primaryReportee: null },
            ...hierarchy
        ];

        const combinedStats = {
            total: 0,
            completed: 0,
            overdue: 0,
            pending: 0,
            approved: 0,
            rejected: 0
        };

        const overdueDate = new Date();
        overdueDate.setDate(overdueDate.getDate() - 3);

        const isOverdue = (dateStr, status) => {
            if (status !== 'Pending') return false;
            if (!dateStr) return false;
            const d = new Date(dateStr);
            const now = new Date();
            const diffTime = Math.abs(now - d);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            return diffDays > 3;
        };

        // Iterate through EVERY member of the team (Direct AND Indirect)
        // Because the dashboard table shows them all.
        for (const reportee of teamMembers) {
            // "Reportee" here acts as the "Manager" in getUserActivityStats context
            // We need to find THEIR subordinates (Meaning the work is waiting for Reportee)

            const subReportees = await EmployeeBasic.find({ primaryReportee: reportee._id });
            const subReporteeIds = subReportees.map(r => r._id);
            const subReporteeCustomIds = subReportees.map(r => r.employeeId);

            // Queries (Copied from getUserActivityStats logic)
            const queries = [
                // Pending Profiles (Updated for Snapshot Logic)
                EmployeeBasic.find({
                    $or: [
                        { profileSubmittedTo: reportee._id, profileApprovalStatus: 'submitted' },
                        { profileSubmittedTo: null, primaryReportee: reportee._id, profileApprovalStatus: 'submitted' } // Legacy fallback
                    ]
                }),
                // Pending Notices (Updated for Snapshot Logic)
                EmployeeBasic.find({
                    $or: [
                        { 'noticeRequest.submittedTo': reportee._id, 'noticeRequest.status': 'Pending' },
                        { 'noticeRequest.submittedTo': null, primaryReportee: reportee._id, 'noticeRequest.status': 'Pending' }
                    ]
                }),
                // Pending Loans
                Loan.find({
                    $or: [
                        { submittedTo: reportee._id, status: 'Pending' },
                        { submittedTo: null, employeeObjectId: reportee._id, status: 'Pending' }
                    ]
                }),
                // Pending Rewards
                Reward.find({
                    $or: [
                        { submittedTo: reportee._id, rewardStatus: 'Pending' },
                        { submittedTo: null, employeeId: reportee.employeeId, rewardStatus: 'Pending' }
                    ]
                }),
                // Pending Fines
                Fine.find({
                    $or: [
                        { submittedTo: reportee._id, 'assignedEmployees.approvalStatus': 'Pending' },
                        // Note: Fine schema structure for assignedEmployees matches element match logic
                        { submittedTo: null, 'assignedEmployees': { $elemMatch: { employeeId: reportee.employeeId, approvalStatus: 'Pending' } } }
                    ]
                })
            ];

            const [pendingProfiles, pendingNotices, pendingLoans, pendingRewards, pendingFines] = await Promise.all(queries);

            // Actioned History (Limited to 10 each, just like getUserActivityStats)
            const myActionedLoans = await Loan.find({ approvedBy: reportee._id }).sort({ updatedAt: -1 }).limit(10);
            const myActionedNotices = await EmployeeBasic.find({ 'noticeRequest.actionedBy': reportee._id }).sort({ 'noticeRequest.actionedAt': -1 }).limit(10);

            // For Rewards/Fines we need the User object of the reportee (to match approvedBy)
            const reporteeUser = await User.findOne({ employeeId: reportee.employeeId });
            let myActionedRewards = [];
            let myActionedFines = [];

            if (reporteeUser) {
                [myActionedRewards, myActionedFines] = await Promise.all([
                    Reward.find({ approvedBy: reporteeUser._id }).sort({ updatedAt: -1 }).limit(10),
                    Fine.find({ 'assignedEmployees.approvedBy': reporteeUser._id }).sort({ updatedAt: -1 }).limit(10)
                ]);
            }

            // Combine into a list to count stats
            let items = [];

            // Add Pending
            pendingProfiles.forEach(p => items.push({ status: 'Pending', date: p.createdAt }));
            pendingNotices.forEach(p => items.push({ status: 'Pending', date: p.noticeRequest.requestedAt }));
            pendingLoans.forEach(p => items.push({ status: 'Pending', date: p.createdAt }));
            pendingRewards.forEach(p => items.push({ status: 'Pending', date: p.createdAt }));
            pendingFines.forEach(p => items.push({ status: 'Pending', date: p.createdAt })); // Approximate

            // Add Actioned
            myActionedLoans.forEach(p => items.push({ status: p.status === 'Rejected' ? 'Rejected' : 'Approved' }));
            myActionedNotices.forEach(p => items.push({ status: p.noticeRequest.status }));
            myActionedRewards.forEach(p => items.push({ status: p.rewardStatus === 'Rejected' ? 'Rejected' : 'Approved' }));

            myActionedFines.forEach(f => {
                const myEntry = f.assignedEmployees.find(e => e.approvedBy?.toString() === (reporteeUser ? reporteeUser._id.toString() : ''));
                if (myEntry) items.push({ status: myEntry.approvalStatus === 'Rejected' ? 'Rejected' : 'Approved' });
            });

            // Calculate Counts for this Reportee
            const total = items.length;
            const pending = items.filter(i => i.status === 'Pending').length;
            const approved = items.filter(i => i.status === 'Approved').length;
            const rejected = items.filter(i => i.status === 'Rejected').length;
            const completed = approved + rejected;

            // Overdue Calculation (Only for Pending)
            const overdue = items.filter(i => isOverdue(i.date, i.status)).length;

            // Add to Global Sum
            combinedStats.total += total;
            combinedStats.pending += pending;
            combinedStats.approved += approved;
            combinedStats.rejected += rejected;
            combinedStats.completed += completed;
            combinedStats.overdue += overdue;
        }

        res.status(200).json(combinedStats);

    } catch (error) {
        console.error("Get Team Stats Error:", error);
        res.status(500).json({
            message: "Failed to fetch team stats",
            error: error.message,
            stack: error.stack
        });
    }
};
