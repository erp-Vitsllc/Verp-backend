/** End of Service fines are paid separately — no salary installment months. */
export function normalizeFineSourceSchedule(fineOrPayload) {
    if (!fineOrPayload || typeof fineOrPayload !== 'object') return fineOrPayload;

    const src = fineOrPayload.sourceOfIncome || 'Salary';
    if (src === 'End of Service') {
        fineOrPayload.sourceOfIncome = 'End of Service';
        fineOrPayload.payableDuration = null;
        fineOrPayload.monthStart = fineOrPayload.monthStart || '';
        return fineOrPayload;
    }

    if (fineOrPayload.payableDuration !== undefined && fineOrPayload.payableDuration !== null) {
        const duration = parseInt(fineOrPayload.payableDuration, 10);
        fineOrPayload.payableDuration =
            Number.isFinite(duration) && duration >= 1 ? duration : null;
    }

    return fineOrPayload;
}
