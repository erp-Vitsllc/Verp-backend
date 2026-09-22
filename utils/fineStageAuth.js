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
 * Fine notifications: approval stages, plus Accounts Make Payment after Management approve
 * until Zoho entry or paid-by-employee is done.
 */
export function fineStillNeedsApprovalInbox(fine) {
    if (!fine) return false;
    const status = String(fine.fineStatus || '').trim();
    if (!FINE_PENDING_APPROVAL_STATUSES.has(status)) return false;
    return Boolean(getExpectedRoleForFineStatus(status, fine.workflow || []));
}

/** Zoho bill linked, vendor bill paid, or Accounts already chose Zoho / employee pay. */
export function fineAccountsSettlementDone(fine) {
    if (!fine) return false;
    const path = String(fine.accountsPaymentPath || '').trim().toLowerCase();
    if (path === 'zoho' || path === 'employee') return true;
    if (String(fine.vendorBillStatus || '').toLowerCase() === 'paid') return true;
    return Boolean(
        String(fine.zohoBillId || '').trim() || String(fine.zohoBillNumber || '').trim(),
    );
}

export function fineNeedsAccountsPaymentInbox(fine) {
    if (!fine) return false;
    const status = String(fine.fineStatus || '').trim();
    if (!['Approved', 'Active'].includes(status)) return false;
    return !fineAccountsSettlementDone(fine);
}

