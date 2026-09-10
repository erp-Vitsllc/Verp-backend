/**
 * Employee-facing financial lists: only fully approved / settled records.
 * Anything still pending with HR, Accounts, Authorization, or payout is hidden.
 */
export function isSettledApprovedStatus(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return false;
    if (s.includes('pending') || s.includes('draft') || s.includes('reject') || s.includes('cancel')) {
        return false;
    }
    return (
        s === 'approved' ||
        s.startsWith('approved') ||
        s === 'paid' ||
        s.includes('(paid)') ||
        s === 'active' ||
        s === 'completed' ||
        s === 'recovered'
    );
}

export function allStatusesSettled(...values) {
    const list = values.map((v) => String(v || '').trim()).filter(Boolean);
    if (!list.length) return false;
    return list.every(isSettledApprovedStatus);
}

export function loanIsVisibleToEmployee(item) {
    return allStatusesSettled(item?.approvalStatus, item?.status);
}

export function rewardIsVisibleToEmployee(item) {
    return allStatusesSettled(item?.rewardStatus, item?.approvalStatus);
}

export function fineIsVisibleToEmployee(item, employeeId) {
    if (!isSettledApprovedStatus(item?.fineStatus)) return false;
    const entry = (item?.assignedEmployees || []).find((ae) => ae.employeeId === employeeId);
    const assignee = String(entry?.approvalStatus || '').trim().toLowerCase();
    if (!assignee) return true;
    if (assignee.includes('reject')) return false;
    if (assignee.includes('pending authorization')) return false;
    return true;
}

export function utilityBillIsVisibleToEmployee(item) {
    return isSettledApprovedStatus(item?.status);
}
