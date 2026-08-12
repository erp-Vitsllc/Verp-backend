import DashboardAction from '../../models/DashboardAction.js';
import Reward from '../../models/Reward.js';
import { purgeOrphanDashboardActionRows } from '../../utils/clearDashboardActionsForRequest.js';
import {
    buildAssigneeClauses,
    resolveDashboardAssigneeContext,
} from '../../utils/resolveDashboardAssigneeContext.js';

/**
 * Pending reward dashboard actions for the logged-in user, or for ?targetUserId= (team view).
 * @route GET /api/Reward/dashboard/pending-inbox
 */
export const getPendingRewardDashboardInbox = async (req, res) => {
    try {
        const ctx = await resolveDashboardAssigneeContext(req);
        if (!ctx.ok) {
            return res.status(ctx.status || 401).json({ message: ctx.message || 'Unauthorized' });
        }

        const assigneeClauses = buildAssigneeClauses(ctx.relevantIds, ctx.employeeIdCode);

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
        const liveRows = await purgeOrphanDashboardActionRows(rows, rewardById);

        const items = liveRows.map((da) => {
            const reward = rewardById[String(da.requestId)];
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
                reward: {
                    _id: reward._id,
                    rewardId: reward.rewardId,
                    rewardType: reward.rewardType,
                    rewardStatus: reward.rewardStatus,
                    employeeId: reward.employeeId,
                    employeeName: reward.employeeName,
                },
            };
        });

        res.json({ count: items.length, items });
    } catch (error) {
        console.error('getPendingRewardDashboardInbox:', error);
        res.status(500).json({ message: 'Failed to load reward notifications' });
    }
};