export function fineStillNeedsInbox(fine) {
    return fineStillNeedsApprovalInbox(fine) || fineNeedsAccountsPaymentInbox(fine);
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

const FINE_INBOX_PENDING_STATUSES = [
    'Pending HR',
    'Pending Review',
    'Pending Accounts',
    'Pending Finance',
    'Pending Authorization',
    'Pending Management',
    'Pending',
];

async function upsertFineApprovalDashboardRow(fineDoc, assignedTo, requestType = 'Fine', keepEmpId = null) {
    if (!fineDoc || !assignedTo) return;
    const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
    const DashboardAction = (await import('../models/DashboardAction.js')).default;
    const { syncDashboardAction } = await import('./syncDashboard.js');
    const targetEmpId = getTargetEmployeeIdFromFine(fineDoc);
    const subjectEmp = targetEmpId
        ? await EmployeeBasic.findOne({ employeeId: targetEmpId })
        : null;

    await syncDashboardAction({
        requestId: fineDoc._id,
        requestType,
        assignedTo,
        status: 'Pending',
        subjectEmployee: subjectEmp,
        requestedByName: fineDoc.createdBy?.name || '',
        extra1: fineDoc.fineType,
        extra2: `AED ${fineDoc.fineAmount || 0}`,
    });

    if (keepEmpId) {
        await DashboardAction.updateMany(
            {
                requestId: fineDoc._id,
                requestType: { $in: ['Fine', 'Group Fine Request'] },
                status: 'Pending',
                assignedToEmpId: { $ne: keepEmpId },
            },
            {
                $set: {
                    status: 'Dismissed',
                    actionedDate: new Date(),
                    comment: 'Reassigned to current Fine approver',
                },
            },
        );
    }
}

/**
 * When flowchart HR/Accounts/Management is reassigned, update pending workflow + dashboard
 * so the new assignee gets actions (not the old stored user id).
 * Always upserts the inbox row — missing DashboardAction is why Accounts bells stay empty
 * even when Approve/Reject still works via live flowchart HOD.
 */
export async function syncPendingFineAssigneeFromFlowchart(fineDoc, { requestType = 'Fine', assignee: presetAssignee } = {}) {
    if (!fineDoc) return fineDoc;
    if (!FINE_INBOX_PENDING_STATUSES.includes(fineDoc.fineStatus)) return fineDoc;

    const assignee = presetAssignee || await resolveCurrentStageAssignee(fineDoc);
    const assignedToId = assignee?.userId || assignee?.employeeObjectId;
    if (!assignedToId) return fineDoc;

    if (!Array.isArray(fineDoc.workflow)) fineDoc.workflow = [];
    const expectedRole = getExpectedRoleForFineStatus(fineDoc.fineStatus, fineDoc.workflow);
    let pendingStep = getPendingWorkflowStep(fineDoc.workflow, expectedRole);
    if (!pendingStep && expectedRole) {
        fineDoc.workflow.push({
            role: expectedRole,
            assignedTo: assignedToId,
            status: 'Pending',
            assignedAt: new Date(),
        });
        pendingStep = getPendingWorkflowStep(fineDoc.workflow, expectedRole);
    }
    if (!pendingStep) return fineDoc;

    const currentAssignedId =
        pendingStep.assignedTo?._id?.toString?.() ||
        pendingStep.assignedTo?.toString?.() ||
        '';
    const nextAssignedId = String(assignedToId);
    const submittedToId =
        fineDoc.submittedTo?._id?.toString?.() ||
        fineDoc.submittedTo?.toString?.() ||
        '';

    if (currentAssignedId !== nextAssignedId || submittedToId !== nextAssignedId) {
        pendingStep.assignedTo = assignedToId;
        fineDoc.submittedTo = assignedToId;
        if (typeof fineDoc.save === 'function') {
            await fineDoc.save();
        }
    }

    try {
        await upsertFineApprovalDashboardRow(fineDoc, assignedToId, requestType, assignee.employeeId);
    } catch (syncErr) {
        console.error('[syncPendingFineAssigneeFromFlowchart] Dashboard sync failed:', syncErr?.message || syncErr);
    }

    return fineDoc;
}

function viewerMatchesFlowchartHod(ctx, hod) {
    if (!hod) return false;
    return identitiesMatch(
        {
            _id: ctx.employee?._id || ctx.portalUser?._id,
            employeeId: ctx.employeeIdCode || ctx.portalUser?.employeeId,
            employeeObjectId: ctx.employee?._id || ctx.portalUser?.employeeObjectId,
        },
        {
            _id: hod._id,
            employeeId: hod.employeeId,
        },
    );
}

/**
 * Repair missing / stale Fine inbox rows for the current viewer.
 * Includes flowchart HODs (Accounts especially) who can approve but are not
 * stored on workflow.assignedTo / DashboardAction.assignedTo.
 */
export async function backfillFineApprovalInboxForViewer(ctx) {
    if (!ctx?.ok) return;

    const Fine = (await import('../models/Fine.js')).default;
    const pendingQuery = { fineStatus: { $in: FINE_INBOX_PENDING_STATUSES } };
    const found = [];

    if (ctx.relevantIds?.length) {
        const workflowAssigned = await Fine.find({
            ...pendingQuery,
            workflow: {
                $elemMatch: {
                    status: 'Pending',
                    assignedTo: { $in: ctx.relevantIds },
                },
            },
        }).limit(100);
        found.push(...workflowAssigned);
    }

    const [hrHod, accountsHod, mgmtHod] = await Promise.all([
        getDepartmentHOD('hr'),
        getDepartmentHOD('finance'),
        getManagementHOD(),
    ]);

    const flowchartStatuses = [];
    if (viewerMatchesFlowchartHod(ctx, hrHod)) {
        flowchartStatuses.push('Pending HR', 'Pending Review', 'Pending');
    }
    if (viewerMatchesFlowchartHod(ctx, accountsHod)) {
        flowchartStatuses.push('Pending Accounts', 'Pending Finance');
    }
    if (viewerMatchesFlowchartHod(ctx, mgmtHod)) {
        flowchartStatuses.push('Pending Authorization', 'Pending Management');
    }

    if (flowchartStatuses.length) {
        const flowchartAssigned = await Fine.find({
            fineStatus: { $in: flowchartStatuses },
        }).limit(150);
        found.push(...flowchartAssigned);
    }

    const byBase = new Map();
    for (const fine of found) {
        if (!fineStillNeedsApprovalInbox(fine)) continue;
        const baseId = getFineBaseId(fine.fineId);
        if (!byBase.has(baseId)) byBase.set(baseId, []);
        byBase.get(baseId).push(fine);
    }

    const assigneeByRole = new Map();
    const assigneeForFine = async (fine) => {
        const role = getExpectedRoleForFineStatus(fine.fineStatus, fine.workflow || []);
        if (!role) return null;
        if (assigneeByRole.has(role)) return assigneeByRole.get(role);
        const resolved = await resolveCurrentStageAssignee(fine);
        assigneeByRole.set(role, resolved);
        return resolved;
    };

    for (const group of byBase.values()) {
        const primary = group.find((f) => getFineBaseId(f.fineId) === f.fineId) || group[0];
        const requestType = group.length > 1 ? 'Group Fine Request' : 'Fine';
        try {
            const assignee = await assigneeForFine(primary);
            await syncPendingFineAssigneeFromFlowchart(primary, { requestType, assignee });
        } catch (backfillErr) {
            console.error(
                '[backfillFineApprovalInboxForViewer] Inbox backfill failed:',
                primary?.fineId,
                backfillErr?.message || backfillErr,
            );
        }
    }
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
