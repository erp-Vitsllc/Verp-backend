
import Loan from "../../models/Loan.js";
import Reward from "../../models/Reward.js";
import Fine from "../../models/Fine.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import AssetItem from "../../models/AssetItem.js";
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

        // Match Team Performance table: only employees with a portal User account.
        const empIds = [
            ...new Set(
                [manager.employeeId, ...hierarchy.map((h) => h.employeeId)]
                    .map((id) => String(id || "").trim())
                    .filter(Boolean),
            ),
        ];
        const usersWithAccounts = empIds.length
            ? await User.find({
                  employeeId: { $in: empIds },
                  status: { $nin: ["Inactive", "Suspended"] },
                  enablePortalAccess: { $ne: false },
              })
                  .select("employeeId")
                  .lean()
            : [];
        const accountEmpIds = new Set(
            usersWithAccounts.map((u) => String(u.employeeId || "").trim()).filter(Boolean),
        );

        const seenEmpIds = new Set();
        const hierarchyWithAccounts = [];
        for (const row of hierarchy) {
            const empId = String(row.employeeId || "").trim();
            if (!empId || !accountEmpIds.has(empId) || seenEmpIds.has(empId)) continue;
            seenEmpIds.add(empId);
            hierarchyWithAccounts.push(row);
        }

        // Include the manager as the root row (same as the table).
        const teamMembers = [
            { _id: manager._id, employeeId: manager.employeeId, primaryReportee: null },
            ...hierarchyWithAccounts,
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

            // IDs that represent this reportee
            const reporteeUser = await User.findOne({ employeeId: reportee.employeeId });
            const relevantIds = [reportee._id, reporteeUser?._id].filter(Boolean);

            // Queries (Unified with getUserActivityStats logic)
            const DashboardAction = await import("../../models/DashboardAction.js").then(m => m.default);
            const dashboardPendingItems = await DashboardAction.find({
                $or: [
                    { assignedTo: { $in: relevantIds } },
                    { assignedToEmpId: reportee.employeeId }
                ],
                status: 'Pending'
            }).lean();

            const queries = [
                // Pending Profiles
                EmployeeBasic.find({
                    $or: [
                        {
                            profileSubmittedTo: { $in: relevantIds },
                            profileApprovalStatus: 'submitted',
                            'profileActivationHold.heldAt': { $exists: false },
                        },
                    ],
                }),
                // Pending Notices
                EmployeeBasic.find({
                    "noticeRequest.requestedAt": { $exists: true },
                    $or: [
                        { 'noticeRequest.submittedTo': { $in: relevantIds }, 'noticeRequest.status': 'Pending' },
                        { 'noticeRequest.submittedTo': null, primaryReportee: reportee._id, 'noticeRequest.status': 'Pending' }
                    ]
                }),
                // Pending Loans
                Loan.find({
                    $or: [
                        { submittedTo: { $in: relevantIds }, status: 'Pending' },
                        { submittedTo: null, employeeObjectId: { $in: relevantIds }, status: 'Pending' }
                    ]
                }),
                // Pending Rewards
                Reward.find({
                    $or: [
                        { submittedTo: { $in: relevantIds }, rewardStatus: 'Pending' },
                        { submittedTo: null, employeeId: reportee.employeeId, rewardStatus: 'Pending' }
                    ]
                }),
                // Pending Fines
                Fine.find({
                    $or: [
                        { submittedTo: { $in: relevantIds }, 'assignedEmployees.approvalStatus': 'Pending' },
                        { submittedTo: null, 'assignedEmployees': { $elemMatch: { employeeId: reportee.employeeId, approvalStatus: 'Pending' } } }
                    ]
                }),
                // Pending Assets (Allocation Requests)
                AssetItem.find({
                    actionRequiredBy: { $in: relevantIds },
                    acceptanceStatus: 'Pending'
                })
            ];

            const [pendingProfiles, pendingNotices, pendingLoans, pendingRewards, pendingFines, pendingAssets] = await Promise.all(queries);

            // Outgoing Requests (To satisfy 'Total' count like individual dashboard)
            const outgoingQueries = [
                Loan.find({ $or: [{ employeeId: reportee.employeeId }, { createdBy: reporteeUser?._id }] }).limit(10),
                Reward.find({ $or: [{ employeeId: reportee.employeeId }, { createdBy: reporteeUser?._id }] }).limit(10),
                Fine.find({ $or: [{ "assignedEmployees.employeeId": reportee.employeeId }, { createdBy: reporteeUser?._id }] }).limit(10)
            ];
            const [myLoans, myRewards, myFines] = await Promise.all(outgoingQueries);

            // Actioned History (Items this user approved/rejected)
            const myActionedLoans = await Loan.find({
                workflow: {
                    $elemMatch: {
                        assignedTo: { $in: relevantIds },
                        status: { $in: ['Approved', 'Rejected'] }
                    }
                }
            }).sort({ updatedAt: -1 }).limit(10);

            const myActionedRewards = await Reward.find({
                workflow: {
                    $elemMatch: {
                        assignedTo: { $in: relevantIds },
                        status: { $in: ['Approved', 'Rejected'] }
                    }
                }
            }).sort({ updatedAt: -1 }).limit(10);

            const myActionedFines = await Fine.find({
                workflow: {
                    $elemMatch: {
                        assignedTo: { $in: relevantIds },
                        status: { $in: ['Approved', 'Rejected'] }
                    }
                }
            }).sort({ updatedAt: -1 }).limit(10);

            const myActionedProfiles = await EmployeeBasic.find({
                profileWorkflow: {
                    $elemMatch: {
                        assignedTo: { $in: relevantIds },
                        status: { $in: ['active', 'rejected'] }
                    }
                }
            }).sort({ updatedAt: -1 }).limit(10);

            const myActionedNotices = await EmployeeBasic.find({
                'noticeRequest.workflow': {
                    $elemMatch: {
                        assignedTo: { $in: relevantIds },
                        status: { $in: ['Approved', 'Rejected'] }
                    }
                }
            }).sort({ 'noticeRequest.actionedAt': -1 }).limit(10);

            // Build Unified List like getUserActivityStats
            const items = [];
            const seen = new Set();

            // 1. Inbox (DashboardAction + Fallbacks)
            dashboardPendingItems.forEach(i => {
                if (!seen.has(i.requestId.toString())) {
                    items.push({ status: 'Pending', scope: 'inbox', date: i.requestedDate });
                    seen.add(i.requestId.toString());
                }
            });
            pendingProfiles.forEach(p => {
                if (!seen.has(p._id.toString())) {
                    items.push({ status: 'Pending', scope: 'inbox', date: p.createdAt });
                    seen.add(p._id.toString());
                }
            });
            pendingNotices.forEach(p => {
                const id = p._id.toString() + "_notice";
                if (!seen.has(id)) {
                    items.push({ status: 'Pending', scope: 'inbox', date: p.noticeRequest?.requestedAt });
                    seen.add(id);
                }
            });
            pendingLoans.forEach(l => {
                if (!seen.has(l._id.toString())) {
                    items.push({ status: 'Pending', scope: 'inbox', date: l.createdAt });
                    seen.add(l._id.toString());
                }
            });
            pendingRewards.forEach(r => {
                if (!seen.has(r._id.toString())) {
                    items.push({ status: 'Pending', scope: 'inbox', date: r.createdAt });
                    seen.add(r._id.toString());
                }
            });
            pendingAssets.forEach(a => {
                if (!seen.has(a._id.toString())) {
                    items.push({ status: 'Pending', scope: 'inbox', date: a.updatedAt || a.createdAt });
                    seen.add(a._id.toString());
                }
            });
            pendingFines.forEach(f => {
                if (!seen.has(f._id.toString())) {
                    items.push({ status: 'Pending', scope: 'inbox', date: f.createdAt });
                    seen.add(f._id.toString());
                }
            });

            // 2. Outgoing
            myLoans.forEach(l => { if (!seen.has(l._id.toString())) { items.push({ status: 'Pending', scope: 'outgoing' }); seen.add(l._id.toString()); } });
            myRewards.forEach(r => { if (!seen.has(r._id.toString())) { items.push({ status: 'Pending', scope: 'outgoing' }); seen.add(r._id.toString()); } });
            myFines.forEach(f => { if (!seen.has(f._id.toString())) { items.push({ status: 'Pending', scope: 'outgoing' }); seen.add(f._id.toString()); } });

            // 3. Actioned History
            myActionedLoans.forEach(l => items.push({ status: l.status === 'Rejected' ? 'Rejected' : 'Approved', scope: 'inbox' }));
            myActionedRewards.forEach(r => items.push({ status: r.rewardStatus === 'Rejected' ? 'Rejected' : 'Approved', scope: 'inbox' }));
            myActionedFines.forEach(f => items.push({ status: f.fineStatus === 'Rejected' ? 'Rejected' : 'Approved', scope: 'inbox' }));
            myActionedProfiles.forEach(p => items.push({ status: p.profileApprovalStatus === 'rejected' ? 'Rejected' : 'Approved', scope: 'inbox' }));
            myActionedNotices.forEach(p => items.push({ status: p.noticeRequest?.status || 'Approved', scope: 'inbox' }));

            // Calculate Counts for this Reportee
            const inboxItems = items.filter(i => i.scope === 'inbox');
            const pendingInbox = inboxItems.filter(i => i.status === 'Pending');
            const actioned = inboxItems.filter(i => i.status === 'Approved' || i.status === 'Rejected');

            const pending = pendingInbox.length;
            const completed = actioned.length;
            const total = pending + completed;
            const approved = inboxItems.filter(i => i.status === 'Approved').length;
            const rejected = inboxItems.filter(i => i.status === 'Rejected').length;
            const overdue = pendingInbox.filter(i => isOverdue(i.date, i.status)).length;

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
