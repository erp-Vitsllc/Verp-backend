/** True once HR has fully activated this profile — profileStatus must never return to inactive. */
export function hasEmployeeProfileEverBeenActivated(employee = {}) {
    const profileStatus = String(employee?.profileStatus || "").toLowerCase();
    if (profileStatus === "active") return true;

    const profileApprovalStatus = String(employee?.profileApprovalStatus || "").toLowerCase();
    if (profileApprovalStatus === "active") return true;

    const workflow = Array.isArray(employee?.profileWorkflow) ? employee.profileWorkflow : [];
    return workflow.some((step) => String(step?.status || "").toLowerCase() === "active");
}

/** Use when writing profileStatus — blocks demotion to inactive after first activation. */
export function resolveEmployeeProfileStatusWrite(employee = {}, requestedStatus = "inactive") {
    const requested = String(requestedStatus || "").toLowerCase();
    if (requested === "inactive" && hasEmployeeProfileEverBeenActivated(employee)) {
        return "active";
    }
    return requestedStatus;
}
