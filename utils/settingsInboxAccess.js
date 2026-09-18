import { isUserActiveInFlowchart } from './getDepartmentHOD.js';
import { isJwtSystemSuperUser } from './systemSuperUser.js';

const WHATSAPP_INBOX_PAIRS = [
    ['hrm_employees_list', 'view'],
    ['hrm_employees', 'view'],
    ['hrm_employees_view', 'view'],
    ['hrm_employees_view_basic', 'view'],
];

async function viewerIsAdministrator(req) {
    const userId = req?.user?.id;
    if (!userId) return isJwtSystemSuperUser(req?.user);
    const { isUserAdministrator } = await import('../services/permissionService.js');
    return (await isUserAdministrator(userId)) || isJwtSystemSuperUser(req.user);
}

/** Active HR row in Settings → Flowchart. */
export async function viewerIsActiveFlowchartHr(req) {
    if (!req?.user) return false;
    try {
        return await isUserActiveInFlowchart(req.user, 'hr');
    } catch (error) {
        console.error('[viewerIsActiveFlowchartHr]', error?.message || error);
        return false;
    }
}

/** Super User / admin, or active flowchart HR — Notifications & Emails page. */
export async function canManageNotificationEmailPermission(req) {
    if (await viewerIsAdministrator(req)) return true;
    return viewerIsActiveFlowchartHr(req);
}

/** Admin, HR with employee view, or active flowchart HR — WhatsApp Messages inbox. */
export async function canAccessWhatsAppInbox(req) {
    if (await viewerIsAdministrator(req)) return true;
    const userId = req?.user?.id;
    if (userId) {
        const { hasPermission } = await import('../services/permissionService.js');
        for (const [moduleId, permissionType] of WHATSAPP_INBOX_PAIRS) {
            if (await hasPermission(userId, moduleId, permissionType)) return true;
        }
    }
    return viewerIsActiveFlowchartHr(req);
}
