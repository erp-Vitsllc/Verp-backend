/**
 * Human-readable stage label for reward DashboardAction.extra1
 * so the Rewards bell inbox shows track steps clearly.
 */
export function rewardStageBellLabel(role, { rewardType, rewardStatus } = {}) {
    const normalizedRole = String(role || '').trim();

    switch (normalizedRole) {
        case 'Requester':
            return 'Send for Approval';
        case 'Manager':
            return 'Awaiting Reportee approval';
        case 'Accounts':
            return 'Pending Accounts review';
        case 'Management':
            return 'Pending Management authorization';
        case 'HR':
            return 'Pending HR review';
        default:
            return rewardType || 'Reward approval required';
    }
}
