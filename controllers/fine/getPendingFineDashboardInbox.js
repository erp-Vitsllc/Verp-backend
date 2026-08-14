import DashboardAction from '../../models/DashboardAction.js';
import Fine from '../../models/Fine.js';
import { purgeOrphanDashboardActionRows } from '../../utils/clearDashboardActionsForRequest.js';
import {
    buildAssigneeClauses,
    resolveDashboardAssigneeContext,
} from '../../utils/resolveDashboardAssigneeContext.js';
import { listPendingHubInboxItems } from '../../utils/employeeHubRequestInbox.js';

const FINE_INBOX_TYPES = ['Fine', 'Group Fine Request'];

/**
 * Pending fine dashboard actions for the logged-in user, or for ?targetUserId= (team view).
 * @route GET /api/Fine/dashboard/pending-inbox
 */
export const getPendingFineDashboardInbox = async (req, res) => {
    try {
        const ctx = await resolveDashboardAssigneeContext(req);
        if (!ctx.ok) {
            return res.status(ctx.status || 401).json({ message: ctx.message || 'Unauthorized' });
        }

        const assigneeClauses = buildAssigneeClauses(ctx.relevantIds, ctx.employeeIdCode);

        if (assigneeClauses.length === 0) {
            const hubItems = await listPendingHubInboxItems({
                assigneeIds: ctx.relevantIds,
                kinds: ['fine'],
            });
            return res.json({ count: hubItems.length, items: hubItems });
        }

        const rows = await DashboardAction.find({
            status: 'Pending',
            requestType: { $in: FINE_INBOX_TYPES },
            $or: assigneeClauses,
        })
            .sort({ requestedDate: -1 })
            .limit(200)
            .lean();

        const fineIds = [...new Set(rows.map((r) => String(r.requestId)).filter(Boolean))];
        const fines = fineIds.length
            ? await Fine.find({ _id: { $in: fineIds } })
                  .select('_id fineId fineType fineStatus assignedEmployees category')
                  .lean()
            : [];
        const fineById = Object.fromEntries(fines.map((f) => [String(f._id), f]));
        const liveRows = await purgeOrphanDashboardActionRows(rows, fineById);

        const getBaseFineId = (fid = '') => {
            const parts = String(fid).split('-');
            if (parts.length > 3) return parts.slice(0, 3).join('-');
            return fid;
        };

        const items = liveRows.map((da) => {
            const fine = fineById[String(da.requestId)];
            const isGroup = da.requestType === 'Group Fine Request';
            const subjectLabel =
                da.subjectName ||
                fine?.assignedEmployees?.[0]?.employeeName ||
                'Fine request';

            return {
                dashboardActionId: da._id,
                requestType: da.requestType,
                requestedDate: da.requestedDate,
                requestedByName: da.requestedByName,
                subjectName: subjectLabel,
                extra1: da.extra1 || fine?.fineType || '',
                extra2: da.extra2 || '',
                extra3: da.extra3,
                requestObjectId: da.requestId,
                primaryFineId: da.requestId,
                isGroup,
                fine: {
                    _id: fine._id,
                    fineId: fine.fineId,
                    baseFineId: getBaseFineId(fine.fineId),
                    fineType: fine.fineType,
                    fineStatus: fine.fineStatus,
                },
            };
        });

        const hubItems = await listPendingHubInboxItems({
            assigneeIds: ctx.relevantIds,
            kinds: ['fine'],
        });

        const merged = [...hubItems, ...items];
        res.json({ count: merged.length, items: merged });
    } catch (error) {
        console.error('getPendingFineDashboardInbox:', error);
        res.status(500).json({ message: 'Failed to load fine notifications' });
    }
};
