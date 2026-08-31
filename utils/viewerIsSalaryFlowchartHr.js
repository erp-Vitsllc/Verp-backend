import { resolveFlowchartHrEmployee } from './resolveFlowchartHrEmployee.js';
import { isUserAdministrator } from '../services/permissionService.js';
import { isReqUserAdmin } from './sendAdminDeletionNotificationEmails.js';

function employeeCodeKey(value) {
    return String(value || '').trim().replace(/\s+/g, '').toLowerCase();
}

/** Flowchart HR (or admin) who may act on salary enrollment. */
export async function viewerIsSalaryFlowchartHr(req) {
    if (!req?.user) return false;
    if (await isReqUserAdmin(req.user)) return true;
    const userId = req.user.id || req.user._id;
    if (userId && (await isUserAdministrator(userId))) return true;
    const hrResolved = await resolveFlowchartHrEmployee();
    if (hrResolved.error || !hrResolved.employee?._id) return false;
    const hrId = String(hrResolved.employee._id);
    const myObj = String(req.user.employeeObjectId || req.user.empObjectId || '');
    if (myObj && myObj === hrId) return true;
    const myEid = employeeCodeKey(req.user.employeeId);
    const hrEid = employeeCodeKey(hrResolved.employee.employeeId);
    return Boolean(myEid && hrEid && myEid === hrEid);
}
