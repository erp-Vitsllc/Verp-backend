/**
 * Preserve deduction schedule as it was when the fine was approved / before HR edits.
 */
export function snapshotDeductionScheduleOnApproval(fine) {
    if (!fine) return;
    if (!fine.originalMonthStart) {
        fine.originalMonthStart = fine.monthStart || '';
    }
    if (fine.originalPayableDuration == null && fine.payableDuration != null) {
        fine.originalPayableDuration = fine.payableDuration;
    }
}

export function preserveOriginalDeductionScheduleBeforeEdit(fine) {
    if (!fine) return;
    if (!fine.originalMonthStart && fine.monthStart) {
        fine.originalMonthStart = fine.monthStart;
    }
    if (fine.originalPayableDuration == null && fine.payableDuration != null) {
        fine.originalPayableDuration = fine.payableDuration;
    }
}

export function scheduleFieldsAreChanging(fine, updates = {}) {
    if (!fine || !updates) return false;
    if (updates.monthStart !== undefined && String(updates.monthStart) !== String(fine.monthStart || '')) {
        return true;
    }
    if (updates.payableDuration !== undefined) {
        const next = parseInt(updates.payableDuration, 10);
        const current = parseInt(fine.payableDuration, 10);
        if (Number.isFinite(next) && next !== current) return true;
    }
    return false;
}
