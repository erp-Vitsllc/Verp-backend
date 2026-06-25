import DashboardAction from '../../models/DashboardAction.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import Payment from '../../models/Payment.js';
import { isJwtSystemSuperUser } from '../../utils/systemSuperUser.js';
import { isUserInFlowchart } from '../../utils/getDepartmentHOD.js';

/**
 * Pending payment approval tasks for the Accounts responsible person (or portal admin).
 * @route GET /api/Payment/dashboard/pending-inbox
 */
export const getPendingPaymentDashboardInbox = async (req, res) => {
    try {
        const currentUser = req.user;
        if (!currentUser) return res.status(401).json({ message: 'Unauthorized' });

        const isAdmin = isJwtSystemSuperUser(currentUser);
        const isAccountsUser = isAdmin || (await isUserInFlowchart(currentUser, 'accounts').catch(() => false));

        if (!isAccountsUser) {
            return res.json({ count: 0, items: [] });
        }

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

        const items = rows
            .map((da) => {
                const payment = paymentById[String(da.requestId)] || null;
                if (payment && !['Processing', 'Pending'].includes(payment.status)) {
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
                    payment: payment
                        ? {
                              _id: payment._id,
                              paymentId: payment.paymentId,
                              paymentType: payment.paymentType,
                              amount: payment.amount,
                              status: payment.status,
                              paidByName: payment.paidByName,
                              paymentDate: payment.paymentDate,
                              paymentSource: payment.paymentSource,
                              referenceId: payment.referenceId,
                          }
                        : null,
                };
            })
            .filter(Boolean);

        res.json({ count: items.length, items });
    } catch (error) {
        console.error('getPendingPaymentDashboardInbox:', error);
        res.status(500).json({ message: 'Failed to load payment notifications' });
    }
};
