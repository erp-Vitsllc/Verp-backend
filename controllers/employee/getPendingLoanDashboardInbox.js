import DashboardAction from '../../models/DashboardAction.js';
import Loan from '../../models/Loan.js';
import { purgeOrphanDashboardActionRows } from '../../utils/clearDashboardActionsForRequest.js';
import { isLoanAwaitingEmployeePayment } from '../../utils/loanStatusConstants.js';
import {
    buildAssigneeClauses,
    resolveDashboardAssigneeContext,
} from '../../utils/resolveDashboardAssigneeContext.js';
import { listPendingHubInboxItems } from '../../utils/employeeHubRequestInbox.js';

const CLOSED_LOAN_STATUSES = new Set(['Rejected', 'Cancelled', 'Draft', 'Paid']);

function loanStillNeedsInboxAction(loan) {
    if (!loan) return false;
    const status = String(loan.approvalStatus || loan.status || '').trim();
    if (!status || CLOSED_LOAN_STATUSES.has(status)) return false;
    if (status === 'Approved') return isLoanAwaitingEmployeePayment(loan);
    return /pending/i.test(status);
}

function viewerIsCurrentLoanAssignee(loan, relevantIds = []) {
    const submittedTo = loan?.submittedTo ? String(loan.submittedTo) : '';
    if (!submittedTo) return true;
    const ids = new Set((relevantIds || []).map((id) => String(id)));
    return ids.has(submittedTo);
}

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
            const hubItems = await listPendingHubInboxItems({
                assigneeIds: ctx.relevantIds,
                kinds: ['advance', 'loan'],
            });
            return res.json({ count: hubItems.length, items: hubItems });
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
                      '_id loanId type amount status approvalStatus employeeId paidAmount submittedTo',
                  )
                  .lean()
            : [];
        const loanById = Object.fromEntries(loans.map((l) => [String(l._id), l]));
        const liveRows = await purgeOrphanDashboardActionRows(rows, loanById);

        const idsToDismiss = [];
        const seenRequestIds = new Set();
        const actionableRows = [];

        for (const da of liveRows) {
            const loan = loanById[String(da.requestId)];
            if (!loanStillNeedsInboxAction(loan) || !viewerIsCurrentLoanAssignee(loan, ctx.relevantIds)) {
                if (da._id) idsToDismiss.push(da._id);
                continue;
            }
            const requestKey = String(da.requestId);
            if (seenRequestIds.has(requestKey)) {
                if (da._id) idsToDismiss.push(da._id);
                continue;
            }
            seenRequestIds.add(requestKey);
            actionableRows.push(da);
        }

        if (idsToDismiss.length) {
            await DashboardAction.updateMany(
                { _id: { $in: idsToDismiss }, status: 'Pending' },
                {
                    $set: {
                        status: 'Dismissed',
                        actionedDate: new Date(),
                        comment: 'Closed: loan is no longer waiting on this inbox action',
                    },
                },
            );
        }

        const items = actionableRows.map((da) => {
            const loan = loanById[String(da.requestId)];
            const subjectLabel =
                da.subjectName ||
                loan?.employeeId ||
                'Loan / Advance request';
            const typeLabel = loan?.type === 'Advance' ? 'Advance' : 'Loan';
            const statusLabel = String(loan?.approvalStatus || loan?.status || 'Pending').trim();
            const amountLabel =
                loan?.amount != null && loan.amount !== ''
                    ? `AED ${Number(loan.amount).toLocaleString()}`
                    : String(da.extra1 || da.extra2 || '').trim();

            return {
                dashboardActionId: da._id,
                requestType: typeLabel,
                requestedDate: da.requestedDate,
                requestedByName: da.requestedByName,
                subjectName: subjectLabel,
                extra1: amountLabel,
                extra2: statusLabel,
                extra3: da.extra3,
                status: statusLabel,
                requestObjectId: da.requestId,
                loan: {
                    _id: loan._id,
                    loanId: loan.loanId,
                    type: loan.type,
                    amount: loan.amount,
                    status: loan.status,
                    approvalStatus: loan.approvalStatus,
                    employeeId: loan.employeeId,
                    applicantName: subjectLabel,
                },
            };
        });

        const hubItems = await listPendingHubInboxItems({
            assigneeIds: ctx.relevantIds,
            kinds: ['advance', 'loan'],
        });
        const merged = [...hubItems, ...items];
        res.json({ count: merged.length, items: merged });
    } catch (error) {
        console.error('getPendingLoanDashboardInbox:', error);
        res.status(500).json({ message: 'Failed to load loan notifications' });
    }
};
