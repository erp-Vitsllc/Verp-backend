import EmployeeBasic from '../models/EmployeeBasic.js';
import User from '../models/User.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { getManagementHOD } from './getManagementHOD.js';
import { isJwtSystemSuperUser } from './systemSuperUser.js';
import { isUserAdministrator } from '../services/permissionService.js';
import { isReqUserAdmin } from './sendAdminDeletionNotificationEmails.js';
import { viewerIsSalaryFlowchartHr } from './viewerIsSalaryFlowchartHr.js';

export const SALARY_DMF_REQUEST_TYPE = 'Salary DMF Approval';

export const SALARY_DMF_STEP_DEFS = [
    { key: 'user1', label: 'User', role: 'User' },
    { key: 'accounts', label: 'Accounts', role: 'Accounts' },
    { key: 'hr', label: 'HR', role: 'HR' },
    { key: 'management', label: 'Management', role: 'Management' },
];

export const MONTH_SALARY_DMF_STEP_DEFS = [
    { key: 'accounts', label: 'Accounts', role: 'Accounts' },
    { key: 'hr', label: 'HR', role: 'HR' },
    { key: 'management', label: 'Management', role: 'Management' },
];

export function dmfError(statusCode, message) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

export function personDisplayName(row) {
    if (!row) return '';
    return `${row.firstName || ''} ${row.lastName || ''}`.trim() || row.employeeId || '';
}

export function toDmfPerson(emp) {
    if (!emp) return { employeeObjectId: null, employeeId: '', name: '' };
    return {
        employeeObjectId: emp._id || null,
        employeeId: String(emp.employeeId || '').trim(),
        name: personDisplayName(emp),
        companyEmail: String(emp.companyEmail || emp.email || '').trim(),
    };
}

function codesMatch(a, b) {
    const left = String(a || '').trim().replace(/\s+/g, '').toLowerCase();
    const right = String(b || '').trim().replace(/\s+/g, '').toLowerCase();
    return Boolean(left && right && left === right);
}

function idsMatch(a, b) {
    return Boolean(a && b && String(a) === String(b));
}

export function historicalProgressionComplete({
    joiningDate,
    verpStartDate,
    periodEnd,
    leaveComplete,
    benefitsComplete,
    cyclesVerified,
    verified,
} = {}) {
    const datesDone = Boolean(joiningDate && verpStartDate && periodEnd);
    const leaveDone = Boolean(leaveComplete);
    const benefitsDone = Boolean(benefitsComplete && cyclesVerified);
    const hrDone = Boolean(verified);
    return datesDone && leaveDone && benefitsDone && hrDone;
}

export function historicalDmfAmount(profile) {
    const cycles = Array.isArray(profile?.paymentCycles) ? profile.paymentCycles : [];
    return Number(
        cycles
            .reduce((sum, row) => {
                const leave =
                    Number(row?.leaveSalaryAmount ?? row?.leaveSalary) || 0;
                const ticket = Number(row?.ticketAmount) || 0;
                return sum + leave + ticket;
            }, 0)
            .toFixed(2),
    );
}

export function emptyDmfApproval() {
    return {
        status: 'idle',
        currentStepKey: '',
        submittedByName: '',
        submittedByUserId: null,
        submittedAt: null,
        rejectedByName: '',
        rejectedAt: null,
        rejectReason: '',
        amount: 0,
        currency: 'AED',
        billLabel: '',
        steps: [],
        zohoBillId: '',
        zohoBillNumber: '',
        zohoBillStatus: '',
        zohoOrganizationId: '',
        zohoSyncedAt: null,
        zohoSyncError: '',
        zohoSkipped: false,
    };
}

async function loadEmployeeByRef(value) {
    if (!value) return null;
    if (typeof value === 'object' && value._id && (value.firstName || value.employeeId)) {
        return value;
    }
    const id = value._id || value;
    if (id) {
        const byId = await EmployeeBasic.findById(id)
            .select('_id employeeId firstName lastName companyEmail')
            .lean();
        if (byId) return byId;
    }
    const code = String(value.employeeId || value || '').trim();
    if (!code) return null;
    return EmployeeBasic.findOne({ employeeId: code })
        .select('_id employeeId firstName lastName companyEmail')
        .lean();
}

export async function resolveViewerEmployee(req) {
    const userId = req?.user?.id || req?.user?._id;
    const user = userId
        ? await User.findById(userId).select('employeeId').lean()
        : null;
    const code = String(user?.employeeId || req?.user?.employeeId || '').trim();
    const clauses = [];
    if (req?.user?.employeeObjectId) clauses.push({ _id: req.user.employeeObjectId });
    if (req?.user?.empObjectId) clauses.push({ _id: req.user.empObjectId });
    if (code) clauses.push({ employeeId: code });
    if (!clauses.length) return null;
    return EmployeeBasic.findOne({ $or: clauses })
        .select('_id employeeId firstName lastName companyEmail reportingAuthority')
        .populate('reportingAuthority', '_id employeeId firstName lastName companyEmail')
        .lean();
}

