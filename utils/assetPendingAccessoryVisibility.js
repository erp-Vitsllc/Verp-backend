/**
 * Accessories added by a non–Asset-Controller user are embedded with status Pending + pendingAction Add
 * until the Asset Controller approves. Those rows must not appear in catalog sync until approved, and
 * must be hidden from API consumers who are neither the assignee nor an asset controller approver.
 */

export function normEmpIdStr(s) {
    return (s || '').toString().toLowerCase().replace(/\s+/g, '');
}

export function isEmbeddedAccessoryPendingAddApproval(acc) {
    const st = String(acc?.status || '').trim();
    const pa = String(acc?.pendingAction || '').trim();
    return st === 'Pending' && pa === 'Add';
}

export function filterAccessoriesHidingPendingAdds(accessories, canSeePendingAdds) {
    if (!Array.isArray(accessories) || accessories.length === 0) return accessories || [];
    if (canSeePendingAdds) return accessories;
    return accessories.filter((a) => !isEmbeddedAccessoryPendingAddApproval(a));
}

/**
 * @param {{ canSeeAllPending: boolean, currentEmpId: string|null, currentEmployeeIdNorm: string|null }} ctx
 * @param {object} asset — lean or populated; needs assignedTo / actionRequiredBy when canSeeAllPending is false
 */
export function computeCanSeePendingAddsForAsset(ctx, asset) {
    if (ctx.canSeeAllPending) return true;
    const cur = ctx.currentEmpId;
    if (!cur) return false;

    const assigneeRef = asset.assignedTo;
    const assigneeId = assigneeRef?._id?.toString?.() || (assigneeRef && assigneeRef.toString?.());
    if (assigneeId && assigneeId === cur) return true;

    const arRef = asset.actionRequiredBy;
    const arId = arRef?._id?.toString?.() || (arRef && arRef.toString?.());
    if (arId && arId === cur) return true;

    const curNorm = ctx.currentEmployeeIdNorm;
    if (curNorm && assigneeRef?.employeeId) {
        if (curNorm === normEmpIdStr(assigneeRef.employeeId)) return true;
    }
    if (curNorm && arRef?.employeeId) {
        if (curNorm === normEmpIdStr(arRef.employeeId)) return true;
    }
    return false;
}
