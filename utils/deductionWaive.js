/** Days whose salary deduction HR can waive without changing the attendance status. */
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

/** Approved hour request that sets the loss to zero. Status stays the same, and the salary cut does not. */
export function isHourLossWaived(row) {
    if (String(row?.statusKey || '') === 'authorized_leave') return false;
    return String(row?.hourAdjustStatus || '') === 'approved' && !(Number(row?.hoursApproved) > 0);
}

export function deductionStatusKey(row) {
    return String(row?.statusKey || '').trim();
}

export function dayHasWaivableDeduction(row) {
    return DEDUCTION_STATUS_KEYS.has(deductionStatusKey(row));
}
