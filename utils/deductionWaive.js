/** Days whose salary deduction HR can waive. The stored status stays; pay and the calendar treat the day as present. */
export const DEDUCTION_STATUS_KEYS = new Set([
    'mispunch',
    'early_go',
    'late_arrived',
    'unauthorized_leave',
    'authorized_leave',
]);

export function isDeductionWaived(row) {
    return row?.deductionWaived === true;
}

/**
 * Chosen hours on an authorized leave, as a share of one day.
 * Authorized is 1. Custom is the entered hours divided by the day.
 * 0 means nothing is deducted. Null means this leave still uses the policy.
 */
export function explicitAuthorizedHourShare(row) {
    if (!row || String(row.statusKey || '').trim() !== 'authorized_leave') return null;
    const mode = String(row.hourAdjustMode || '').trim();
    if (mode !== 'authorized' && mode !== 'custom') return null;
    if (String(row.hourAdjustStatus || '').trim() !== 'approved') return null;
    const approved = Number(row.hoursApproved);
    const taken = Number(row.hoursTaken);
    const hours = Number.isFinite(approved) && approved > 0 ? approved : 0;
    const dayHours = Number.isFinite(taken) && taken > 0 ? taken : 0;
    if (!(hours > 0)) return 0;
    if (!(dayHours > 0)) return 1;
    return hours / dayHours;
}

/** Approved hour request that sets the loss to zero. Status stays the same, and the salary cut does not. */
export function isHourLossWaived(row) {
    if (explicitAuthorizedHourShare(row) === 0) return true;
    if (String(row?.statusKey || '') === 'authorized_leave') return false;
    return String(row?.hourAdjustStatus || '') === 'approved' && !(Number(row?.hoursApproved) > 0);
}

export function deductionStatusKey(row) {
    return String(row?.statusKey || '').trim();
}

export function dayHasWaivableDeduction(row) {
    return DEDUCTION_STATUS_KEYS.has(deductionStatusKey(row));
}
