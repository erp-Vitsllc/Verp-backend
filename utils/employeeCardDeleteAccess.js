import { isReqUserAdmin } from "./sendAdminDeletionNotificationEmails.js";
import { isActiveEmployeeProfile } from "./profileFileChangeHrNotify.js";

const NON_DELETABLE_PROFILE_SECTIONS = new Set([
    "workDetails",
    "personal",
    "permanentAddress",
    "currentAddress",
    "emergencyContact",
    "bank",
    "salary",
]);

/** Core employee profile data cannot be deleted once saved (edit only). */
export function denyCoreEmployeeProfileDelete(sectionKey, label = "this section") {
    if (!NON_DELETABLE_PROFILE_SECTIONS.has(sectionKey)) return null;
    return {
        status: 403,
        body: { message: `${label} cannot be deleted once saved on the employee profile.` },
    };
}

/**
 * Live-active profiles: admin only. Inactive/draft: route permission middleware applies.
 * @returns {Promise<object|null>} 403 response body to return, or null when allowed.
 */
export async function denyEmployeeCardDeleteUnlessAllowed(req, employeeBasic, label = "this card", sectionKey = null) {
    const coreDenied = denyCoreEmployeeProfileDelete(sectionKey, label);
    if (coreDenied) return coreDenied;

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
