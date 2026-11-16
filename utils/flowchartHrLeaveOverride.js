/**
 * Flowchart HR editing an already approved leave skips the employee calendar,
 * coworker, allowance, and salary-processing blocks. A new request still needs
 * the explicit HR override flag. Other roles never skip those checks.
 */
export function flowchartHrMayOverrideLeaveRules({
    hrOverride = false,
    designatedHr = false,
    revisingApprovedLeave = false,
} = {}) {
    if (hrOverride) return true;
    return Boolean(designatedHr && revisingApprovedLeave);
}

export function leaveGroupIsApproved(records = []) {
    return (records || []).some((row) => String(row?.leaveRequestStatus || '') === 'approved');
}
