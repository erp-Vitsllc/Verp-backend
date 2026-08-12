/**
 * Persist Schedule/Reschedule submit lifecycle on service remark:
 * first save → submitted; later save → resubmitted (+ count / timestamps).
 */

export const SCHEDULE_SUBMIT_STATUS = {
    SUBMITTED: 'submitted',
    RESUBMITTED: 'resubmitted',
};

/**
 * @param {object} remark - mutable service remark object
 * @param {{ alreadySubmitted?: boolean, actorName?: string }} opts
 * @returns {{ status: string, isResubmit: boolean }}
 */
export function applyScheduleSubmitStatus(remark, { alreadySubmitted = false, actorName = '' } = {}) {
    if (!remark || typeof remark !== 'object') {
        return { status: '', isResubmit: false };
    }
    const now = new Date().toISOString();
    const prior =
        String(remark.scheduleSubmitStatus || '')
            .trim()
            .toLowerCase() === SCHEDULE_SUBMIT_STATUS.SUBMITTED ||
        String(remark.scheduleSubmitStatus || '')
            .trim()
            .toLowerCase() === SCHEDULE_SUBMIT_STATUS.RESUBMITTED ||
        Boolean(alreadySubmitted) ||
        Boolean(remark.garageSubmittedByName) ||
        Boolean(remark.assignmentSubmittedAt) ||
        Boolean(remark.oilServiceScheduledAt);

    if (prior) {
        remark.scheduleSubmitStatus = SCHEDULE_SUBMIT_STATUS.RESUBMITTED;
        remark.scheduleResubmittedAt = now;
        remark.scheduleResubmitCount = (Number(remark.scheduleResubmitCount) || 0) + 1;
        if (actorName) remark.scheduleResubmittedByName = actorName;
        return { status: SCHEDULE_SUBMIT_STATUS.RESUBMITTED, isResubmit: true };
    }

    remark.scheduleSubmitStatus = SCHEDULE_SUBMIT_STATUS.SUBMITTED;
    remark.scheduleSubmittedAt = now;
    remark.scheduleResubmitCount = Number(remark.scheduleResubmitCount) || 0;
    if (actorName) remark.scheduleSubmittedByName = actorName;
    return { status: SCHEDULE_SUBMIT_STATUS.SUBMITTED, isResubmit: false };
}
