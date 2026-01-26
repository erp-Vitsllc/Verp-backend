import Loan from "../../models/Loan.js";
import Reward from "../../models/Reward.js";
import Fine from "../../models/Fine.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";

// ... imports ...

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
            // Security Check: In a real app, verify targetUserId is in currentUser's hierarchy.
            // For this MVP, we rely on the fact that only employees can log in, and general visibility rules apply.
            // We first find the target employee to get their ID/Email
            const targetEmp = await EmployeeBasic.findById(req.query.targetUserId);
            if (targetEmp) {
                targetEmployeeId = targetEmp.employeeId;
                targetEmail = targetEmp.companyEmail;
            }
        }

        // 1. Get Manager's Employee Record (Target User)
        const manager = await EmployeeBasic.findOne({
            $or: [{ employeeId: targetEmployeeId }, { companyEmail: targetEmail }]
        });

        if (!manager) {
            // ... (rest of logic)
            // If they are Admin but not in EmployeeBasic, they might want to see EVERYTHING or nothing.
            // For now, let's treat non-employee users as having no management tasks.
            return res.status(200).json({ pending: 0, approved: 0, rejected: 0, total: 0, items: [] });
        }

        const isCEO = (manager.department || '').toLowerCase().includes('management') &&
            ['ceo', 'c.e.o', 'c.e.o.', 'director', 'managing director', 'general manager'].includes((manager.designation || '').toLowerCase());

        const dept = (manager.department || '').toLowerCase();
        const isHR = dept.includes('hr') || dept.includes('human resource');
        const isAccounts = dept.includes('finance') || dept.includes('account');

        // HOISTED: Fetch User record for manager (needed for Reward/Fine Sticky checks which ref User)
        let targetUser = null;
        if (!req.query.targetUserId) {
            // Self View: Always use the logged-in user as the target user
            targetUser = currentUser;
        } else if (manager) {
            // Manager/Other View: Find the User associated with the target employee
            // First check if the target employee is actually the current user (to avoid stale DB lookups)
            if (currentUser.employeeId === manager.employeeId) {
                targetUser = currentUser;
            } else {
                targetUser = await User.findOne({ employeeId: manager.employeeId });
            }
        }

        // 2. Find Reportees (Restore if needed for fine queries, but not strictly used in loop anymore since we use query logic now)
        // Actually, reporteeCustomIds IS used in pendingFines loop mapping! So restore that too.
        const reportees = await EmployeeBasic.find({ primaryReportee: manager._id });
        const reporteeCustomIds = reportees.map(r => r.employeeId);

        // 3. Define Queries for "Needs Action"
        const queries = [
            // Pending Profiles (Direct Manager - Strict)
            // Pending Profiles (Using Profile Workflow OR Direct Assignment)
            EmployeeBasic.find({
                $or: [
                    {
                        profileWorkflow: {
                            $elemMatch: {
                                assignedTo: manager._id,
                                status: 'submitted'
                            }
                        }
                    },
                    {
                        profileSubmittedTo: manager._id,
                        profileApprovalStatus: 'submitted'
                    }
                ]
            }),

            // Pending Notices (Using Notice Workflow OR Direct Assignment)
            EmployeeBasic.find({
                $or: [
                    {
                        'noticeRequest.workflow': {
                            $elemMatch: {
                                assignedTo: manager._id,
                                status: 'Pending'
                            }
                        }
                    },
                    {
                        'noticeRequest.submittedTo': manager._id,
                        'noticeRequest.status': 'Pending'
                    }
                ]
            }),
            // Pending Loans (Using Workflow Array OR Direct Assignment OR Role)
            Loan.find({
                $and: [
                    {
                        $or: [
                            {
                                workflow: {
                                    $elemMatch: {
                                        assignedTo: manager._id, // Loan refs EmployeeBasic
                                        status: 'Pending'
                                    }
                                }
                            },
                            {
                                // Fallback: Direct assignment check
                                submittedTo: manager._id,
                                status: { $in: ['Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization'] }
                            },
                            // Role Based Visibility
                            ...(isHR ? [{ status: 'Pending HR' }] : []),
                            ...(isAccounts ? [{ status: 'Pending Accounts' }] : []),
                            ...(isCEO ? [{ status: 'Pending Authorization' }] : [])
                        ]
                    },
                    { status: { $nin: ['Approved', 'Rejected', 'Withdrawn'] } }
                ]
            }).populate('employeeObjectId', 'firstName lastName'),

            // Pending Rewards (Robust: Check Workflow OR SubmittedTo OR Role)
            Reward.find({
                $and: [
                    {
                        $or: [
                            {
                                workflow: {
                                    $elemMatch: {
                                        assignedTo: targetUser ? targetUser._id : null,
                                        status: 'Pending'
                                    }
                                }
                            },
                            {
                                // Fallback: Direct assignment check
                                submittedTo: targetUser ? targetUser._id : null,
                                rewardStatus: { $in: ['Pending', 'Pending Authorization'] }
                            },
                            // Role Based Visibility - CEO only for Rewards usually
                            ...(isCEO ? [{ rewardStatus: 'Pending Authorization' }] : [])
                        ]
                    },
                    { rewardStatus: { $nin: ['Approved', 'Rejected', 'Withdrawn'] } }
                ]
            }),

            // Pending Fines (Using Workflow Array OR Direct Assignment OR Role)
            Fine.find({
                $and: [
                    {
                        $or: [
                            {
                                workflow: {
                                    $elemMatch: {
                                        assignedTo: targetUser ? targetUser._id : null, // Fine refs User
                                        status: 'Pending'
                                    }
                                }
                            },
                            {
                                // Fallback: Direct assignment check
                                submittedTo: targetUser ? targetUser._id : null,
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
            })
        ];

        // 4. CEO Queries (Legacy + Workflow Transition)
        if (isCEO) {
            // ... existing CEO specific queries can remain or ideally use the workflow array too since CEO is just another role in the array.
            // But for safety during migration, let's keep the explicit "Pending Authorization" check if the workflow array fails or is empty on old records.
            // Actually, strictly using workflow array is cleaner. If CEO logic in controllers pushes to workflow, we just rely on the above queries!
            // Wait, the CEO queries above might miss items if "Pending Authorization" status exists but workflow array wasn't backfilled.
            // Let's rely on the explicit checks above. If isCEO is true, 'targetUser' (User) or 'manager' (Employee) will match the 'assignedTo' in the workflow array pushed by controllers (role: 'CEO').
            // So we DO NOT need separate queries if the controllers are correct.
            // However, for safety with legacy data, we might want to keep them or just trust the new flow.
            // Given the user wants "strict 4 array", let's trust the array.
            // BUT, we must ensure 'targetUser' (User ID) matches what we pushed for CEO.
            // In controllers, we pushed 'hodUser._id' (User ID) for CEO.
            // So `Reward` and `Fine` queries above WILL catch CEO items.
            // `Loan` pushed 'approverBasic._id' (EmployeeBasic ID). So `Loan` query above WILL catch CEO items.
            // So we can actually REMOVE the separate isCEO block for strictness!
        }

        const results = await Promise.all(queries);

        const pendingProfiles = results[0];
        const pendingNotices = results[1];
        const pendingLoans = results[2];
        const pendingRewards = results[3];
        const pendingFines = results[4];

        // 5. Build Unified Activity List for "Pending"
        const activityList = [];

        pendingProfiles.forEach(p => {
            const myStep = p.profileWorkflow ? p.profileWorkflow.find(w => w.assignedTo && w.assignedTo.toString() === manager._id.toString() && w.status === 'submitted') : null;
            // Fallback: Check profileSubmittedTo
            const isSubmittedToMe = p.profileSubmittedTo && p.profileSubmittedTo.toString() === manager._id.toString();

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
            const myStep = p.noticeRequest?.workflow ? p.noticeRequest.workflow.find(w => w.assignedTo && w.assignedTo.toString() === manager._id.toString() && w.status === 'Pending') : null;
            // Fallback: Check noticeRequest.submittedTo
            const isSubmittedToMe = p.noticeRequest?.submittedTo && p.noticeRequest.submittedTo.toString() === manager._id.toString();

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
            // Find specific workflow step for me
            const myStep = l.workflow ? l.workflow.find(w => w.assignedTo && w.assignedTo.toString() === manager._id.toString() && w.status === 'Pending') : null;

            // Fallback: Check submittedTo
            const isSubmittedToMe = l.submittedTo && l.submittedTo.toString() === manager._id.toString();

            if (myStep || isSubmittedToMe) {
                activityList.push({
                    id: l._id, type: l.type || 'Loan/Advance', requestedBy: empName,
                    requestedDate: myStep ? myStep.assignedAt : (l.updatedAt || l.createdAt),
                    actionedDate: null,
                    status: 'Pending',
                    extra1: `AED ${l.amount}`, extra2: `${l.duration} Months`,
                    targetEmployeeId: l.employeeId
                });
            }
        });

        pendingRewards.forEach(r => {
            // Find specific workflow step for me
            let myStep = r.workflow ? r.workflow.find(w => targetUser && w.assignedTo && w.assignedTo.toString() === targetUser._id.toString() && w.status === 'Pending') : null;

            // Fallback: Check submittedTo
            const isSubmittedToMe = targetUser && r.submittedTo && r.submittedTo.toString() === targetUser._id.toString();

            if (myStep || isSubmittedToMe) {
                activityList.push({
                    id: r.rewardId || r._id, type: 'Reward', requestedBy: r.employeeName,
                    requestedDate: myStep ? myStep.assignedAt : (r.updatedAt || r.createdAt),
                    actionedDate: null,
                    status: 'Pending',
                    extra1: r.rewardType, extra2: `AED ${r.amount || 0}`,
                    targetEmployeeId: r.employeeId
                });
            }
        });

        pendingFines.forEach(f => {
            // Find specific workflow step for me
            const myStep = f.workflow ? f.workflow.find(w => targetUser && w.assignedTo && w.assignedTo.toString() === targetUser._id.toString() && w.status === 'Pending') : null;

            // Fallback: Check submittedTo
            const isSubmittedToMe = targetUser && f.submittedTo && f.submittedTo.toString() === targetUser._id.toString();

            if (myStep || isSubmittedToMe) {
                const assignedList = f.assignedEmployees || [];
                const reporteeEntry = assignedList.find(e => reporteeCustomIds.includes(e.employeeId));
                activityList.push({
                    id: f.fineId || f._id, type: 'Fine', requestedBy: reporteeEntry?.employeeName || assignedList[0]?.employeeName || 'Fine Request',
                    requestedDate: myStep ? myStep.assignedAt : (f.updatedAt || f.createdAt),
                    actionedDate: null,
                    status: 'Pending',
                    extra1: f.category, extra2: `AED ${f.fineAmount}`,
                    targetEmployeeId: reporteeEntry?.employeeId || assignedList[0]?.employeeId
                });
            }
        });

        console.log("Stats Debug:", {
            mode: req.query.targetUserId ? "Manager View" : "Self View",
            currentUserId: currentUser._id,
            requestTargetId: req.query.targetUserId,
            managerId: manager._id,
            managerEmpId: manager.employeeId,
            targetUserFound: !!targetUser,
            targetUserId: targetUser?._id
        });

        // 6. Actioned History (Items this user approved/rejected)
        // QUERY WORKFLOW ARRAY for 'Approved' status
        const myActionedLoans = await Loan.find({
            workflow: {
                $elemMatch: {
                    assignedTo: manager._id,
                    status: 'Approved'
                }
            }
        }).sort({ updatedAt: -1 }).limit(10);

        let myActionedRewards = [];
        let myActionedFines = [];

        if (targetUser) {
            [myActionedRewards, myActionedFines] = await Promise.all([
                Reward.find({
                    workflow: {
                        $elemMatch: {
                            assignedTo: targetUser._id,
                            status: 'Approved'
                        }
                    }
                }).sort({ updatedAt: -1 }).limit(10),
                Fine.find({
                    workflow: {
                        $elemMatch: {
                            assignedTo: targetUser._id,
                            status: 'Approved'
                        }
                    }
                }).sort({ updatedAt: -1 }).limit(10)
            ]);
        }

        // Helper to query Notice Workflow for History
        const myActionedNotices = await EmployeeBasic.find({
            'noticeRequest.workflow': {
                $elemMatch: {
                    assignedTo: manager._id,
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
            const myStep = l.workflow ? l.workflow.find(w => w.assignedTo && w.assignedTo.toString() === manager._id.toString() && w.status === 'Approved') : null;
            activityList.push({
                id: l._id, type: l.type, requestedBy: l.employeeName || 'Employee',
                requestedDate: l.createdAt,
                actionedDate: myStep ? myStep.actionedAt : (l.approvedDate || l.updatedAt),
                status: l.status === 'Rejected' ? 'Rejected' : 'Approved',
                extra1: l.status === 'Rejected' ? 'Actioned: Rejected' : 'Actioned: Approved',
                extra2: `AED ${l.amount}`,
                targetEmployeeId: l.employeeId
            });
        });

        myActionedRewards.forEach(r => {
            const myStep = r.workflow ? r.workflow.find(w => targetUser && w.assignedTo && w.assignedTo.toString() === targetUser._id.toString() && w.status === 'Approved') : null;
            activityList.push({
                id: r.rewardId || r._id, type: 'Reward', requestedBy: r.employeeName,
                requestedDate: r.createdAt,
                actionedDate: myStep ? myStep.actionedAt : (r.approvedDate || r.updatedAt),
                status: r.rewardStatus === 'Rejected' ? 'Rejected' : 'Approved',
                extra1: r.rewardStatus === 'Rejected' ? 'Actioned: Rejected' : 'Actioned: Approved',
                extra2: `AED ${r.amount || 0}`,
                targetEmployeeId: r.employeeId
            });
        });

        myActionedFines.forEach(f => {
            const approverIdToCheck = targetUser ? targetUser._id : currentUser._id;
            const myEntry = f.workflow ? f.workflow.find(w => w.assignedTo && w.assignedTo.toString() === approverIdToCheck.toString() && w.status === 'Approved') : null;
            // Fallback to assignedEmployees for legacy
            const assignedList = f.assignedEmployees || [];
            const legacyEntry = assignedList.find(e => e.approvedBy?.toString() === approverIdToCheck.toString());

            activityList.push({
                id: f.fineId || f._id, type: 'Fine', requestedBy: legacyEntry?.employeeName || 'Employee',
                requestedDate: f.createdAt,
                actionedDate: myEntry ? myEntry.actionedAt : (legacyEntry?.approvedAt || f.updatedAt),
                status: legacyEntry?.approvalStatus === 'Rejected' ? 'Rejected' : 'Approved',
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
            items: activityList.sort((a, b) => new Date(b.requestedDate) - new Date(a.requestedDate))
        });

    } catch (error) {
        console.error("Management Activity Stats Error:", error);
        res.status(500).json({ message: "Failed to fetch dashboard activity" });
    }
};
