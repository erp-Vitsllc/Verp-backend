import User from "../models/User.js";

export const LEFT_USER_STATUS = "Left User";

/** Default employee list / counts exclude Left User unless explicitly filtered. */
export function buildEmployeeListStatusMatch(statusQuery) {
    const status = statusQuery ? String(statusQuery).trim() : "";
    if (status === LEFT_USER_STATUS) return { status: LEFT_USER_STATUS };
    if (status) return { status };
    return { status: { $ne: LEFT_USER_STATUS } };
}

export function isLeftUserStatus(value) {
    return String(value || "").trim() === LEFT_USER_STATUS;
}

/** Apply Left User work status and disable portal access. */
export async function applyEmployeeLeftUserStatus(employeeDoc) {
    if (!employeeDoc?.employeeId) return;

    employeeDoc.status = LEFT_USER_STATUS;
    employeeDoc.enablePortalAccess = false;
    if (String(employeeDoc.profileStatus || "").toLowerCase() === "active") {
        employeeDoc.profileStatus = "inactive";
    }
    await employeeDoc.save();

    await User.findOneAndUpdate(
        { employeeId: employeeDoc.employeeId },
        { $set: { enablePortalAccess: false } },
    );
}
