import Payment from '../models/Payment.js';
import { syncDashboardAction } from './syncDashboard.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';

const CLOSED_REWARD_INBOX_STATUSES = new Set([
    'Rejected',
    'Cancelled',
    'Approved (Paid)',
    'Paid',
    'Completed',
]);

/** True once Accounts has posted Zoho Expense (payment column = Billed). */
export function isRewardAccountsBilled(reward) {
    if (!reward) return false;
    const payment = String(reward.paymentStatus || '').trim();
    if (payment === 'Billed' || payment === 'Paid') return true;
    if (
        String(reward.zohoExpenseId || '').trim() ||
        String(reward.zohoJournalId || '').trim()
    ) {
        return true;
    }
    const status = String(reward.rewardStatus || reward.approvalStatus || '').trim();
    return status === 'Approved (Paid)' || status === 'Paid' || status === 'Completed';
}

/**
 * Whether a pending Reward dashboard row should stay in the bell inbox.
 * Billed / Paid rewards must not keep the old "Pay reward" task.
 */
export function rewardStillNeedsInboxAction(reward) {
    if (!reward) return false;
    if (isRewardAccountsBilled(reward)) return false;

    const status = String(reward.rewardStatus || reward.approvalStatus || '').trim();
    if (!status || CLOSED_REWARD_INBOX_STATUSES.has(status)) return false;
    if (status === 'Draft') return true;
    if (/pending/i.test(status)) return true;
    if (status === 'Approved (Not Paid)') return true;

    const amount = parseFloat(reward.amount || 0);
    const isCashOrGift =
        reward.rewardType === 'Cash Reward' ||
        reward.rewardType === 'Gift Reward' ||
        amount > 0;
    // Certificate Approved is final; cash/gift Approved without a bill still needs Accounts.
    return status === 'Approved' && isCashOrGift;
}

/** Mark all pending Reward dashboard rows for this request as done. */
export async function clearRewardDashboardBell(reward) {
    if (!reward?._id) return;
    await syncDashboardAction({
        requestId: reward._id,
        requestType: 'Reward',
        assignedTo: null,
        status: 'Approved',
        subjectEmployee: null,
        extra1: reward.rewardType,
        extra2: reward.amount ? `AED ${reward.amount}` : reward.title,
    });
}

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
                await clearRewardDashboardBell(reward);
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
