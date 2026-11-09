import User from '../models/User.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';

/**
 * Flowchart Admin Officer (Settings "Admin" / admincontroller).
 * A fine created by anyone else waits for this person before the normal flow.
 */
export async function creatorIsFlowchartAdminOfficer(user) {
    if (!user) return false;
    const hod = await getDepartmentHOD('admincontroller');
    if (!hod?.employeeId) return false;

    const empId = String(user.employeeId || '').trim();
    if (empId && empId === String(hod.employeeId)) return true;

    if (hod._id && user.employeeObjectId && String(hod._id) === String(user.employeeObjectId)) {
        return true;
    }

    if (user._id) {
        const adminUser = await User.findOne({ employeeId: hod.employeeId }).select('_id').lean();
        if (adminUser && String(adminUser._id) === String(user._id)) return true;
    }

    return false;
}

export async function resolveAdminOfficerUser() {
    const hod = await getDepartmentHOD('admincontroller');
    if (!hod?.employeeId) return { hod: null, user: null };
    const user = await User.findOne({ employeeId: hod.employeeId });
    return { hod, user };
}

function targetEmployeeId(fineLike) {
    const rows = fineLike?.assignedEmployees || [];
    const real = rows.find((row) => row?.employeeId && row.employeeId !== 'VEGA-HR-0000');
    return real?.employeeId || rows[0]?.employeeId || null;
}

/**
 * Existing fine flow after the Admin Officer gate (or when Admin Officer created it).
 * Difference-style handover (HR already approved on the vehicle) goes to Management.
 * Otherwise the next person is HR.
 */
export async function applyNormalFineFlow(fineLike, { handoverHrApproval = false, append = false, actorId = null } = {}) {
    if (!fineLike) return { ok: false, message: 'Fine is missing.' };
    if (!append) fineLike.workflow = [];
    else if (!Array.isArray(fineLike.workflow)) fineLike.workflow = [];

    const applicantId = targetEmployeeId(fineLike);

    if (handoverHrApproval) {
        const hrAlready = fineLike.workflow.some((step) => step.role === 'HR' && step.status === 'Approved');
        if (!hrAlready) {
            fineLike.workflow.push({
                role: 'HR',
                assignedTo: actorId || fineLike.createdBy || null,
                status: 'Approved',
                assignedAt: new Date(),
                actionedAt: new Date(),
            });
        }

        const { getManagementHOD } = await import('./getManagementHOD.js');
        const managementHOD = await getManagementHOD(applicantId);
        if (!managementHOD?.employeeId) {
            return { ok: false, message: 'Management is not assigned in Flowchart.' };
        }
        const mgmtUser = await User.findOne({ employeeId: managementHOD.employeeId });
        if (!mgmtUser) {
            return { ok: false, message: 'Management user account was not found.' };
        }
        fineLike.fineStatus = 'Pending Authorization';
        fineLike.submittedTo = mgmtUser._id;
        const managementPending = fineLike.workflow.some(
            (step) => (step.role === 'Management' || step.role === 'CEO') && step.status === 'Pending',
        );
        if (!managementPending) {
            fineLike.workflow.push({
                role: 'Management',
                assignedTo: mgmtUser._id,
                status: 'Pending',
                assignedAt: new Date(),
            });
        }
        return { ok: true, status: 'Pending Authorization' };
    }

    const hrHOD = await getDepartmentHOD('hr', applicantId || undefined);
    if (!hrHOD?.employeeId) {
        return {
            ok: false,
            message:
                'Cannot proceed. HR Admin designation is not assigned in Flowchart. Please assign HR Admin designation in Settings > FlowChart before creating a fine request.',
        };
    }
    const hrUser = await User.findOne({ employeeId: hrHOD.employeeId });
    if (!hrUser) {
        return { ok: false, message: 'HR user account was not found.' };
    }
    fineLike.fineStatus = 'Pending HR';
    fineLike.submittedTo = hrUser._id;
    const hrPending = fineLike.workflow.some((step) => step.role === 'HR' && step.status === 'Pending');
    if (!hrPending) {
        fineLike.workflow.push({
            role: 'HR',
            assignedTo: hrUser._id,
            status: 'Pending',
            assignedAt: new Date(),
        });
    }
    return { ok: true, status: 'Pending HR' };
}

/**
 * Creator is not flowchart Admin Officer → Pending Admin (email + Approve).
 * Creator is Admin Officer → existing flow immediately.
 */
export async function applyInitialFineRoute(fineLike, { creator, handoverHrApproval = false } = {}) {
    const isOfficer = await creatorIsFlowchartAdminOfficer(creator);
    if (isOfficer) {
        return applyNormalFineFlow(fineLike, {
            handoverHrApproval,
            append: false,
            actorId: creator?._id || null,
        });
    }

    const { user } = await resolveAdminOfficerUser();
    if (!user) {
        return {
            ok: false,
            message:
                'Admin Officer is not assigned in Flowchart. Assign the Admin Officer in Settings > FlowChart before creating a fine.',
        };
    }

    fineLike.fineStatus = 'Pending Admin';
    fineLike.submittedTo = user._id;
    fineLike.workflow = [
        {
            role: 'Admin Officer',
            assignedTo: user._id,
            status: 'Pending',
            assignedAt: new Date(),
        },
    ];
    return { ok: true, status: 'Pending Admin' };
}
