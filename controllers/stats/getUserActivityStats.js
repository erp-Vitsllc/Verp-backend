import Loan from "../../models/Loan.js";
import Reward from "../../models/Reward.js";
import Fine from "../../models/Fine.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";

/**
 * Get Activity Stats for the Logged-in User (or a specific target user in their team)
 * aggregates data from Loans, Rewards, Fines, Profile Approvals, and Notices
 */
export const getUserActivityStats = async (req, res) => {
    try {
        const currentUser = req.user;
        if (!currentUser) return res.status(401).json({ message: "Unauthorized" });

        let targetEmployeeId = currentUser.employeeId;
        let targetEmail = currentUser.companyEmail;

        // If a target user ID is provided (viewing as someone else)
        if (req.query.targetUserId) {
            const targetEmp = await EmployeeBasic.findById(req.query.targetUserId);
            if (targetEmp) {
                targetEmployeeId = targetEmp.employeeId;
                targetEmail = targetEmp.companyEmail;
            }
        }

        // 1. Get Manager's Employee Record (Target User)
        // Find by: User ID (direct link), Employee ID, or any known email field
        const manager = await EmployeeBasic.findOne({
            $or: [
                { _id: currentUser._id || currentUser.id },
                ...(targetEmployeeId ? [{ employeeId: targetEmployeeId }] : []),
                ...(targetEmail ? [
                    { companyEmail: targetEmail },
                    { email: targetEmail },
                    { workEmail: targetEmail }
                ] : [])
            ]
        });

        if (!manager) {
            return res.status(200).json({ pending: 0, approved: 0, rejected: 0, total: 0, items: [] });
        }

        const dept = (manager.department || '').toLowerCase();
        const desig = (manager.designation || '').toLowerCase();

        const isCEO = (dept.includes('management') || dept.includes('administration') || dept.includes('board of directors')) &&
            ['ceo', 'c.e.o', 'c.e.o.', 'chief executive officer', 'director', 'managing director', 'general manager', 'gm', 'g.m', 'g.m.'].includes(desig);

        const isHR = dept.includes('hr') || dept.includes('human resource');
        const isAccounts = dept.includes('finance') || dept.includes('account');

        let targetUser = null;
        if (!req.query.targetUserId) {
            targetUser = currentUser;
        } else if (manager) {
            if (currentUser.employeeId === manager.employeeId) {
                targetUser = currentUser;
            } else {
                targetUser = await User.findOne({ employeeId: manager.employeeId });
            }
        }

        // 2. Find Reportees
        const reportees = await EmployeeBasic.find({ primaryReportee: manager._id });
        const reporteeCustomIds = reportees.map(r => r.employeeId);

        // IDs that represent the current user (Employee ID and User ID)
        // This ensures items appear on dashboard whether they were assigned to the Human or the Account
        const relevantIds = [manager._id, targetUser?._id].filter(Boolean);

        // 3. Define Queries for "Needs Action"
        const queries = [
            // Pending Profiles
            EmployeeBasic.find({
                $or: [
                    {
                        profileWorkflow: {
                            $elemMatch: { assignedTo: { $in: relevantIds }, status: 'submitted' }
                        }
                    },
                    {
                        profileSubmittedTo: { $in: relevantIds },
                        profileApprovalStatus: 'submitted'
                    }
                ]
            }),

            // Pending Notices
            EmployeeBasic.find({
                "noticeRequest.requestedAt": { $exists: true },
                $or: [
                    { 'noticeRequest.workflow': { $elemMatch: { assignedTo: { $in: relevantIds }, status: 'Pending' } } },
                    { 'noticeRequest.submittedTo': { $in: relevantIds }, 'noticeRequest.status': 'Pending' }
                ]
            }),

            // Pending Loans
            Loan.find({
                $and: [
                    {
                        $or: [
                            {
                                workflow: {
                                    $elemMatch: { assignedTo: { $in: relevantIds }, status: 'Pending' }
                                }
                            },
                            {
                                // Fallback: Direct assignment OR email-based (legacy)
                                $or: [
                                    { submittedTo: { $in: relevantIds } },
                                    { primaryReporteeEmail: { $in: [targetEmail, manager.companyEmail, manager.email].filter(Boolean) } },
                                    ...(isHR ? [{ status: 'Pending HR' }] : []),
                                    ...(isAccounts ? [{ status: 'Pending Accounts' }] : []),
                                    ...(isCEO ? [{ status: 'Pending Authorization' }] : [])
                                ]
                            }
                        ]
                    },
                    { status: { $nin: ['Approved', 'Rejected', 'Cancelled'] } }
                ]
            }).populate('employeeObjectId', 'firstName lastName'),

            // Pending Rewards
            Reward.find({
                $and: [
                    {
                        $or: [
                            {
                                workflow: {
                                    $elemMatch: { assignedTo: { $in: relevantIds }, status: 'Pending' }
                                }
                            },
                            {
                                // Fallback: Direct assignment
                                submittedTo: { $in: relevantIds },
                                rewardStatus: { $in: ['Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization'] }
                            },
                            // Role Based Visibility
                            ...(isHR ? [{ rewardStatus: 'Pending HR' }] : []),
                            ...(isAccounts ? [{ rewardStatus: 'Pending Accounts' }] : []),
                            ...(isCEO ? [{ rewardStatus: 'Pending Authorization' }] : [])
                        ]
                    },
                    { rewardStatus: { $nin: ['Approved', 'Rejected', 'Withdrawn'] } }
                ]
            }),

            // Pending Fines
            Fine.find({
                $and: [
                    {
                        $or: [
                            {
                                workflow: {
                                    $elemMatch: { assignedTo: { $in: relevantIds }, status: 'Pending' }
                                }
                            },
                            {
                                // Fallback: Direct assignment
                                submittedTo: { $in: relevantIds },
                                fineStatus: { $in: ['Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization'] }
                            },
                            // Role Based Visibility
                            ...(isHR ? [{ fineStatus: 'Pending HR' }] : []),
                            ...(isAccounts ? [{ fineStatus: 'Pending Accounts' }] : []),
                            ...(isCEO ? [{ fineStatus: 'Pending Authorization' }] : [])
                        ]
                    },
                    { fineStatus: { $nin: ['Approved', 'Rejected', 'Withdrawn', 'Completed'] } }
                ]
            }),

            // 4. MY REQUESTS (Items where I am the subject)
            Loan.find({ employeeId: targetEmployeeId }).sort({ createdAt: -1 }).limit(10),
            Reward.find({ employeeId: targetEmployeeId }).sort({ createdAt: -1 }).limit(10),
            Fine.find({ "assignedEmployees.employeeId": targetEmployeeId }).sort({ createdAt: -1 }).limit(10)
        ];

        const results = await Promise.all(queries);

        const pendingProfiles = results[0];
        const pendingNotices = results[1];
        const pendingLoans = results[2];
        const pendingRewards = results[3];
        const pendingFines = results[4];

        // My own items
        const myLoans = results[5];
        const myRewards = results[6];
        const myFines = results[7];

        // 5. Build Unified Activity List for "Pending"
        const activityList = [];

        pendingProfiles.forEach(p => {
            const myStep = p.profileWorkflow ? p.profileWorkflow.find(w => w.assignedTo && relevantIds.some(id => id.toString() === w.assignedTo.toString()) && w.status === 'submitted') : null;
            const isSubmittedToMe = p.profileSubmittedTo && relevantIds.some(id => id.toString() === p.profileSubmittedTo.toString());

            if (myStep || isSubmittedToMe) {
                activityList.push({
                    id: p._id, type: 'Profile Activation', requestedBy: `${p.firstName} ${p.lastName}`,
                    requestedDate: myStep ? myStep.assignedAt : (p.createdAt || p.updatedAt), actionedDate: null,
                    status: 'Pending', extra1: p.employeeId, extra2: p.designation,
                    targetEmployeeId: p.employeeId
                });
            }
        });

        pendingNotices.forEach(p => {
            const myStep = p.noticeRequest?.workflow ? p.noticeRequest.workflow.find(w => w.assignedTo && relevantIds.some(id => id.toString() === w.assignedTo.toString()) && w.status === 'Pending') : null;
            const isSubmittedToMe = p.noticeRequest?.submittedTo && relevantIds.some(id => id.toString() === p.noticeRequest.submittedTo.toString());

            if (myStep || isSubmittedToMe) {
                activityList.push({
                    id: p._id, type: 'Notice Request', requestedBy: `${p.firstName} ${p.lastName}`,
                    requestedDate: myStep ? myStep.assignedAt : (p.noticeRequest?.requestedAt || new Date()), actionedDate: null,
                    status: 'Pending', extra1: p.noticeRequest?.reason, extra2: p.noticeRequest?.duration,
                    targetEmployeeId: p.employeeId
                });
            }
        });

        pendingLoans.forEach(l => {
            const empName = l.employeeObjectId ? `${l.employeeObjectId.firstName} ${l.employeeObjectId.lastName}` : 'Employee';
            const myStep = l.workflow ? l.workflow.find(w => w.assignedTo && relevantIds.some(id => id.toString() === w.assignedTo.toString()) && w.status === 'Pending') : null;
            const isSubmittedToMe = l.submittedTo && relevantIds.some(id => id.toString() === l.submittedTo.toString());

            if (myStep || isSubmittedToMe) {
                activityList.push({
                    id: l._id, type: l.type || 'Loan/Advance', requestedBy: empName,
                    requestedDate: myStep ? myStep.assignedAt : (l.updatedAt || l.createdAt),
                    actionedDate: null,
                    status: ['Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization'].includes(l.status) ? 'Pending' : l.status,
                    extra1: `AED ${l.amount}`, extra2: `${l.duration} Months`,
                    targetEmployeeId: l.employeeId
                });
            }
        });

        pendingRewards.forEach(r => {
            let myStep = r.workflow ? r.workflow.find(w => w.assignedTo && relevantIds.some(id => id.toString() === w.assignedTo.toString()) && w.status === 'Pending') : null;

            // Fallback: Check submittedTo or CEO Role
            const isSubmittedToMe = (r.submittedTo && relevantIds.some(id => id.toString() === r.submittedTo.toString())) ||
                (isCEO && r.rewardStatus === 'Pending Authorization');

            if (myStep || isSubmittedToMe) {
                activityList.push({
                    id: r.rewardId || r._id, type: 'Reward', requestedBy: r.employeeName,
                    requestedDate: myStep ? myStep.assignedAt : (r.updatedAt || r.createdAt),
                    actionedDate: null,
                    status: ['Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization'].includes(r.rewardStatus) ? 'Pending' : r.rewardStatus,
                    extra1: r.rewardType, extra2: `AED ${r.amount || 0}`,
                    targetEmployeeId: r.employeeId
                });
            }
        });

        pendingFines.forEach(f => {
            const myStep = f.workflow ? f.workflow.find(w => w.assignedTo && relevantIds.some(id => id.toString() === w.assignedTo.toString()) && w.status === 'Pending') : null;

            // Fallback: Check submittedTo or CEO Role
            const isSubmittedToMe = (f.submittedTo && relevantIds.some(id => id.toString() === f.submittedTo.toString())) ||
                (isCEO && f.fineStatus === 'Pending Authorization');

            if (myStep || isSubmittedToMe) {
                const assignedList = f.assignedEmployees || [];
                const reporteeEntry = assignedList.find(e => reporteeCustomIds.includes(e.employeeId));
                activityList.push({
                    id: f.fineId || f._id, type: 'Fine', requestedBy: reporteeEntry?.employeeName || assignedList[0]?.employeeName || 'Fine Request',
                    requestedDate: myStep ? myStep.assignedAt : (f.updatedAt || f.createdAt),
                    actionedDate: null,
                    status: ['Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization'].includes(f.fineStatus) ? 'Pending' : f.fineStatus,
                    extra1: f.category, extra2: `AED ${f.fineAmount}`,
                    targetEmployeeId: reporteeEntry?.employeeId || assignedList[0]?.employeeId
                });
            }
        });

        // 5b. Add "My Own Requests" to Activity List
        myLoans.forEach(l => {
            if (!activityList.some(item => item.id.toString() === l._id.toString())) {
                activityList.push({
                    id: l._id, type: l.type || 'Loan/Advance', requestedBy: 'Me',
                    requestedDate: l.createdAt,
                    actionedDate: l.approvedDate || (l.status !== 'Pending' ? l.updatedAt : null),
                    status: l.status,
                    extra1: `AED ${l.amount}`, extra2: `${l.duration} Months`,
                    targetEmployeeId: l.employeeId
                });
            }
        });

        myRewards.forEach(r => {
            if (!activityList.some(item => (item.id.toString() === r._id.toString() || item.id.toString() === r.rewardId?.toString()))) {
                activityList.push({
                    id: r.rewardId || r._id, type: 'Reward', requestedBy: 'Me',
                    requestedDate: r.createdAt,
                    actionedDate: r.approvedDate || (['Approved', 'Rejected', 'Cancelled'].includes(r.rewardStatus) ? r.updatedAt : null),
                    status: r.rewardStatus,
                    extra1: r.rewardType, extra2: `AED ${r.amount || 0}`,
                    targetEmployeeId: r.employeeId
                });
            }
        });

        myFines.forEach(f => {
            if (!activityList.some(item => (item.id.toString() === f._id.toString() || item.id.toString() === f.fineId?.toString()))) {
                activityList.push({
                    id: f.fineId || f._id, type: 'Fine', requestedBy: 'Me',
                    requestedDate: f.createdAt,
                    actionedDate: ['Approved', 'Rejected', 'Completed'].includes(f.fineStatus) ? f.updatedAt : null,
                    status: f.fineStatus,
                    extra1: f.category, extra2: `AED ${f.fineAmount}`,
                    targetEmployeeId: targetEmployeeId
                });
            }
        });

        console.log("Stats Debug:", {
            mode: req.query.targetUserId ? "Manager View" : "Self View",
            currentUserId: currentUser._id,
            totalPending: activityList.length
        });

        // 6. Actioned History (Items this user approved/rejected)
        // Already calculated relevantIds above

        const myActionedLoans = await Loan.find({
            workflow: {
                $elemMatch: {
                    $or: [
                        { assignedTo: { $in: relevantIds } },
                        ...(isCEO ? [{ role: 'CEO' }] : []),
                        ...(isHR ? [{ role: 'HR' }] : []),
                        ...(isAccounts ? [{ role: 'Accounts' }] : [])
                    ],
                    status: { $in: ['Approved', 'Rejected'] }
                }
            }
        }).sort({ updatedAt: -1 }).limit(20);

        let myActionedRewards = [];
        let myActionedFines = [];

        // Always fetch rewards/fines, using relevantIds
        [myActionedRewards, myActionedFines] = await Promise.all([
            Reward.find({
                $or: [
                    {
                        workflow: {
                            $elemMatch: {
                                $or: [
                                    { assignedTo: { $in: relevantIds } },
                                    ...(isCEO ? [{ role: 'CEO' }] : [])
                                ],
                                status: { $in: ['Approved', 'Rejected'] }
                            }
                        }
                    },
                    ...(isCEO ? [{ approvedBy: { $in: relevantIds } }] : [])
                ]
            }).sort({ updatedAt: -1 }).limit(20),
            Fine.find({
                workflow: {
                    $elemMatch: {
                        $or: [
                            { assignedTo: { $in: relevantIds } },
                            ...(isCEO ? [{ role: 'CEO' }] : []),
                            ...(isHR ? [{ role: 'HR' }] : []),
                            ...(isAccounts ? [{ role: 'Accounts' }] : [])
                        ],
                        status: { $in: ['Approved', 'Rejected'] }
                    }
                }
            }).sort({ updatedAt: -1 }).limit(20)
        ]);

        // Helper to query Notice Workflow for History
        const myActionedNotices = await EmployeeBasic.find({
            'noticeRequest.workflow': {
                $elemMatch: {
                    assignedTo: { $in: relevantIds },
                    status: { $in: ['Approved', 'Rejected'] }
                }
            }
        }).sort({ 'noticeRequest.actionedAt': -1 }).limit(10);

        myActionedNotices.forEach(p => {
            const myStep = p.noticeRequest?.workflow ? p.noticeRequest.workflow.find(w => w.assignedTo && w.assignedTo.toString() === manager._id.toString() && w.status !== 'Pending') : null;
            activityList.push({
                id: p._id, type: 'Notice Request', requestedBy: `${p.firstName} ${p.lastName}`,
                requestedDate: myStep ? myStep.assignedAt : p.noticeRequest?.requestedAt,
                actionedDate: myStep ? myStep.actionedAt : (p.noticeRequest?.actionedAt || p.updatedAt),
                status: myStep ? myStep.status : p.noticeRequest?.status,
                extra1: `Actioned: ${myStep ? myStep.status : p.noticeRequest?.status}`,
                extra2: p.noticeRequest?.reason,
                targetEmployeeId: p.employeeId
            });
        });

        myActionedLoans.forEach(l => {
            const myStep = l.workflow ? l.workflow.find(w => w.assignedTo && relevantIds.some(id => id.toString() === w.assignedTo.toString()) && ['Approved', 'Rejected'].includes(w.status)) : null;
            activityList.push({
                id: l._id, type: l.type, requestedBy: l.employeeName || 'Employee',
                requestedDate: l.createdAt,
                actionedDate: myStep ? myStep.actionedAt : (l.approvedDate || l.updatedAt),
                status: (myStep?.status === 'Rejected' || l.status === 'Rejected') ? 'Rejected' : 'Approved',
                extra1: (myStep?.status === 'Rejected' || l.status === 'Rejected') ? 'Actioned: Rejected' : 'Actioned: Approved',
                extra2: `AED ${l.amount}`,
                targetEmployeeId: l.employeeId
            });
        });

        myActionedRewards.forEach(r => {
            const myStep = r.workflow ? r.workflow.find(w =>
                (['Approved', 'Rejected'].includes(w.status)) &&
                (
                    (w.assignedTo && relevantIds.some(id => id.toString() === w.assignedTo.toString())) ||
                    (isCEO && w.role === 'CEO')
                )
            ) : null;

            // If I am CEO and approvedBy matches me, but no workflow step found, assume Approved
            const isApprovedByMe = isCEO && r.approvedBy && relevantIds.some(id => id.toString() === r.approvedBy.toString());

            if (!myStep && !isApprovedByMe) return; // Skip if not actioned by me

            activityList.push({
                id: r.rewardId || r._id, type: 'Reward', requestedBy: r.employeeName,
                requestedDate: r.createdAt,
                actionedDate: myStep ? myStep.actionedAt : (r.approvedDate || r.updatedAt),
                status: (myStep?.status === 'Rejected' || r.rewardStatus === 'Rejected') ? 'Rejected' : 'Approved',
                extra1: (myStep?.status === 'Rejected' || r.rewardStatus === 'Rejected') ? 'Actioned: Rejected' : 'Actioned: Approved',
                extra2: `AED ${r.amount || 0}`,
                targetEmployeeId: r.employeeId
            });
        });

        myActionedFines.forEach(f => {
            const myEntry = f.workflow ? f.workflow.find(w =>
                (['Approved', 'Rejected'].includes(w.status)) &&
                (
                    (w.assignedTo && relevantIds.some(id => id.toString() === w.assignedTo.toString())) ||
                    (isCEO && w.role === 'CEO') ||
                    (isHR && w.role === 'HR') ||
                    (isAccounts && w.role === 'Accounts')
                )
            ) : null;

            // Fallback to assignedEmployees for legacy
            const assignedList = f.assignedEmployees || [];
            const legacyEntry = assignedList.find(e => relevantIds.some(id => id.toString() === e.approvedBy?.toString()));

            activityList.push({
                id: f.fineId || f._id, type: 'Fine', requestedBy: legacyEntry?.employeeName || 'Employee',
                requestedDate: f.createdAt,
                actionedDate: myEntry ? myEntry.actionedAt : (legacyEntry?.approvedAt || f.updatedAt),
                status: (myEntry?.status === 'Rejected' || legacyEntry?.approvalStatus === 'Rejected') ? 'Rejected' : 'Approved',
                extra1: `Actioned: Verified`,
                extra2: `AED ${f.fineAmount}`,
                targetEmployeeId: legacyEntry?.employeeId
            });
        });

        // Final counts
        const pendingCount = activityList.filter(i => i.status === 'Pending').length;
        const approvedCount = activityList.filter(i => i.status === 'Approved').length;
        const rejectedCount = activityList.filter(i => i.status === 'Rejected').length;

        res.status(200).json({
            pending: pendingCount,
            approved: approvedCount,
            rejected: rejectedCount,
            total: activityList.length,
            items: activityList.sort((a, b) => {
                const dateA = new Date(a.actionedDate || a.requestedDate || 0);
                const dateB = new Date(b.actionedDate || b.requestedDate || 0);
                return dateB - dateA;
            })
        });

    } catch (error) {
        console.error("Management Activity Stats Error:", error);
        res.status(500).json({ message: "Failed to fetch dashboard activity" });
    }
};
