import { pickEffectiveEmail } from './resolveEmployeeEmail.js';

async function loadEmployeeWithReportee(id) {
    if (!id) return null;
    const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
    return EmployeeBasic.findById(id)
        .select('firstName lastName employeeId companyEmail workEmail primaryReportee status profileStatus')
        .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail status profileStatus')
        .lean();
}

function labelForEmployee(emp, fallback = 'User') {
    if (!emp) return fallback;
    return `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || emp.employeeId || fallback;
}

/**
 * Ensures Asset Controller and assignee (and optional target assignee) have a deliverable business email
 * before accessory L&D / transfer or asset L&D workflows proceed.
 */
export async function assertAssetActionStakeholderEmails({
    asset,
    assetController,
    targetAssignee = null,
    companyCoordinator = null,
}) {
    const missing = [];

    const acEmail = pickEffectiveEmail(assetController);
    if (!acEmail) missing.push('Asset Controller');

    if (asset?.assignedToType === 'Company' && asset?.assignedCompany) {
        const coord = companyCoordinator || (await import('./getDepartmentHOD.js').then((m) => m.getCompanyAssetCoordinator()));
        const coordEmail = pickEffectiveEmail(coord);
        if (!coordEmail) missing.push('company Assigned User/Admin');
    } else if (asset?.assignedTo) {
        const assigneeId = asset.assignedTo?._id || asset.assignedTo;
        const assignee = await loadEmployeeWithReportee(assigneeId);
        const assigneeEmail = pickEffectiveEmail(assignee);
        if (!assigneeEmail) missing.push(`assigned user (${labelForEmployee(assignee)})`);
    }

    if (targetAssignee) {
        const target =
            targetAssignee.primaryReportee !== undefined
                ? targetAssignee
                : await loadEmployeeWithReportee(targetAssignee._id || targetAssignee);
        const targetEmail = pickEffectiveEmail(target);
        if (!targetEmail) missing.push(`target asset assignee (${labelForEmployee(target)})`);
    }

    if (missing.length) {
        return {
            ok: false,
            message: `Cannot proceed. Company email is required for: ${missing.join(', ')}.`,
        };
    }

    return { ok: true };
}
