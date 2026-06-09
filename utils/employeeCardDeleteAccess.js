import { isReqUserAdmin } from "./sendAdminDeletionNotificationEmails.js";
import { isActiveEmployeeProfile } from "./profileFileChangeHrNotify.js";

/**
 * Live-active profiles: admin only. Inactive/draft: route permission middleware applies.
 * @returns {Promise<object|null>} 403 response body to return, or null when allowed.
 */
export async function denyEmployeeCardDeleteUnlessAllowed(req, employeeBasic, label = "this card") {
    if (!isActiveEmployeeProfile(employeeBasic || {})) return null;
    const isAdmin = await isReqUserAdmin(req.user);
    if (!isAdmin) {
        return {
            status: 403,
            body: { message: `Only administrator can delete ${label} on an active profile.` },
        };
    }
    return null;
}
