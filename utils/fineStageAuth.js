import { getDepartmentHOD } from './getDepartmentHOD.js';
import { getManagementHOD } from './getManagementHOD.js';

const STATUS_ROLE_MAP = {
    'Pending HR': 'HR',
    'Pending Review': 'HR',
    'Pending Accounts': 'Accounts',
    'Pending Finance': 'Accounts',
    'Pending Authorization': 'Management',
    'Pending Management': 'Management',
};

function normalizeRole(role) {
    if (!role) return null;
    if (role === 'CEO') return 'Management';
    return role;
}

export function getExpectedRoleForFineStatus(fineStatus, workflow = []) {
    if (fineStatus === 'Pending') {
        const pending = (workflow || []).find((w) => w.status === 'Pending');
        return pending ? normalizeRole(pending.role) : 'HR';
    }
    return STATUS_ROLE_MAP[fineStatus] || null;
}

export function getPendingWorkflowStep(workflow = [], expectedRole = null) {
    const list = Array.isArray(workflow) ? workflow : [];
    if (expectedRole) {
        const roles =
            expectedRole === 'Management' ? ['Management', 'CEO'] : [expectedRole];
        return list.find((w) => w.status === 'Pending' && roles.includes(w.role)) || null;
    }
    return list.find((w) => w.status === 'Pending') || null;
}

export function collectIdentityIds(value) {
    if (!value) return [];
    if (typeof value === 'string' || typeof value === 'number') {
        return [String(value)];
    }
    return [
        value._id,
        value.id,
        value.employeeObjectId,
        value.employeeId,
    ]
        .filter(Boolean)
        .map(String);
}

export function identitiesMatch(a, b) {
    const aIds = collectIdentityIds(a);
    const bIds = collectIdentityIds(b);
    if (!aIds.length || !bIds.length) return false;
    return aIds.some((aid) => bIds.includes(aid));
}

function getTargetEmployeeIdFromFine(fine) {
    const realEmp = fine.assignedEmployees?.find(
        (e) => e.employeeId && e.employeeId !== 'VEGA-HR-0000',
    );
    return realEmp?.employeeId || fine.assignedEmployees?.[0]?.employeeId || fine.employeeId || null;
}

/**
 * Resolve the live flowchart assignee for the fine's current pending stage.
 */
export async function resolveCurrentStageAssignee(fine) {
    if (!fine) return null;

    const workflow = fine.workflow || [];
    const expectedRole = getExpectedRoleForFineStatus(fine.fineStatus, workflow);
    if (!expectedRole) return null;

    const targetEmployeeId = getTargetEmployeeIdFromFine(fine);
    let hod = null;

    if (expectedRole === 'HR') {
        hod = await getDepartmentHOD('hr', targetEmployeeId);
    } else if (expectedRole === 'Accounts') {
        hod = await getDepartmentHOD('finance', targetEmployeeId);
    } else if (expectedRole === 'Management') {
        hod = await getManagementHOD(targetEmployeeId);
    }

    if (!hod?.employeeId) return null;

    const User = (await import('../models/User.js')).default;
    const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;

    const [user, emp] = await Promise.all([
        User.findOne({ employeeId: hod.employeeId }).select('_id employeeId').lean(),
        EmployeeBasic.findOne({ employeeId: hod.employeeId }).select('_id employeeId').lean(),
    ]);

    return {
        role: expectedRole,
        employeeId: hod.employeeId,
        employeeObjectId: emp?._id || null,
        userId: user?._id || null,
        hod,
    };
}

function actorMatchesAssignee(actor, assignee) {
    if (!assignee) return false;
    if (assignee.userId && identitiesMatch(actor, { _id: assignee.userId })) return true;
    if (assignee.employeeId && identitiesMatch(actor, { employeeId: assignee.employeeId })) return true;
    if (assignee.employeeObjectId && identitiesMatch(actor, { _id: assignee.employeeObjectId })) return true;
    return false;
}

/**
 * Only the assignee on the current pending workflow step (or live flowchart HOD) may act.
 */
