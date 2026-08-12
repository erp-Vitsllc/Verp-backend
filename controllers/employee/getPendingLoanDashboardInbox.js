import DashboardAction from '../../models/DashboardAction.js';
import Loan from '../../models/Loan.js';
import { purgeOrphanDashboardActionRows } from '../../utils/clearDashboardActionsForRequest.js';
import {
    buildAssigneeClauses,
    resolveDashboardAssigneeContext,
} from '../../utils/resolveDashboardAssigneeContext.js';

/**
 * Pending loan/advance dashboard actions for the logged-in user
 * (or ?targetUserId= for team view) — same pattern as Reward / Fine / Assets.
 * Only rows assigned to this user account (DashboardAction.assignedTo).
 *
 * @route GET /api/Employee/loans/dashboard/pending-inbox
 */
export const getPendingLoanDashboardInbox = async (req, res) => {
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
            requestType: 'Loan',
            $or: assigneeClauses,
        })
            .sort({ requestedDate: -1 })
            .limit(200)
            .lean();

        const loanIds = [...new Set(rows.map((r) => String(r.requestId)).filter(Boolean))];
        const loans = loanIds.length
            ? await Loan.find({ _id: { $in: loanIds } })
                  .select(
                      '_id loanId type amount status approvalStatus employeeId applicantName paidAmount',
                  )
                  .lean()
            : [];
        const loanById = Object.fromEntries(loans.map((l) => [String(l._id), l]));
        const liveRows = await purgeOrphanDashboardActionRows(rows, loanById);

        const items = liveRows.map((da) => {
            const loan = loanById[String(da.requestId)];
            const subjectLabel =
                da.subjectName ||
                loan?.applicantName ||
                loan?.employeeId ||
                'Loan / Advance request';
            const typeLabel = loan?.type === 'Advance' ? 'Advance' : 'Loan';
            const statusLabel = String(loan?.approvalStatus || loan?.status || '').trim();

            return {
                dashboardActionId: da._id,
                requestType: da.requestType || 'Loan',
                requestedDate: da.requestedDate,
                requestedByName: da.requestedByName,
                subjectName: subjectLabel,
                extra1:
                    da.extra1 ||
                    `${typeLabel}${statusLabel ? ` · ${statusLabel}` : ''}`,
                extra2:
                    da.extra2 ||
                    (loan?.amount != null && loan.amount !== ''
                        ? `AED ${Number(loan.amount).toLocaleString()}`
                        : ''),
                extra3: da.extra3,
                requestObjectId: da.requestId,
                loan: {
                    _id: loan._id,
                    loanId: loan.loanId,
                    type: loan.type,
                    amount: loan.amount,
                    status: loan.status,
                    approvalStatus: loan.approvalStatus,
                    employeeId: loan.employeeId,
                    applicantName: loan.applicantName,
                },
            };
        });

        res.json({ count: items.length, items });
    } catch (error) {
        console.error('getPendingLoanDashboardInbox:', error);
        res.status(500).json({ message: 'Failed to load loan notifications' });
    }
};
