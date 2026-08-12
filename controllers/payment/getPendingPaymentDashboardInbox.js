import DashboardAction from '../../models/DashboardAction.js';
import Payment from '../../models/Payment.js';
import { purgeOrphanDashboardActionRows } from '../../utils/clearDashboardActionsForRequest.js';
import { isJwtSystemSuperUser } from '../../utils/systemSuperUser.js';
import {
    buildAssigneeClauses,
    resolveDashboardAssigneeContext,
} from '../../utils/resolveDashboardAssigneeContext.js';

/**
 * Pending payment approvals for the viewer (or full queue for portal admin on own inbox).
 * Supports ?targetUserId= for team Command Center (assignee-only; never admin full queue for another employee).
 * @route GET /api/Payment/dashboard/pending-inbox
 */
export const getPendingPaymentDashboardInbox = async (req, res) => {
    try {
        const ctx = await resolveDashboardAssigneeContext(req);
        if (!ctx.ok) {
            return res.status(ctx.status || 401).json({ message: ctx.message || 'Unauthorized' });
        }

        const isAdmin = !ctx.isTargeted && isJwtSystemSuperUser(req.user);
        const assigneeClauses = buildAssigneeClauses(ctx.relevantIds, ctx.employeeIdCode);

        const query = {
            status: 'Pending',
            requestType: 'Payment Approval',
        };

        if (!isAdmin) {
            if (assigneeClauses.length === 0) {
                return res.json({ count: 0, items: [] });
            }
            query.$or = assigneeClauses;
        }

        const rows = await DashboardAction.find(query)
            .sort({ requestedDate: -1 })
            .limit(200)
            .lean();

        const paymentIds = [...new Set(rows.map((r) => String(r.requestId)).filter(Boolean))];
        const payments = paymentIds.length
            ? await Payment.find({ _id: { $in: paymentIds } })
                  .select('paymentId paymentType amount status paidByName paymentDate paymentSource description referenceId')
                  .lean()
            : [];
        const paymentById = Object.fromEntries(payments.map((p) => [String(p._id), p]));
        const liveRows = await purgeOrphanDashboardActionRows(rows, paymentById);

        const items = liveRows
            .map((da) => {
                const payment = paymentById[String(da.requestId)];
                if (!['Processing', 'Pending'].includes(payment.status)) {
                    return null;
                }
                return {
                    dashboardActionId: da._id,
                    requestType: da.requestType,
                    requestedDate: da.requestedDate,
                    requestedByName: da.requestedByName,
                    subjectName: da.subjectName || payment?.paidByName || 'Payment',
                    extra1: da.extra1 || payment?.paymentType || '',
                    extra2: da.extra2 || (payment?.amount != null ? `AED ${Number(payment.amount).toLocaleString()}` : ''),
                    requestObjectId: da.requestId,
                    payment: {
                        _id: payment._id,
                        paymentId: payment.paymentId,
                        paymentType: payment.paymentType,
                        amount: payment.amount,
                        status: payment.status,
                        paidByName: payment.paidByName,
                        paymentDate: payment.paymentDate,
                        paymentSource: payment.paymentSource,
                        referenceId: payment.referenceId,
                    },
                };
            })
            .filter(Boolean);

        res.json({ count: items.length, items });
    } catch (error) {
        console.error('getPendingPaymentDashboardInbox:', error);
        res.status(500).json({ message: 'Failed to load payment notifications' });
    }
};
