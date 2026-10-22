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
 * A request starts with the primary reportee, including when that person is also HR.
 * It starts with HR only when the employee has no primary reportee.
 */
export function openingLeaveApprovalStage(reporteeId, hrId) {
    const reportee = String(reporteeId || '').trim();
    if (reportee) return LEAVE_STAGE_REPORTEE;
    return LEAVE_STAGE_HR;
}

/**
 * Rows saved before the stage field existed wait on the primary reportee.
 * A stored stage is kept, including a request HR is already reviewing.
 */
export function inferLeaveApprovalStage(record, { reporteeId = '', hrId = '' } = {}) {
    const explicit = String(record?.leaveApprovalStage || '').trim();
    if (explicit === LEAVE_STAGE_REPORTEE || explicit === LEAVE_STAGE_HR) return explicit;
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
