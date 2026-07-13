import DashboardAction from '../../models/DashboardAction.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import Reward from '../../models/Reward.js';

/**
 * Pending reward dashboard actions assigned to the logged-in user
 * (requester draft send, reportee, accounts, management, payment).
 * @route GET /api/Reward/dashboard/pending-inbox
 */
export const getPendingRewardDashboardInbox = async (req, res) => {
    try {
        const currentUser = req.user;
        if (!currentUser) return res.status(401).json({ message: 'Unauthorized' });

        const manager = await EmployeeBasic.findOne({
            $or: [
                ...(currentUser.employeeObjectId ? [{ _id: currentUser.employeeObjectId }] : []),
                ...(currentUser.employeeId ? [{ employeeId: currentUser.employeeId }] : []),
            ],
        })
            .select('_id employeeId')
            .lean();

        const relevantIds = [manager?._id, currentUser.employeeObjectId, currentUser?._id].filter(Boolean);
        const targetEmployeeId = currentUser.employeeId || manager?.employeeId;

        const assigneeClauses = [
            ...(relevantIds.length ? [{ assignedTo: { $in: relevantIds } }] : []),
            ...(targetEmployeeId ? [{ assignedToEmpId: targetEmployeeId }] : []),
        ];

        if (assigneeClauses.length === 0) {
            return res.json({ count: 0, items: [] });
        }

        const rows = await DashboardAction.find({
            status: 'Pending',
            requestType: 'Reward',
            $or: assigneeClauses,
        })
            .sort({ requestedDate: -1 })
            .limit(200)
            .lean();

        const rewardIds = [...new Set(rows.map((r) => String(r.requestId)).filter(Boolean))];
        const rewards = rewardIds.length
            ? await Reward.find({ _id: { $in: rewardIds } })
                  .select('_id rewardId rewardType rewardStatus employeeId employeeName amount title')
                  .lean()
            : [];
        const rewardById = Object.fromEntries(rewards.map((r) => [String(r._id), r]));

        const items = rows.map((da) => {
            const reward = rewardById[String(da.requestId)] || null;
            const subjectLabel =
                da.subjectName ||
                reward?.employeeName ||
                'Reward request';

            return {
                dashboardActionId: da._id,
                requestType: da.requestType,
                requestedDate: da.requestedDate,
                requestedByName: da.requestedByName,
                subjectName: subjectLabel,
                extra1: da.extra1 || reward?.rewardType || '',
                extra2: da.extra2 || (reward?.amount ? `AED ${reward.amount}` : reward?.title || ''),
                extra3: da.extra3,
                requestObjectId: da.requestId,
                reward: reward
                    ? {
                          _id: reward._id,
                          rewardId: reward.rewardId,
                          rewardType: reward.rewardType,
                          rewardStatus: reward.rewardStatus,
                          employeeId: reward.employeeId,
                          employeeName: reward.employeeName,
                      }
                    : null,
            };
        });

        res.json({ count: items.length, items });
    } catch (error) {
        console.error('getPendingRewardDashboardInbox:', error);
        res.status(500).json({ message: 'Failed to load reward notifications' });
    }
};
