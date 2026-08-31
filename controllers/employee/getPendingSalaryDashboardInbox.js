import DashboardAction from '../../models/DashboardAction.js';
import SalaryHistoricalProfile from '../../models/SalaryHistoricalProfile.js';
import SalaryMonthDmf from '../../models/SalaryMonthDmf.js';
import { purgeOrphanDashboardActionRows } from '../../utils/clearDashboardActionsForRequest.js';
import {
    buildAssigneeClauses,
    resolveDashboardAssigneeContext,
} from '../../utils/resolveDashboardAssigneeContext.js';
import { SALARY_ENROLLMENT_REQUEST_TYPE } from '../../utils/salaryEnrollmentApprovalNotify.js';
import { SALARY_DMF_REQUEST_TYPE } from '../../utils/salaryDmfApproval.js';

function parseExtra3(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(String(value));
    } catch {
        return {};
    }
}

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
            requestType: { $in: [SALARY_ENROLLMENT_REQUEST_TYPE, SALARY_DMF_REQUEST_TYPE] },
            $or: assigneeClauses,
        })
            .sort({ requestedDate: -1 })
            .limit(200)
            .lean();

        const profileIds = [...new Set(rows.map((r) => String(r.requestId)).filter(Boolean))];
        const [profiles, monthDmfs] = await Promise.all([
            profileIds.length
                ? SalaryHistoricalProfile.find({ _id: { $in: profileIds } })
                      .select('_id employeeId workflowStatus status dmfApproval')
                      .lean()
                : [],
            profileIds.length
                ? SalaryMonthDmf.find({ _id: { $in: profileIds } })
                      .select('_id monthKey dmfApproval')
                      .lean()
                : [],
        ]);
        const profileById = Object.fromEntries(profiles.map((row) => [String(row._id), row]));
        const monthDmfById = Object.fromEntries(monthDmfs.map((row) => [String(row._id), row]));
        const liveById = { ...profileById, ...monthDmfById };
        const liveRows = await purgeOrphanDashboardActionRows(rows, liveById);

        const idsToDismiss = [];
        const actionableRows = [];
        for (const da of liveRows) {
            const type = String(da.requestType || '');
            if (type === SALARY_DMF_REQUEST_TYPE) {
                const monthRow = monthDmfById[String(da.requestId)];
                const dmfStatus = String(monthRow?.dmfApproval?.status || '');
                if (dmfStatus !== 'pending') {
                    if (da._id) idsToDismiss.push(da._id);
                    continue;
                }
                actionableRows.push(da);
                continue;
            }

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
                        comment: 'Closed: salary request is no longer waiting',
                    },
                },
            );
        }

        const items = actionableRows.map((da) => {
            const type = String(da.requestType || SALARY_ENROLLMENT_REQUEST_TYPE);
            const profile = profileById[String(da.requestId)];
            const monthRow = monthDmfById[String(da.requestId)];
            const meta = parseExtra3(da.extra3);
            const employeeId = profile?.employeeId || da.subjectEmployeeId || meta.employeeId || '';
            const monthKey = monthRow?.monthKey || meta.monthKey || '';
            const href =
                meta.href ||
                (type === SALARY_DMF_REQUEST_TYPE && monthKey
                    ? `/HRM/Salary/${encodeURIComponent(monthKey)}`
                    : employeeId
                      ? `/HRM/Salary/enroll/${encodeURIComponent(employeeId)}`
                      : '/HRM/Salary');
            return {
                dashboardActionId: da._id,
                requestType: type,
                requestedDate: da.requestedDate,
                requestedByName: da.requestedByName || '',
                subjectName: da.subjectName || employeeId || monthKey,
                subjectEmployeeId: employeeId,
                extra1: da.extra1 || '',
                extra2:
                    da.extra2 ||
                    (type === SALARY_DMF_REQUEST_TYPE ? 'DMF approval' : 'Salary profile approval'),
                extra3: da.extra3 || JSON.stringify({ href, employeeId, monthKey }),
                href,
                status: 'Pending',
            };
        });

        return res.json({ count: items.length, items });
    } catch (error) {
        console.error('[getPendingSalaryDashboardInbox]', error);
        return res.status(500).json({ message: 'Failed to load salary notifications.' });
    }
};
