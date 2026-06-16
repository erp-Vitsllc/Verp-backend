import { getDepartmentHOD } from './getDepartmentHOD.js';
import { resolveAssetControllerEmployee } from './assetApprovalHelpers.js';
import { sendAssetServiceEmail } from './sendAssetServiceEmail.js';

async function loadEmployeeWithReportee(id) {
    if (!id) return null;
    const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
    return EmployeeBasic.findById(id)
        .select('firstName lastName employeeId companyEmail workEmail primaryReportee')
        .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail')
        .lean();
}

function pushUnique(list, emp) {
    if (!emp?._id) return;
    const id = String(emp._id);
    if (list.some((r) => String(r._id) === id)) return;
    list.push(emp);
}

function pushHod(list, emp) {
    const hod = emp?.primaryReportee;
    if (hod && typeof hod === 'object' && hod._id) {
        pushUnique(list, hod);
    }
}

function isSameEmployee(a, b) {
    if (!a?._id || !b?._id) return false;
    return String(a._id) === String(b._id);
}

/**
 * Notify asset controller, assignee, initiator, and HODs for service start / live events.
 * - Started (assigned): AC initiates → assignee + both HODs; assignee initiates → AC + both HODs.
 * - Started (unassigned): AC only may initiate → AC HOD.
 * - Done: AC, assignee (if any), initiator, HOD of assignee, HOD of AC.
 */
export async function notifyAssetServiceStakeholderEmails({
    asset,
    type,
    details = {},
    initiator,
    initiatorIsAssetController = false,
}) {
    if (!asset || !type) return { sent: 0 };

    const acRaw = await getDepartmentHOD('assetcontroller');
    const ac = await resolveAssetControllerEmployee(acRaw);
    const acFull = ac ? await loadEmployeeWithReportee(ac._id) : null;

    const assigneeId = asset.assignedTo?._id || asset.assignedTo;
    const assignee = assigneeId ? await loadEmployeeWithReportee(assigneeId) : null;

    const initiatorFull = initiator?._id
        ? (initiator.primaryReportee !== undefined
            ? initiator
            : await loadEmployeeWithReportee(initiator._id))
        : null;

    const acInitiated =
        initiatorIsAssetController ||
        (initiatorFull && acFull && isSameEmployee(initiatorFull, acFull));
    const assigneeInitiated =
        initiatorFull && assignee && isSameEmployee(initiatorFull, assignee);

    const recipients = [];

    if (type === 'Started') {
        if (assignee) {
            if (acInitiated) {
                pushUnique(recipients, assignee);
            } else if (assigneeInitiated && acFull) {
                pushUnique(recipients, acFull);
            } else {
                pushUnique(recipients, assignee);
                if (acFull) pushUnique(recipients, acFull);
            }
            pushHod(recipients, assignee);
        }
        if (acFull) pushHod(recipients, acFull);
    } else if (type === 'Done') {
        if (acFull) pushUnique(recipients, acFull);
        if (assignee) pushUnique(recipients, assignee);
        if (initiatorFull) pushUnique(recipients, initiatorFull);
        if (assignee) pushHod(recipients, assignee);
        if (acFull) pushHod(recipients, acFull);
    } else {
        return { sent: 0 };
    }

    const senderInfo = {
        firstName: initiatorFull?.firstName || initiator?.firstName || 'User',
        lastName: initiatorFull?.lastName || initiator?.lastName || '',
    };

    let sent = 0;
    for (const recipient of recipients) {
        try {
            const ok = await sendAssetServiceEmail({
                asset,
                recipient,
                type,
                details,
                sender: senderInfo,
            });
            if (ok) sent += 1;
        } catch (e) {
            console.error('[notifyAssetServiceStakeholderEmails]', e?.message || e);
        }
    }

    return { sent };
}