export function canUserActOnFineStage({
    user,
    fine,
    isAdmin = false,
    employeeObjectId = null,
    flowchartAssignee = null,
}) {
    if (!user || !fine) return false;
    if (isAdmin) return true;

    const workflow = fine.workflow || [];
    const expectedRole = getExpectedRoleForFineStatus(fine.fineStatus, workflow);
    const pendingStep = getPendingWorkflowStep(workflow, expectedRole);

    const actor = {
        ...user,
        employeeObjectId: employeeObjectId || user.employeeObjectId,
    };

    if (pendingStep?.assignedTo && identitiesMatch(actor, pendingStep.assignedTo)) {
        return true;
    }

    if (flowchartAssignee && actorMatchesAssignee(actor, flowchartAssignee)) {
        return true;
    }

    const flowchartEmpId = getFlowchartEmployeeIdForRole(fine, expectedRole);
    if (flowchartEmpId && identitiesMatch(actor, { employeeId: flowchartEmpId })) {
        return true;
    }

    if (!pendingStep && fine.submittedTo && identitiesMatch(actor, fine.submittedTo)) {
        return true;
    }

    return false;
}

export async function canUserActOnFineStageAsync({ user, fine, isAdmin = false, employeeObjectId = null }) {
    const flowchartAssignee = await resolveCurrentStageAssignee(fine);
    return canUserActOnFineStage({
        user,
        fine,
        isAdmin,
        employeeObjectId,
        flowchartAssignee,
    });
}

export function getFlowchartEmployeeIdForRole(fine, expectedRole) {
    if (!fine || !expectedRole) return null;
    if (expectedRole === 'HR') return fine.hrHODId || null;
    if (expectedRole === 'Accounts') return fine.accountsHODId || null;
    if (expectedRole === 'Management') return fine.ceoEmployeeId || null;
    return null;
}

/**
 * When flowchart HR/Accounts/Management is reassigned, update pending workflow + dashboard
 * so the new assignee gets actions (not the old stored user id).
 */
export async function syncPendingFineAssigneeFromFlowchart(fineDoc) {
    if (!fineDoc) return fineDoc;

    const pendingStatuses = [
        'Pending HR',
        'Pending Review',
        'Pending Accounts',
        'Pending Finance',
        'Pending Authorization',
        'Pending Management',
        'Pending',
    ];
    if (!pendingStatuses.includes(fineDoc.fineStatus)) return fineDoc;

    const assignee = await resolveCurrentStageAssignee(fineDoc);
    if (!assignee?.userId) return fineDoc;

    const workflow = fineDoc.workflow || [];
    const expectedRole = getExpectedRoleForFineStatus(fineDoc.fineStatus, workflow);
    const pendingStep = getPendingWorkflowStep(workflow, expectedRole);
    if (!pendingStep) return fineDoc;

    const currentAssignedId =
        pendingStep.assignedTo?._id?.toString?.() ||
        pendingStep.assignedTo?.toString?.() ||
        '';
    const nextAssignedId = String(assignee.userId);

    const submittedToId =
        fineDoc.submittedTo?._id?.toString?.() ||
        fineDoc.submittedTo?.toString?.() ||
        '';

    if (currentAssignedId === nextAssignedId && submittedToId === nextAssignedId) {
        return fineDoc;
    }

    pendingStep.assignedTo = assignee.userId;
    fineDoc.submittedTo = assignee.userId;
    await fineDoc.save();

    try {
        const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
        const { syncDashboardAction } = await import('./syncDashboard.js');
        const targetEmpId = getTargetEmployeeIdFromFine(fineDoc);
        const subjectEmp = targetEmpId
            ? await EmployeeBasic.findOne({ employeeId: targetEmpId })
            : null;

        await syncDashboardAction({
            requestId: fineDoc._id,
            requestType: 'Fine',
            assignedTo: assignee.userId,
            status: 'Pending',
            subjectEmployee: subjectEmp,
            requestedByName: fineDoc.createdBy?.name || '',
            extra1: fineDoc.fineType,
            extra2: `AED ${fineDoc.fineAmount || 0}`,
        });
    } catch (syncErr) {
        console.error('[syncPendingFineAssigneeFromFlowchart] Dashboard sync failed:', syncErr?.message || syncErr);
    }

    return fineDoc;
}
