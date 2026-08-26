import DashboardAction from '../../models/DashboardAction.js';
import SalaryHistoricalProfile from '../../models/SalaryHistoricalProfile.js';
import { purgeOrphanDashboardActionRows } from '../../utils/clearDashboardActionsForRequest.js';
import {
    buildAssigneeClauses,
    resolveDashboardAssigneeContext,
} from '../../utils/resolveDashboardAssigneeContext.js';
import { SALARY_ENROLLMENT_REQUEST_TYPE } from '../../utils/salaryEnrollmentApprovalNotify.js';

/**
 * GET /api/Employee/salary-enroll/pending-inbox
 */
export const getPendingSalaryDashboardInbox = async (req, res) => {
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
            requestType: SALARY_ENROLLMENT_REQUEST_TYPE,
            $or: assigneeClauses,
        })
            .sort({ requestedDate: -1 })
            .limit(200)
            .lean();

        const profileIds = [...new Set(rows.map((r) => String(r.requestId)).filter(Boolean))];
        const profiles = profileIds.length
            ? await SalaryHistoricalProfile.find({ _id: { $in: profileIds } })
                  .select('_id employeeId workflowStatus status')
                  .lean()
            : [];
        const profileById = Object.fromEntries(profiles.map((row) => [String(row._id), row]));
        const liveRows = await purgeOrphanDashboardActionRows(rows, profileById);

        const idsToDismiss = [];
        const actionableRows = [];
        for (const da of liveRows) {
            const profile = profileById[String(da.requestId)];
            if (String(profile?.workflowStatus || '') !== 'pending_hr') {
                if (da._id) idsToDismiss.push(da._id);
                continue;
            }
            actionableRows.push(da);
        }

        if (idsToDismiss.length) {
            await DashboardAction.updateMany(
                { _id: { $in: idsToDismiss }, status: 'Pending' },
                {
                    $set: {
                        status: 'Dismissed',
                        actionedDate: new Date(),
                        comment: 'Closed: salary profile is no longer waiting on HR approval',
                    },
                },
            );
        }

        const items = actionableRows.map((da) => {
            const profile = profileById[String(da.requestId)];
            const employeeId = profile?.employeeId || da.subjectEmployeeId || '';
            return {
                dashboardActionId: da._id,
                requestType: SALARY_ENROLLMENT_REQUEST_TYPE,
                requestedDate: da.requestedDate,
                requestedByName: da.requestedByName || '',
                subjectName: da.subjectName || employeeId,
                subjectEmployeeId: employeeId,
                extra1: da.extra1 || '',
                extra2: da.extra2 || 'Salary profile approval',
                extra3: da.extra3 || '',
                href: `/HRM/Salary/enroll/${encodeURIComponent(employeeId)}`,
                status: 'Pending',
            };
        });

        return res.json({ count: items.length, items });
    } catch (error) {
        console.error('[getPendingSalaryDashboardInbox]', error);
        return res.status(500).json({ message: 'Failed to load salary notifications.' });
    }
};
