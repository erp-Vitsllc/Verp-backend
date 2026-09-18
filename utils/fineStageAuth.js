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

const FINE_PENDING_APPROVAL_STATUSES = new Set([
    'Pending',
    'Pending HR',
    'Pending Review',
    'Pending Accounts',
    'Pending Finance',
    'Pending Authorization',
    'Pending Management',
]);

/**
 * Fine notifications are approval-stage only (HR / Accounts / Management).
 * Completed, Approved, Paid, and post-approval payable settlement must not
 * keep a Pending Fine inbox row.
 */
export function fineStillNeedsApprovalInbox(fine) {
    if (!fine) return false;
    const status = String(fine.fineStatus || '').trim();
    if (!FINE_PENDING_APPROVAL_STATUSES.has(status)) return false;
    return Boolean(getExpectedRoleForFineStatus(status, fine.workflow || []));
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

function getFineBaseId(fineId = '') {
    const parts = String(fineId).split('-');
    if (parts.length > 3) return parts.slice(0, 3).join('-');
    return fineId;
}

function accountsAlreadyApproved(fine) {
    if (!fine) return false;
    if (fine.accountsApprovedBy) return true;
    return (fine.workflow || []).some((w) => w.role === 'Accounts' && w.status === 'Approved');
}

function hrAlreadyApproved(fine) {
    if (!fine) return false;
    if (fine.hrApprovedBy) return true;
    return (fine.workflow || []).some((w) => w.role === 'HR' && w.status === 'Approved');
}

/**
 * Fines that skipped Accounts after HR (went straight to Pending Authorization)
 * must return to Accounts so the Accounts bell and Accept/Reject buttons work.
 */
export async function repairSkippedFineAccountsStage(fineDoc) {
    if (!fineDoc) return fineDoc;

    const status = String(fineDoc.fineStatus || '');
    if (status !== 'Pending Authorization' && status !== 'Pending Management') {
        return fineDoc;
    }
    if (accountsAlreadyApproved(fineDoc) || !hrAlreadyApproved(fineDoc)) {
        return fineDoc;
    }

    const Fine = (await import('../models/Fine.js')).default;
    const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
    const { resolveFineAccountsActor } = await import('./fineAccountsPaymentFlow.js');
    const { syncDashboardAction } = await import('./syncDashboard.js');

    const { accountsHOD, accountsUser } = await resolveFineAccountsActor(fineDoc);
    if (!accountsUser?._id) {
        console.warn(`[repairSkippedFineAccountsStage] No Accounts user for ${fineDoc.fineId}`);
        return fineDoc;
    }

    const baseId = getFineBaseId(fineDoc.fineId);
    const baseIdRegex = new RegExp(`^${baseId}(-[A-Z0-9]+)?$`, 'i');
    const fines = await Fine.find({ fineId: baseIdRegex });
    const primary = fines[0] || fineDoc;

    const workflow = Array.isArray(primary.workflow) ? [...primary.workflow] : [];
    const hrEntry = workflow.find((w) => w.role === 'HR' && w.status === 'Pending');
    if (hrEntry) {
        hrEntry.status = 'Approved';
        hrEntry.actionedAt = new Date();
    }

    const nextWorkflow = workflow.filter(
        (w) => !((w.role === 'Management' || w.role === 'CEO') && w.status === 'Pending'),
    );
    if (!nextWorkflow.some((w) => w.role === 'Accounts' && w.status === 'Pending')) {
        nextWorkflow.push({
            role: 'Accounts',
            assignedTo: accountsUser._id,
            status: 'Pending',
            assignedAt: new Date(),
        });
    }

    const workflowPayload = nextWorkflow.map((w) => (typeof w.toObject === 'function' ? w.toObject() : { ...w }));
    for (const f of fines) {
        f.fineStatus = 'Pending Accounts';
        f.submittedTo = accountsUser._id;
        f.workflow = workflowPayload;
        await f.save();
    }

    try {
        const targetEmpId = getTargetEmployeeIdFromFine(primary);
        const subjectEmp = targetEmpId
            ? await EmployeeBasic.findOne({ employeeId: targetEmpId })
            : null;
        const isGroup = fines.length > 1;
        const reqType = isGroup ? 'Group Fine Request' : 'Fine';
        const subjectName = isGroup ? `Group Fine - ${fines.length} Employees` : undefined;

        await syncDashboardAction({
            requestId: primary._id,
            requestType: reqType,
            assignedTo: null,
            status: 'Approved',
            subjectEmployee: subjectEmp,
            subjectName,
        });
        await syncDashboardAction({
            requestId: primary._id,
            requestType: reqType,
            assignedTo: accountsUser._id,
            status: 'Pending',
            subjectEmployee: subjectEmp,
            subjectName,
            extra1: primary.fineType,
            extra2: `AED ${primary.fineAmount || 0}`,
        });
        console.log(`[repairSkippedFineAccountsStage] ${primary.fineId} → Pending Accounts (${accountsHOD?.employeeId || accountsUser._id})`);
    } catch (syncErr) {
        console.error('[repairSkippedFineAccountsStage] Dashboard sync failed:', syncErr?.message || syncErr);
    }

    return fines[0] || fineDoc;
}
