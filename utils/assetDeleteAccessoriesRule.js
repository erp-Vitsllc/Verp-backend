/**
 * Admin may delete the whole asset (accessories included) only for terminal / loss-damage outcomes.
 * Active workflow assets (draft, assigned, pending L&D, etc.) must have accessories removed first.
 */

function normalizeAssetStatus(status) {
    return String(status || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

/** Statuses where admin delete removes the asset and all attached accessories together. */
export function adminMayDeleteAssetIncludingAccessories(item) {
    const status = normalizeAssetStatus(item?.status);
    return [
        'lost',
        'rejected',
        'end of life',
        'endoflife',
        'sold',
        'total loss',
        'totalloss',
    ].includes(status);
}

/**
 * @param {object} item - AssetItem document
 * @param {{ isAdmin?: boolean }} options
 */
export function shouldBlockAssetDeleteBecauseOfAccessories(item, { isAdmin = false } = {}) {
    const accessories = Array.isArray(item?.accessories) ? item.accessories : [];
    if (accessories.length === 0) return false;
    if (isAdmin && adminMayDeleteAssetIncludingAccessories(item)) return false;
    return true;
}

export function accessoryDeleteBlockMessage(item) {
    const count = Array.isArray(item?.accessories) ? item.accessories.length : 0;
    if (adminMayDeleteAssetIncludingAccessories(item)) {
        return `This asset has ${count} accessory(ies). Remove them before deleting, or change the asset to a final status (e.g. Lost, Rejected, End of Life) to delete everything together.`;
    }
    return 'Administrator cannot delete the asset while accessories are attached. Delete accessories first.';
}
