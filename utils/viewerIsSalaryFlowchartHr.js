import { resolveFlowchartHrEmployee } from './resolveFlowchartHrEmployee.js';
import { isUserAdministrator } from '../services/permissionService.js';
import { isReqUserAdmin } from './sendAdminDeletionNotificationEmails.js';
import { getDepartmentHOD, isUserActiveInFlowchart } from './getDepartmentHOD.js';

function employeeCodeKey(value) {
    return String(value || '').trim().replace(/\s+/g, '').toLowerCase();
}

function matchesFlowchartEmployee(req, employee) {
    if (!req?.user || !employee?._id) return false;
    const empId = String(employee._id);
    const myObj = String(req.user.employeeObjectId || req.user.empObjectId || '');
    if (myObj && myObj === empId) return true;
    const myEid = employeeCodeKey(req.user.employeeId);
    const theirEid = employeeCodeKey(employee.employeeId);
    return Boolean(myEid && theirEid && myEid === theirEid);
}

/** Flowchart HR (or admin) who may act on salary enrollment. */
export async function viewerIsSalaryFlowchartHr(req) {
    if (!req?.user) return false;
    if (await isReqUserAdmin(req.user)) return true;
    const userId = req.user.id || req.user._id;
    if (userId && (await isUserAdministrator(userId))) return true;
    const hrResolved = await resolveFlowchartHrEmployee();
    if (hrResolved.error || !hrResolved.employee?._id) return false;
    return matchesFlowchartEmployee(req, hrResolved.employee);
}

/** Settings → Flowchart Admin Officer only — not portal super-admin, not HR. */
export async function viewerIsFlowchartAdminOfficer(req) {
    if (!req?.user) return false;
    if (await isUserActiveInFlowchart(req.user, 'admincontroller')) return true;
    const admin = await getDepartmentHOD('admincontroller');
    return matchesFlowchartEmployee(req, admin);
}
