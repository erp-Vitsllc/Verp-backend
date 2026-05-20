import { getDepartmentHOD } from './getDepartmentHOD.js';
import { isReqUserAdmin } from './sendAdminDeletionNotificationEmails.js';

export async function canAccessAdminRestore(reqUser) {
    if (!reqUser) return false;
    if (await isReqUserAdmin(reqUser)) return true;

    try {
        const mgmt = await getDepartmentHOD('management');
        if (!mgmt) return false;

        const reqEmpId = String(reqUser.employeeId || '').trim().toLowerCase();
        const mgmtEmpId = String(mgmt.employeeId || '').trim().toLowerCase();
        if (reqEmpId && mgmtEmpId && reqEmpId === mgmtEmpId) return true;

        const reqMongo = String(reqUser.employeeMongoId || reqUser.employeeObjectId || '').trim();
        const mgmtMongo = String(mgmt._id || '').trim();
        if (reqMongo && mgmtMongo && reqMongo === mgmtMongo) return true;
    } catch (e) {
        console.error('[canAccessAdminRestore]', e?.message || e);
    }
    return false;
}
