import { isUserAdministrator } from '../services/permissionService.js';

/** Portal Super User — `.env` ADMIN_USERNAME only (not Flowchart Admin Officer). */
export const getSystemAdminUsername = () => (process.env.ADMIN_USERNAME || 'admin').toLowerCase();

export function isUsernameSystemSuperUser(username) {
    return String(username || '').trim().toLowerCase() === getSystemAdminUsername();
}

/** Sync check on req.user after auth middleware attaches isSystemSuperUser. */
export function isJwtSystemSuperUser(reqUser) {
    if (!reqUser) return false;
    if (reqUser.isSystemSuperUser === true) return true;
    return isUsernameSystemSuperUser(reqUser.username);
}

export async function isReqUserSystemSuperUser(reqUser) {
    if (!reqUser) return false;
    if (isJwtSystemSuperUser(reqUser)) return true;
    const uid = reqUser.id || reqUser._id?.toString?.();
    if (!uid) return false;
    return !!(await isUserAdministrator(uid));
}
