import { isUserInFlowchart } from './getDepartmentHOD.js';
import { isReqUserAdmin } from './sendAdminDeletionNotificationEmails.js';

/** Super User (portal admin) or active Management row in Flowchart. */
export async function canRestoreAdminDeletionArchive(reqUser) {
    if (!reqUser) return false;
    if (await isReqUserAdmin(reqUser)) return true;
    try {
        return await isUserInFlowchart(reqUser, 'management');
    } catch (e) {
        console.error('[canRestoreAdminDeletionArchive]', e?.message || e);
        return false;
    }
}

/** Page read access — same as restore (admin + flowchart management only). */
export async function canViewAdminDeletionArchive(reqUser) {
    return canRestoreAdminDeletionArchive(reqUser);
}

/** @deprecated use canRestoreAdminDeletionArchive */
export async function canAccessAdminRestore(reqUser) {
    return canRestoreAdminDeletionArchive(reqUser);
}
