import User from "../models/User.js";
import { resolveEmployeeProfileStatusWrite } from "./employeeProfileStatusLock.js";

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

/** Active employees only — Left User and inactive/rejected profiles receive no notifications. */
export function isEmployeeActiveForNotifications(emp) {
    if (!emp) return false;
    if (isLeftUserStatus(emp.status)) return false;
    const profileStatus = String(emp.profileStatus || "").trim().toLowerCase();
    if (profileStatus === "inactive" || profileStatus === "rejected") return false;
    return true;
}

const LEFT_USER_PENDING_NOTIFICATION_TYPES = [
    "Employee Document Expiry Reminder",
    "Document Expiry Reminder",
    "Probation Change",
    "Profile Activation",
    "Notice Request",
    "Employee Document Not Renew",
    "Loan",
    "Reward",
    "Fine",
    "Group Fine Request",
];

/** Apply Left User work status and disable portal access. */
export async function applyEmployeeLeftUserStatus(employeeDoc) {
    if (!employeeDoc?.employeeId) return;

    employeeDoc.status = LEFT_USER_STATUS;
    employeeDoc.enablePortalAccess = false;
    employeeDoc.profileStatus = resolveEmployeeProfileStatusWrite(
        employeeDoc,
        employeeDoc.profileStatus || "inactive",
    );
    await employeeDoc.save();

    await User.findOneAndUpdate(
        { employeeId: employeeDoc.employeeId },
        { $set: { enablePortalAccess: false } },
    );

    const DashboardAction = (await import("../models/DashboardAction.js")).default;
    const employeeObjectId = employeeDoc._id;
    const employeeHumanId = employeeDoc.employeeId;

    await DashboardAction.deleteMany({
        status: "Pending",
        $or: [
            { requestId: employeeObjectId },
            { subjectEmployeeId: employeeHumanId },
            {
                assignedTo: employeeObjectId,
                requestType: { $in: LEFT_USER_PENDING_NOTIFICATION_TYPES },
            },
            {
                assignedToEmpId: employeeHumanId,
                requestType: { $in: LEFT_USER_PENDING_NOTIFICATION_TYPES },
            },
        ],
    });
}
