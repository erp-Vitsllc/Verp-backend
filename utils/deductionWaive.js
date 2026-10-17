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

export function deductionStatusKey(row) {
    return String(row?.statusKey || '').trim();
}

export function dayHasWaivableDeduction(row) {
    return DEDUCTION_STATUS_KEYS.has(deductionStatusKey(row));
}
