import { getDepartmentHOD } from './getDepartmentHOD.js';
import { resolveAssetControllerEmployee } from './assetApprovalHelpers.js';
import { sendAssetServiceEmail } from './sendAssetServiceEmail.js';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';

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

function pushIfHasCompanyEmail(list, emp) {
    if (!emp?._id) return;
    const { email } = resolveEmployeeEmail(emp);
    if (!email) return;
    pushUnique(list, emp);
}

/**
 * Asset Controller + assigned owner (company email required).
 */
export async function collectAssetServiceAcAndOwnerRecipients(asset) {
    const recipients = [];

    const acRaw = await getDepartmentHOD('assetcontroller');
    const ac = acRaw ? await resolveAssetControllerEmployee(acRaw) : null;
    const acFull = ac ? await loadEmployeeWithReportee(ac._id) : null;
    pushIfHasCompanyEmail(recipients, acFull);

    const assigneeId = asset?.assignedTo?._id || asset?.assignedTo;
    const assignee = assigneeId ? await loadEmployeeWithReportee(assigneeId) : null;
    pushIfHasCompanyEmail(recipients, assignee);

    return recipients;
}

/**
 * Notify asset controller and asset owner for service lifecycle events.
 * - Started / Extended / DurationComplete: AC + owner (both parties).
 * - Done: AC + owner + initiator.
 */
export async function notifyAssetServiceStakeholderEmails({
    asset,
    type,
    details = {},
    initiator,
    initiatorIsAssetController = false,
}) {
    if (!asset || !type) return { sent: 0 };

    const initiatorFull = initiator?._id
        ? (initiator.primaryReportee !== undefined
            ? initiator
            : await loadEmployeeWithReportee(initiator._id))
        : null;

    const senderInfo = {
        firstName: initiatorFull?.firstName || initiator?.firstName || 'Asset',
        lastName: initiatorFull?.lastName || initiator?.lastName || 'Management',
    };

    const recipients = [];

    if (type === 'Started' || type === 'Extended' || type === 'DurationComplete') {
        const acAndOwner = await collectAssetServiceAcAndOwnerRecipients(asset);
        for (const r of acAndOwner) pushUnique(recipients, r);
    } else if (type === 'Done') {
        const acAndOwner = await collectAssetServiceAcAndOwnerRecipients(asset);
        for (const r of acAndOwner) pushUnique(recipients, r);
        if (initiatorFull) pushIfHasCompanyEmail(recipients, initiatorFull);
    } else {
        return { sent: 0 };
    }

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