export async function viewerCanBypassDmf(req) {
    if (!req?.user) return false;
    if (isJwtSystemSuperUser(req.user) || req.user.isAdmin === true) {
        return true;
    }
    if (await isReqUserAdmin(req.user)) return true;
    const userId = req.user.id || req.user._id;
    if (userId && (await isUserAdministrator(userId))) return true;
    return false;
}

async function requireFlowchartPerson(departmentKey, label) {
    const hod =
        departmentKey === 'management'
            ? await getManagementHOD()
            : await getDepartmentHOD(departmentKey);
    const emp = await loadEmployeeByRef(hod);
    if (!emp?._id) {
        throw dmfError(400, `${label} is not configured in the Flowchart.`);
    }
    return emp;
}

export async function resolveDmfAssignees({ req }) {
    const viewer = await resolveViewerEmployee(req);
    if (!viewer?._id) {
        throw dmfError(400, 'Your user is not linked to an employee record, so approval cannot start.');
    }

    const [accounts, hr, management] = await Promise.all([
        requireFlowchartPerson('accounts', 'Accounts'),
        requireFlowchartPerson('hr', 'HR'),
        requireFlowchartPerson('management', 'Management'),
    ]);

    return { user1: viewer, accounts, hr, management };
}

export function dropLegacyUser2Step(dmf) {
    if (!dmf || !Array.isArray(dmf.steps) || !dmf.steps.some((step) => step.key === 'user2')) {
        return dmf;
    }
    const user2 = dmf.steps.find((step) => step.key === 'user2');
    const waitingOnUser2 =
        String(dmf.status || '') === 'pending' &&
        (dmf.currentStepKey === 'user2' || user2?.status === 'pending');
    dmf.steps = dmf.steps.filter((step) => step.key !== 'user2');
    if (waitingOnUser2) {
        const accounts = dmf.steps.find((step) => step.key === 'accounts');
        if (accounts && accounts.status !== 'approved' && accounts.status !== 'rejected') {
            accounts.status = 'pending';
            dmf.currentStepKey = 'accounts';
        }
    } else if (dmf.currentStepKey === 'user2') {
        dmf.currentStepKey = dmf.steps.find((step) => step.status === 'pending')?.key || '';
    }
    return dmf;
}

export function buildInitialDmf({ assignees, amount, billLabel, actor, stepDefs } = {}) {
    const now = new Date();
    const defs =
        Array.isArray(stepDefs) && stepDefs.length ? stepDefs : SALARY_DMF_STEP_DEFS;
    const byKey = {
        user1: assignees.user1,
        accounts: assignees.accounts,
        hr: assignees.hr,
        management: assignees.management,
    };
    const firstKey = defs[0]?.key || 'accounts';

    const steps = defs.map((def) => {
        const isFirst = def.key === firstKey;
        const isUser = def.key === 'user1';
        return {
            key: def.key,
            label: def.label,
            role: def.role,
            status: isUser ? 'approved' : isFirst ? 'pending' : 'scheduled',
            assignedTo: toDmfPerson(byKey[def.key]),
            actionedByName: isUser ? actor?.name || personDisplayName(assignees.user1) : '',
            actionedByUserId: isUser ? actor?.id || null : null,
            actionedAt: isUser ? now : null,
            comment: isUser ? 'Submitted for approval' : '',
        };
    });

    const current = steps.find((step) => step.status === 'pending') || steps[0];

    return {
        ...emptyDmfApproval(),
        status: 'pending',
        currentStepKey: current?.key || firstKey,
        submittedByName: actor?.name || personDisplayName(assignees.user1),
        submittedByUserId: actor?.id || null,
        submittedAt: now,
        amount: Number(amount) || 0,
        currency: 'AED',
        billLabel: String(billLabel || '').trim(),
        steps,
    };
}

export function currentDmfStep(dmf) {
    dropLegacyUser2Step(dmf);
    const steps = Array.isArray(dmf?.steps) ? dmf.steps : [];
    const key = String(dmf?.currentStepKey || '').trim();
    if (key) {
        const match = steps.find((step) => step.key === key);
        if (match) return match;
    }
    return steps.find((step) => step.status === 'pending') || null;
}

/** User-facing payroll status: Pending → Pending Accounts → Pending HR → Pending Management → Approved. */
export function payrollApprovalStatusLabel(dmf) {
    const status = String(dmf?.status || 'idle').toLowerCase();
    if (status === 'approved') return 'Approved';
    if (status === 'pending') {
        const step = currentDmfStep(dmf);
        const key = String(step?.key || dmf?.currentStepKey || '').toLowerCase();
        if (key === 'hr') return 'Pending HR';
        if (key === 'management') return 'Pending Management';
        if (key === 'user1') return `Pending ${step?.label || 'User'}`;
        return 'Pending Accounts';
    }
    return 'Pending';
}

