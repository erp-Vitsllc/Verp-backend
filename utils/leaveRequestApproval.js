export const LEAVE_STAGE_REPORTEE = 'pending_reportee';
export const LEAVE_STAGE_HR = 'pending_hr';

/** Employee requests that travel primary reportee, then HR. */
export const TWO_STEP_LEAVE_KINDS = [
    'leave',
    'yellow',
    'future_leave',
    'future_late',
    'future_early',
    'future_annual',
    'past_late',
];

const TWO_STEP_KIND_SET = new Set(TWO_STEP_LEAVE_KINDS);

export function isTwoStepLeaveKind(kind) {
    return TWO_STEP_KIND_SET.has(String(kind || '').trim());
}

/**
 * A request starts with the primary reportee.
 * It starts with HR when there is no reportee, or the reportee is HR.
 */
export function openingLeaveApprovalStage(reporteeId, hrId) {
    const reportee = String(reporteeId || '').trim();
    const hr = String(hrId || '').trim();
    if (reportee && reportee !== hr) return LEAVE_STAGE_REPORTEE;
    return LEAVE_STAGE_HR;
}

/**
 * Rows saved before the two-step field existed:
 * future authorized and annual leave were sent straight to HR.
 * Everything else was waiting on the primary reportee.
 */
export function inferLeaveApprovalStage(record, { reporteeId = '', hrId = '' } = {}) {
    const explicit = String(record?.leaveApprovalStage || '').trim();
    if (explicit === LEAVE_STAGE_REPORTEE || explicit === LEAVE_STAGE_HR) return explicit;
    const kind = String(record?.leaveRequestKind || '').trim();
    if (kind === 'future_leave' || kind === 'future_annual') return LEAVE_STAGE_HR;
    return openingLeaveApprovalStage(reporteeId, hrId);
}

export function leaveApproverCanDecide({ stage, actorId, reporteeId, hrId }) {
    const actor = String(actorId || '').trim();
    if (!actor) return false;
    if (stage === LEAVE_STAGE_HR) {
        const hr = String(hrId || '').trim();
        return Boolean(hr) && actor === hr;
    }
    if (stage === LEAVE_STAGE_REPORTEE) {
        const reportee = String(reporteeId || '').trim();
        return Boolean(reportee) && actor === reportee;
    }
    return false;
}

export function leaveApprovalPersonName(person) {
    return [person?.firstName, person?.lastName].filter(Boolean).join(' ').trim();
}
