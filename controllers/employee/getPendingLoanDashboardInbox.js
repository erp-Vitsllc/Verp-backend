import mongoose from 'mongoose';
import DashboardAction from '../../models/DashboardAction.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import Loan from '../../models/Loan.js';
import User from '../../models/User.js';
import { purgeOrphanDashboardActionRows } from '../../utils/clearDashboardActionsForRequest.js';
import { isUserActiveInFlowchart } from '../../utils/getDepartmentHOD.js';
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

function viewerOwnsLoanStage(loan, flags) {
    const status = String(loan?.approvalStatus || loan?.status || '').trim();
    if ((status === 'Pending' || status === 'Pending HR') && flags.isHR) return true;
    if (status === 'Pending Accounts' && (flags.isAccounts || flags.isFinance)) return true;
    if (status === 'Pending Authorization' && flags.isManagement) return true;
    if (
        (status === 'Pending Payment to Employee' || status === 'Approved') &&
        (flags.isAccounts || flags.isFinance) &&
        isLoanAwaitingEmployeePayment(loan)
    ) {
        return true;
    }
    return false;
}

/**
 * submittedTo may be a User id or an Employee id for the same person.
 * Treat both as a match so a live Pending HR advance is not dropped.
 */
async function viewerIsCurrentLoanAssignee(loan, relevantIds = [], employeeIdCode = null) {
    const submittedTo = loan?.submittedTo ? String(loan.submittedTo) : '';
    if (!submittedTo) return true;
    const ids = new Set((relevantIds || []).map((id) => String(id)));
    if (ids.has(submittedTo)) return true;
    if (!mongoose.isValidObjectId(submittedTo)) return false;

    const [user, employee] = await Promise.all([
        User.findById(submittedTo).select('employeeId employeeObjectId').lean(),
        EmployeeBasic.findById(submittedTo).select('employeeId').lean(),
    ]);
    if (user?.employeeObjectId && ids.has(String(user.employeeObjectId))) return true;
    if (employeeIdCode && user?.employeeId && String(user.employeeId) === String(employeeIdCode)) return true;
    if (employeeIdCode && employee?.employeeId && String(employee.employeeId) === String(employeeIdCode)) {
        return true;
    }
    return false;
}

function loanInboxItem(loan, da, subjectLabel) {
    const typeLabel = loan?.type === 'Advance' ? 'Advance' : 'Loan';
    const statusLabel = String(loan?.approvalStatus || loan?.status || 'Pending').trim();
    const amountLabel =
        loan?.amount != null && loan.amount !== ''
            ? `AED ${Number(loan.amount).toLocaleString()}`
            : String(da?.extra1 || da?.extra2 || '').trim();
    return {
        dashboardActionId: da?._id || null,
        requestType: typeLabel,
        requestedDate: da?.requestedDate || loan?.createdAt || null,
        requestedByName: da?.requestedByName || '',
        subjectName: subjectLabel,
        extra1: amountLabel,
        extra2: statusLabel,
        extra3: da?.extra3,
        status: statusLabel,
        requestObjectId: loan?._id || da?.requestId,
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

        const subjectAuth = {
            employeeId: ctx.employeeIdCode,
            employeeObjectId: ctx.employee?._id || null,
        };
        const [isHR, isAccounts, isFinance, isManagement] = await Promise.all([
            isUserActiveInFlowchart(subjectAuth, 'hr'),
            isUserActiveInFlowchart(subjectAuth, 'accounts'),
            isUserActiveInFlowchart(subjectAuth, 'finance'),
            isUserActiveInFlowchart(subjectAuth, 'management'),
        ]);
        const stageFlags = { isHR, isAccounts, isFinance, isManagement };

        const idsToDismiss = [];
        const seenRequestIds = new Set();
        const actionableRows = [];

        for (const da of liveRows) {
            const loan = loanById[String(da.requestId)];
            const stillNeeded = loanStillNeedsInboxAction(loan);
            const assignedToViewer = stillNeeded
                ? await viewerIsCurrentLoanAssignee(loan, ctx.relevantIds, ctx.employeeIdCode)
                : false;
            const ownsStage = stillNeeded && viewerOwnsLoanStage(loan, stageFlags);
            if (!stillNeeded || (!assignedToViewer && !ownsStage)) {
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
            return loanInboxItem(loan, da, subjectLabel);
        });

        // Include the live loan when the dashboard task row was never created or was closed early.
        const stageOr = [];
        if (ctx.relevantIds.length) stageOr.push({ submittedTo: { $in: ctx.relevantIds } });
        if (isHR) {
            stageOr.push({
                approvalStatus: { $in: ['Pending', 'Pending HR'] },
                status: { $in: ['Pending', 'Pending HR'] },
            });
        }
        if (isAccounts || isFinance) {
            stageOr.push({ approvalStatus: 'Pending Accounts' });
            stageOr.push({ approvalStatus: 'Pending Payment to Employee' });
            stageOr.push({ status: 'Pending Payment to Employee' });
            stageOr.push({ approvalStatus: 'Approved', status: 'Approved' });
        }
        if (isManagement) stageOr.push({ approvalStatus: 'Pending Authorization' });

        if (stageOr.length) {
            const liveLoans = await Loan.find({ $or: stageOr })
                .select(
                    '_id loanId type amount duration status approvalStatus employeeId paidAmount submittedTo createdAt',
                )
                .sort({ createdAt: -1 })
                .limit(200)
                .lean();

            const missing = [];
            for (const loan of liveLoans) {
                const key = String(loan._id);
                if (seenRequestIds.has(key) || !loanStillNeedsInboxAction(loan)) continue;
                const assignedToViewer = await viewerIsCurrentLoanAssignee(
                    loan,
                    ctx.relevantIds,
                    ctx.employeeIdCode,
                );
                if (!assignedToViewer && !viewerOwnsLoanStage(loan, stageFlags)) continue;
                seenRequestIds.add(key);
                missing.push(loan);
            }

            if (missing.length) {
                const empIds = [...new Set(missing.map((l) => l.employeeId).filter(Boolean))];
                const people = empIds.length
                    ? await EmployeeBasic.find({ employeeId: { $in: empIds } })
                          .select('employeeId firstName lastName')
                          .lean()
                    : [];
                const personByEmpId = Object.fromEntries(people.map((p) => [p.employeeId, p]));
                const { syncDashboardAction } = await import('../../utils/syncDashboard.js');

                for (const loan of missing) {
                    const person = personByEmpId[loan.employeeId];
                    const subjectLabel = person
                        ? `${person.firstName || ''} ${person.lastName || ''}`.trim()
                        : loan.employeeId || 'Loan / Advance request';
                    try {
                        await syncDashboardAction({
                            requestId: loan._id,
                            requestType: 'Loan',
                            assignedTo: ctx.employee?._id || loan.submittedTo,
                            status: 'Pending',
                            subjectEmployee: person || { employeeId: loan.employeeId },
                            requestedByName: '',
                            extra1: loan.amount != null ? `AED ${loan.amount}` : loan.type || 'Loan',
                            extra2: `${loan.duration || ''} Months`.trim(),
                        });
                    } catch (syncErr) {
                        console.error(
                            '[getPendingLoanDashboardInbox] restore task failed:',
                            syncErr?.message || syncErr,
                        );
                    }
                    items.push(loanInboxItem(loan, null, subjectLabel));
                }
            }
        }

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
