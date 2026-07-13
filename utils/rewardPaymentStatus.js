import Payment from '../models/Payment.js';
import { syncDashboardAction } from './syncDashboard.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';

/**
 * Recompute reward.paidAmount from completed payments.
 * When fully paid (cash/gift), set status to Approved (Paid) and clear Accounts pay bell.
 */
export async function applyRewardPaymentTotals(reward, { clearPayBell = true } = {}) {
    if (!reward) return null;

    const paymentQuery = {
        relatedEntityType: 'Reward',
        status: 'Completed',
        $or: [],
    };
    if (reward._id) paymentQuery.$or.push({ relatedEntityId: reward._id });
    if (reward.rewardId) paymentQuery.$or.push({ referenceId: reward.rewardId });

    let totalPaid = 0;
    if (paymentQuery.$or.length > 0) {
        const allPayments = await Payment.find(paymentQuery);
        totalPaid = allPayments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    }

    reward.paidAmount = totalPaid;

    const amount = parseFloat(reward.amount || 0);
    const isCashOrGift =
        reward.rewardType === 'Cash Reward' ||
        reward.rewardType === 'Gift Reward' ||
        amount > 0;

    if (isCashOrGift && amount > 0 && totalPaid >= amount - 0.01) {
        reward.rewardStatus = 'Approved (Paid)';
        reward.approvalStatus = 'Approved (Paid)';

        if (clearPayBell) {
            try {
                await syncDashboardAction({
                    requestId: reward._id,
                    requestType: 'Reward',
                    assignedTo: null,
                    status: 'Approved',
                    subjectEmployee: null,
                    extra1: reward.rewardType,
                    extra2: reward.amount ? `AED ${reward.amount}` : reward.title,
                });
            } catch (err) {
                console.error('[applyRewardPaymentTotals] Failed to clear pay bell:', err);
            }
        }
    }

    await reward.save();
    return reward;
}

/**
 * After management approval of cash/gift: notify Accounts to pay (bell only).
 */
export async function syncRewardPaymentDueBell(reward, subjectEmployee, requestedByName = '') {
    const amount = parseFloat(reward?.amount || 0);
    const isCashOrGift =
        reward?.rewardType === 'Cash Reward' ||
        reward?.rewardType === 'Gift Reward' ||
        amount > 0;

    if (!reward || !isCashOrGift || amount <= 0) return;

    const accountsHOD = await getDepartmentHOD('accounts', reward.employeeId);
    if (!accountsHOD?._id) {
        console.warn('[syncRewardPaymentDueBell] No Accounts HOD found for payment bell');
        return;
    }

    await syncDashboardAction({
        requestId: reward._id,
        requestType: 'Reward',
        assignedTo: accountsHOD._id,
        status: 'Pending',
        subjectEmployee,
        requestedByName,
        extra1: 'Pay reward — Approved (Not Paid)',
        extra2: `AED ${amount.toLocaleString()}`,
    });
}
