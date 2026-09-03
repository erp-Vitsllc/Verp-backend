import { isUserActiveInFlowchart, isUserInFlowchart } from './getDepartmentHOD.js';
import { isReqUserAdmin } from './sendAdminDeletionNotificationEmails.js';

export function isSalaryEnrollmentResetArchive(archive) {
    const type = String(archive?.restoreDescriptor?.type || archive?.entityType || '').trim();
    return type === 'salary_enrollment_reset';
}

async function viewerIsFlowchartHr(reqUser) {
    if (!reqUser) return false;
    try {
        return await isUserActiveInFlowchart(reqUser, 'hr');
    } catch (e) {
        console.error('[viewerIsFlowchartHr]', e?.message || e);
        return false;
    }
}

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

/** Admin / Management, or flowchart HR for salary enrolment reset snapshots. */
export async function canRestoreArchiveItem(reqUser, archive) {
    if (await canRestoreAdminDeletionArchive(reqUser)) return true;
    if (!isSalaryEnrollmentResetArchive(archive)) return false;
    return viewerIsFlowchartHr(reqUser);
}

/** Page read access — admin, flowchart management, or flowchart HR. */
export async function canViewAdminDeletionArchive(reqUser) {
    if (await canRestoreAdminDeletionArchive(reqUser)) return true;
    return viewerIsFlowchartHr(reqUser);
}

/** @deprecated use canRestoreAdminDeletionArchive */
export async function canAccessAdminRestore(reqUser) {
    return canRestoreAdminDeletionArchive(reqUser);
}
