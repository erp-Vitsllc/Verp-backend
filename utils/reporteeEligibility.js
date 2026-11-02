import { hasEmployeeProfileEverBeenActivated } from "./employeeProfileStatusLock.js";

/** Left User is not an active employee, even if an older profile flag is still active. */
function isLeftUser(employee) {
    return String(employee?.status || "").trim() === "Left User";
}

/**
 * Primary / secondary reportee dropdown.
 * All three must be true: profile shows Active, Web access is on, company email is set.
 * Portal App alone does not qualify. Web still qualifies when App is also on.
 */
export function isEligibleReportee(employee) {
    if (!employee || typeof employee !== "object") return false;
    if (!hasEmployeeProfileEverBeenActivated(employee)) return false;
    if (isLeftUser(employee)) return false;
    if (employee.loginThrough?.web !== true) return false;
    return Boolean(String(employee.companyEmail || "").trim());
}