function personMatchesViewer(viewer, person) {
    if (!viewer || !person) return false;
    return (
        idsMatch(viewer._id, person.employeeObjectId) ||
        codesMatch(viewer.employeeId, person.employeeId)
    );
}

export async function buildDmfViewerContext(req) {
    const [viewer, canBypass, isHr] = await Promise.all([
        resolveViewerEmployee(req),
        viewerCanBypassDmf(req),
        viewerIsSalaryFlowchartHr(req).catch(() => false),
    ]);
    return { viewer, canBypass, isHr: Boolean(isHr) };
}

export function viewerCanActOnDmf(dmf, ctx) {
    if (String(dmf?.status || '') !== 'pending') return false;
    if (ctx?.canBypass) return true;
    const step = currentDmfStep(dmf);
    if (!step) return false;
    if (personMatchesViewer(ctx?.viewer, step.assignedTo)) return true;
    if (step.key === 'hr' && ctx?.isHr) return true;
    return false;
}

export function serializeDmf(dmf, { ready = false, ctx = null } = {}) {
    const row = dmf && typeof dmf === 'object' ? { ...dmf } : emptyDmfApproval();
    dropLegacyUser2Step(row);
    const status = String(row.status || 'idle') || 'idle';
    const steps = (Array.isArray(row.steps) ? row.steps : [])
        .filter((step) => step.key !== 'user2')
        .map((step) => ({
        key: step.key,
        label: step.label,
        role: step.role,
        status: step.status,
        assignedToName: step.assignedTo?.name || '',
        assignedToEmployeeId: step.assignedTo?.employeeId || '',
        actionedByName: step.actionedByName || '',
        actionedAt: step.actionedAt || null,
        comment: step.comment || '',
    }));
    const canAct = viewerCanActOnDmf(row, ctx);
    return {
        status,
        statusLabel: payrollApprovalStatusLabel(row),
        currentStepKey: row.currentStepKey || '',
        submittedByName: row.submittedByName || '',
        submittedAt: row.submittedAt || null,
        rejectedByName: row.rejectedByName || '',
        rejectedAt: row.rejectedAt || null,
        rejectReason: row.rejectReason || '',
        amount: Number(row.amount) || 0,
        currency: row.currency || 'AED',
        billLabel: row.billLabel || '',
        steps,
        zohoBillId: row.zohoBillId || '',
        zohoBillNumber: row.zohoBillNumber || '',
        zohoBillStatus: row.zohoBillStatus || '',
        zohoSyncError: row.zohoSyncError || '',
        zohoSkipped: Boolean(row.zohoSkipped),
        ready: Boolean(ready),
        canStart: Boolean(ready) && (status === 'idle' || status === 'rejected' || !status),
        canAct,
        canReject: canAct,
    };
}

export function approveCurrentDmfStep(dmf, { actor, comment } = {}) {
    dropLegacyUser2Step(dmf);
    if (String(dmf?.status || '') !== 'pending') {
        throw dmfError(400, 'This DMF is not waiting for approval.');
    }
    const step = currentDmfStep(dmf);
    if (!step) throw dmfError(400, 'No pending DMF step.');

    const now = new Date();
    step.status = 'approved';
    step.actionedByName = actor?.name || '';
    step.actionedByUserId = actor?.id || null;
    step.actionedAt = now;
    step.comment = String(comment || '').trim();

    const order = (dmf.steps || []).map((row) => row.key);
    const idx = order.indexOf(step.key);
    const nextKey = idx >= 0 ? order[idx + 1] : '';
    if (!nextKey) {
        dmf.status = 'approved';
        dmf.currentStepKey = '';
        return { completed: true, nextStep: null };
    }

    const next = (dmf.steps || []).find((row) => row.key === nextKey);
    if (next) {
        next.status = 'pending';
        dmf.currentStepKey = next.key;
        dmf.status = 'pending';
        return { completed: false, nextStep: next };
    }

    dmf.status = 'approved';
    dmf.currentStepKey = '';
    return { completed: true, nextStep: null };
}

export function rejectDmf(dmf, { actor, reason } = {}) {
    dropLegacyUser2Step(dmf);
    const why = String(reason || '').trim();
    if (!why) throw dmfError(400, 'A rejection description is required.');
    if (String(dmf?.status || '') !== 'pending') {
        throw dmfError(400, 'This DMF is not waiting for approval.');
    }
    const step = currentDmfStep(dmf);
    const now = new Date();
    if (step) {
        step.status = 'rejected';
        step.actionedByName = actor?.name || '';
        step.actionedByUserId = actor?.id || null;
        step.actionedAt = now;
        step.comment = why;
    }
    dmf.status = 'rejected';
    dmf.rejectedByName = actor?.name || '';
    dmf.rejectedAt = now;
    dmf.rejectReason = why;
    dmf.currentStepKey = step?.key || dmf.currentStepKey;
    return dmf;
}

export function pendingAssigneeEmployeeId(dmf) {
    const step = currentDmfStep(dmf);
    return step?.assignedTo?.employeeObjectId || null;
}
