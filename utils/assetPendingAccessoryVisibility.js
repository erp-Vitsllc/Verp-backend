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

/** Lost / End of Life stay in DB for catalog & history but must not appear as "attached" on the live asset (API + UI). */
export function isAccessoryExcludedFromLiveAssetView(acc, assetStatus = '') {
    const n = String(acc?.status || '').trim().toLowerCase().replace(/\s+/g, '');
    const assetNorm = String(assetStatus || '').trim().toLowerCase().replace(/\s+/g, '');
    // On a Lost parent asset, keep Lost accessories visible until manually detached.
    if (n === 'lost' && assetNorm === 'lost') return false;
    return n === 'lost' || n === 'endoflife' || n === 'eol';
}

/** Adding accessories is blocked when the parent asset is Lost or End of Life. */
export function isAssetStatusBlockingAccessoryAdd(assetStatus = '') {
    const norm = String(assetStatus || '').trim().toLowerCase().replace(/\s+/g, '');
    return norm === 'lost' || norm === 'endoflife' || norm === 'eol';
}

export function filterAccessoriesHidingPendingAdds(accessories, canSeePendingAdds, assetStatus = '') {
    if (!Array.isArray(accessories) || accessories.length === 0) return accessories || [];
    const withoutTerminal = accessories.filter((a) => !isAccessoryExcludedFromLiveAssetView(a, assetStatus));
    if (canSeePendingAdds) return withoutTerminal;
    return withoutTerminal.filter((a) => !isEmbeddedAccessoryPendingAddApproval(a));
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
