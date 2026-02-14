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

        // 1. Get Manager's Employee Record (Target User or Current User)
        // If viewing someone else's dashboard, use their employee record
        // Otherwise, use the logged-in user's employee record
        let manager;

        if (req.query.targetUserId) {
            // Viewing someone else's dashboard - use their employee record
            manager = await EmployeeBasic.findById(req.query.targetUserId);
            if (!manager) {
                console.warn(`[getUserActivityStats] No Employee record found for Target User ID: ${req.query.targetUserId}`);
                return res.status(200).json({ pending: 0, approved: 0, rejected: 0, total: 0, items: [] });
            }
        } else {
            // Viewing own dashboard - use logged-in user's employee record
            manager = await EmployeeBasic.findOne({
                $or: [
                    ...(currentUser.employeeObjectId ? [{ _id: currentUser.employeeObjectId }] : []),
                    ...(currentUser.employeeId ? [{ employeeId: currentUser.employeeId }] : [])
                ]
            });

            if (!manager) {
                console.warn(`[getUserActivityStats] No Employee record found for User: ${currentUser.email}`);
                return res.status(200).json({ pending: 0, approved: 0, rejected: 0, total: 0, items: [] });
            }
        }

        const dept = (manager.department || '').toLowerCase();
        const desig = (manager.designation || '').toLowerCase();

        const isCEO = (dept.includes('management') || dept.includes('administration') || dept.includes('board of directors')) &&
            ['ceo', 'c.e.o', 'c.e.o.', 'chief executive officer', 'director', 'managing director', 'general manager', 'gm', 'g.m', 'g.m.'].includes(desig);

        const isHR = dept.includes('hr') || dept.includes('human resource');
        const isAccounts = dept.includes('finance') || dept.includes('account');

        let targetUser;
        if (!req.query.targetUserId) {
            targetUser = currentUser;
        } else {
            // Find the User record for the target employee
            targetUser = await User.findOne({ employeeId: manager.employeeId });
            if (!targetUser) {
                console.warn(`[getUserActivityStats] No User record found for Target Employee ID: ${manager.employeeId}`);
                // Use manager data directly if no user account exists
                targetUser = { _id: manager._id, employeeId: manager.employeeId };
            }
        }

        // 2. Find Reportees
        const reportees = await EmployeeBasic.find({ primaryReportee: manager._id });
        const reporteeCustomIds = reportees.map(r => r.employeeId);

        // IDs that represent the current user (Employee record ID and User table ID)
        // This ensures items appear on dashboard whether they were assigned to the Human or the Account
        const relevantIds = [
            manager?._id,
            currentUser.employeeObjectId,
            targetUser?._id,
            currentUser?._id
        ].filter(Boolean);

        // 3. Define Queries for "Needs Action" (Using Unified DashboardAction)
        const DashboardAction = await import("../../models/DashboardAction.js").then(m => m.default);
        const dashboardPendingItems = await DashboardAction.find({
            assignedTo: { $in: relevantIds },
            status: 'Pending'
        }).lean();

        // Separate Logic for "MY REQUESTS" (Keep original behavior for these)
        const queries = [
            Loan.find({ $or: [{ employeeId: targetEmployeeId }, { createdBy: currentUser._id }] })
                .populate('createdBy', 'name')
                .sort({ createdAt: -1 }).limit(10),
            Reward.find({ $or: [{ employeeId: targetEmployeeId }, { createdBy: currentUser._id }] })
                .populate('createdBy', 'name')
                .sort({ createdAt: -1 }).limit(10),
            Fine.find({ $or: [{ "assignedEmployees.employeeId": targetEmployeeId }, { createdBy: currentUser._id }] })
                .populate('createdBy', 'name')
                .sort({ createdAt: -1 }).limit(10)
        ];

        const results = await Promise.all(queries);

        // My own items
        const myLoans = results[0];
        const myRewards = results[1];
        const myFines = results[2];

        // 5. Build Unified Activity List for "Pending" (Using DashboardAction)
        const activityList = [];
        const seenRequests = new Map(); // requestId -> status to track and deduplicate

        dashboardPendingItems.forEach(item => {
            const reqIdStr = item.requestId.toString();
            activityList.push({
                id: item.requestId,
                type: item.requestType,
                requestedBy: item.subjectName || 'Unknown',
                requestedDate: item.requestedDate,
                actionedDate: null,
                status: 'Pending',
                extra1: item.extra1,
                extra2: item.extra2,
                targetEmployeeId: item.subjectEmployeeId
            });
            seenRequests.set(reqIdStr, 'Pending');
        });

        // 5b. Add "My Own Requests" to Activity List
        myLoans.forEach(l => {
            const reqIdStr = l._id.toString();
            if (!seenRequests.has(reqIdStr)) {
                const isCreatedByMe = l.createdBy && (l.createdBy._id || l.createdBy).toString() === currentUser._id.toString();
                const creatorName = (l.createdBy && l.createdBy.name) ? l.createdBy.name : 'System';

                activityList.push({
                    id: l._id, type: l.type || 'Loan/Advance', requestedBy: isCreatedByMe ? 'Me' : creatorName,
                    requestedDate: l.createdAt,
                    actionedDate: l.approvedDate || (l.status !== 'Pending' ? l.updatedAt : null),
                    status: ['Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization', 'Draft'].includes(l.status) ? 'Pending' : l.status,
                    extra1: `AED ${l.amount}`, extra2: `${l.duration} Months`,
                    targetEmployeeId: l.employeeId,
                    employeeId: targetEmployeeId
                });
                seenRequests.set(reqIdStr, 'Pending');
            }
        });

        myRewards.forEach(r => {
            const reqIdStr = r._id.toString();
            if (!seenRequests.has(reqIdStr)) {
                const isCreatedByMe = r.createdBy && (r.createdBy._id || r.createdBy).toString() === currentUser._id.toString();
                const creatorName = (r.createdBy && r.createdBy.name) ? r.createdBy.name : 'System';

                activityList.push({
                    id: r._id, type: 'Reward', requestedBy: isCreatedByMe ? 'Me' : creatorName,
                    requestedDate: r.createdAt,
                    actionedDate: r.approvedDate || (['Approved', 'Rejected', 'Cancelled'].includes(r.rewardStatus) ? r.updatedAt : null),
                    status: ['Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization', 'Draft'].includes(r.rewardStatus) ? 'Pending' : r.rewardStatus,
                    extra1: r.rewardType, extra2: `AED ${r.amount || 0}`,
                    targetEmployeeId: r.employeeId,
                    employeeId: targetEmployeeId
                });
                seenRequests.set(reqIdStr, 'Pending');
            }
        });

        myFines.forEach(f => {
            const reqIdStr = f._id.toString();
            if (!seenRequests.has(reqIdStr)) {
                const isCreatedByMe = f.createdBy && (f.createdBy._id || f.createdBy).toString() === currentUser._id.toString();
                const creatorName = (f.createdBy && f.createdBy.name) ? f.createdBy.name : 'System';

                activityList.push({
                    id: f._id, type: 'Fine', requestedBy: isCreatedByMe ? 'Me' : creatorName,
                    requestedDate: f.createdAt,
                    actionedDate: ['Approved', 'Rejected', 'Completed'].includes(f.fineStatus) ? f.updatedAt : null,
                    status: ['Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization', 'Draft'].includes(f.fineStatus) ? 'Pending' : f.fineStatus,
                    extra1: f.category, extra2: `AED ${f.fineAmount}`,
                    targetEmployeeId: targetEmployeeId,
                    employeeId: targetEmployeeId
                });
                seenRequests.set(reqIdStr, 'Pending');
            }
        });

        // 5c. Add "My Profile/Notice Requests"
        if (manager) {
            // Profile Activation Request
            if (manager.profileApprovalStatus && manager.profileApprovalStatus !== 'draft') {
                const p = manager;
                const reqIdStr = p._id.toString();
                if (!seenRequests.has(reqIdStr)) {
                    const latestStep = p.profileWorkflow && p.profileWorkflow.length > 0
                        ? p.profileWorkflow[p.profileWorkflow.length - 1]
                        : null;

                    const status = manager.profileApprovalStatus === 'active' ? 'Approved' :
                        manager.profileApprovalStatus === 'rejected' ? 'Rejected' : 'Pending';

                    activityList.push({
                        id: p._id, type: 'Profile Activation', requestedBy: 'Me',
                        requestedDate: latestStep ? latestStep.assignedAt : (p.createdAt || p.updatedAt),
                        actionedDate: (status === 'Approved' || status === 'Rejected') ? (latestStep?.actionedAt || p.updatedAt) : null,
                        status: status,
                        extra1: p.employeeId, extra2: p.designation,
                        targetEmployeeId: p.employeeId,
                        employeeId: p.employeeId
                    });
                    seenRequests.set(reqIdStr, status);
                }
            }

            // Notice/Termination Request
            if (manager.noticeRequest && manager.noticeRequest.requestedAt) {
                const n = manager.noticeRequest;
                const reqIdStr = manager._id.toString() + "_notice"; // Use suffix since it uses same record ID
                if (!seenRequests.has(reqIdStr)) {
                    const status = ['Approved', 'Rejected'].includes(n.status) ? n.status : 'Pending';

                    activityList.push({
                        id: manager._id, type: 'Notice Request', requestedBy: 'Me',
                        requestedDate: n.requestedAt,
                        actionedDate: status !== 'Pending' ? n.actionedAt : null,
                        status: status,
                        extra1: n.reason, extra2: n.duration,
                        targetEmployeeId: manager.employeeId,
                        employeeId: manager.employeeId,
                        isNotice: true // Helper for frontend
                    });
                    seenRequests.set(reqIdStr, status);
                }
            }
        }

        console.log("Stats Debug:", {
            mode: req.query.targetUserId ? "Manager View" : "Self View",
            currentUserId: currentUser._id,
            totalItems: activityList.length
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

        // 6b. GET ACTIONED PROFILES (History)
        const myActionedProfiles = await EmployeeBasic.find({
            profileWorkflow: {
                $elemMatch: {
                    assignedTo: { $in: relevantIds },
                    status: { $in: ['active', 'rejected'] }
                }
            }
        }).sort({ updatedAt: -1 }).limit(10);

        // Helper to query Notice Workflow for History
        const myActionedNotices = await EmployeeBasic.find({
            'noticeRequest.workflow': {
                $elemMatch: {
                    assignedTo: { $in: relevantIds },
                    status: { $in: ['Approved', 'Rejected'] }
                }
            }
        }).sort({ 'noticeRequest.actionedAt': -1 }).limit(10);

        // Process these history items
        // We add these ONLY if not already in the list as Pending. 
        // If already in as pending, we prefer the 'Approved/Rejected' status for the actioner.

        myActionedNotices.forEach(p => {
            const reqIdStr = p._id.toString() + "_notice";
            const myStep = p.noticeRequest?.workflow ? p.noticeRequest.workflow.find(w => w.assignedTo && w.assignedTo.toString() === manager._id.toString() && w.status !== 'Pending') : null;
            const status = myStep ? myStep.status : p.noticeRequest?.status;

            const activityItem = {
                id: p._id, type: 'Notice Request', requestedBy: `${p.firstName} ${p.lastName}`,
                requestedDate: myStep ? myStep.assignedAt : p.noticeRequest?.requestedAt,
                actionedDate: myStep ? myStep.actionedAt : (p.noticeRequest?.actionedAt || p.updatedAt),
                status: status,
                extra1: `Actioned: ${status}`,
                extra2: p.noticeRequest?.reason,
                targetEmployeeId: p.employeeId,
                isNotice: true
            };

            if (seenRequests.has(reqIdStr)) {
                // Update existing instead of adding new
                const idx = activityList.findIndex(item => (item.id.toString() + (item.isNotice ? "_notice" : "")) === reqIdStr);
                if (idx !== -1) activityList[idx] = activityItem;
            } else {
                activityList.push(activityItem);
                seenRequests.set(reqIdStr, status);
            }
        });

        myActionedLoans.forEach(l => {
            const reqIdStr = l._id.toString();
            const myStep = l.workflow ? l.workflow.find(w => w.assignedTo && relevantIds.some(id => id.toString() === w.assignedTo.toString()) && ['Approved', 'Rejected'].includes(w.status)) : null;
            const status = (myStep?.status === 'Rejected' || l.status === 'Rejected') ? 'Rejected' : 'Approved';

            const activityItem = {
                id: l._id, type: l.type, requestedBy: l.employeeName || 'Employee',
                requestedDate: l.createdAt,
                actionedDate: myStep ? myStep.actionedAt : (l.approvedDate || l.updatedAt),
                status: status,
                extra1: `Actioned: ${status}`,
                extra2: `AED ${l.amount}`,
                targetEmployeeId: l.employeeId
            };

            if (seenRequests.has(reqIdStr)) {
                const idx = activityList.findIndex(item => item.id.toString() === reqIdStr && !item.isNotice);
                if (idx !== -1) activityList[idx] = activityItem;
            } else {
                activityList.push(activityItem);
                seenRequests.set(reqIdStr, status);
            }
        });

        myActionedRewards.forEach(r => {
            const reqIdStr = r._id.toString();
            const myStep = r.workflow ? r.workflow.find(w =>
                (['Approved', 'Rejected'].includes(w.status)) &&
                (
                    (w.assignedTo && relevantIds.some(id => id.toString() === w.assignedTo.toString())) ||
                    (isCEO && w.role === 'CEO')
                )
            ) : null;

            const isApprovedByMe = isCEO && r.approvedBy && relevantIds.some(id => id.toString() === r.approvedBy.toString());
            if (!myStep && !isApprovedByMe) return;

            const status = (myStep?.status === 'Rejected' || r.rewardStatus === 'Rejected') ? 'Rejected' : 'Approved';
            const activityItem = {
                id: r._id, type: 'Reward', requestedBy: r.employeeName,
                requestedDate: r.createdAt,
                actionedDate: myStep ? myStep.actionedAt : (r.approvedDate || r.updatedAt),
                status: status,
                extra1: `Actioned: ${status}`,
                extra2: `AED ${r.amount || 0}`,
                targetEmployeeId: r.employeeId
            };

            if (seenRequests.has(reqIdStr)) {
                const idx = activityList.findIndex(item => item.id.toString() === reqIdStr && !item.isNotice);
                if (idx !== -1) activityList[idx] = activityItem;
            } else {
                activityList.push(activityItem);
                seenRequests.set(reqIdStr, status);
            }
        });

        myActionedFines.forEach(f => {
            const reqIdStr = f._id.toString();
            const myEntry = f.workflow ? f.workflow.find(w =>
                (['Approved', 'Rejected'].includes(w.status)) &&
                (
                    (w.assignedTo && relevantIds.some(id => id.toString() === w.assignedTo.toString())) ||
                    (isCEO && w.role === 'CEO') ||
                    (isHR && w.role === 'HR') ||
                    (isAccounts && w.role === 'Accounts')
                )
            ) : null;

            const assignedList = f.assignedEmployees || [];
            const legacyEntry = assignedList.find(e => relevantIds.some(id => id.toString() === e.approvedBy?.toString()));

            const status = (myEntry?.status === 'Rejected' || legacyEntry?.approvalStatus === 'Rejected') ? 'Rejected' : 'Approved';
            const activityItem = {
                id: f._id, type: 'Fine', requestedBy: legacyEntry?.employeeName || 'Employee',
                requestedDate: f.createdAt,
                actionedDate: myEntry ? myEntry.actionedAt : (legacyEntry?.approvedAt || f.updatedAt),
                status: status,
                extra1: `Actioned: Verified`,
                extra2: `AED ${f.fineAmount}`,
                targetEmployeeId: legacyEntry?.employeeId
            };

            if (seenRequests.has(reqIdStr)) {
                const idx = activityList.findIndex(item => item.id.toString() === reqIdStr && !item.isNotice);
                if (idx !== -1) activityList[idx] = activityItem;
            } else {
                activityList.push(activityItem);
                seenRequests.set(reqIdStr, status);
            }
        });

        myActionedProfiles.forEach(p => {
            const reqIdStr = p._id.toString();
            const mySteps = p.profileWorkflow ? p.profileWorkflow.filter(w =>
                w.assignedTo && relevantIds.some(id => id.toString() === w.assignedTo.toString()) &&
                ['active', 'rejected'].includes(w.status)
            ) : [];

            mySteps.forEach(step => {
                const status = step.status === 'active' ? 'Approved' : 'Rejected';
                const activityItem = {
                    id: p._id, type: 'Profile Activation', requestedBy: `${p.firstName} ${p.lastName}`,
                    requestedDate: step.assignedAt,
                    actionedDate: step.actionedAt || p.updatedAt,
                    status: status,
                    extra1: `Actioned: ${status}`,
                    extra2: p.employeeId,
                    targetEmployeeId: p.employeeId
                };

                // Since one profile can have multiple steps, we only add/update once
                if (seenRequests.has(reqIdStr)) {
                    const idx = activityList.findIndex(item => item.id.toString() === reqIdStr && !item.isNotice);
                    if (idx !== -1) activityList[idx] = activityItem;
                } else {
                    activityList.push(activityItem);
                    seenRequests.set(reqIdStr, status);
                }
            });
        });

        // Final counts
        const pendingCount = activityList.filter(i => i.status === 'Pending').length;
        const approvedCount = activityList.filter(i => i.status === 'Approved').length;
        const rejectedCount = activityList.filter(i => (i.status === 'Rejected' || i.status === 'rejected')).length;

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
