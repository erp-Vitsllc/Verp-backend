import mongoose from 'mongoose';
import DashboardAction from '../models/DashboardAction.js';
import AssetItem from '../models/AssetItem.js';

/** Same set as asset pending inbox (DashboardAction.requestType). */
export const ASSET_DASHBOARD_INBOX_TYPES = [
    'Asset',
    'Asset Approval',
    'Asset Assignment',
    'Asset Transfer',
    'Asset Loss Damage',
    'Asset End of Life',
    'Asset Accessory',
    'Asset Accessory Approval',
    'Asset Accessory Unattach',
    'Asset Return',
    'Asset Leave',
    'Asset Owner On Duty',
    'Asset On Duty Request',
    'Asset Bulk Action',
    'Asset Overdue',
    'Vehicle Service Request',
    'Vehicle Profile Activation',
    'Vehicle Profile Edit',
    'Vehicle Inspection',
    'Vehicle Mortgage Close',
    'Vehicle Disposition Request',
];

/** Fleet vehicle dashboard bell / vehicle-scope pending inbox. */
export const VEHICLE_DASHBOARD_INBOX_TYPES = [
    'Vehicle Service Request',
    'Vehicle Profile Activation',
    'Vehicle Profile Edit',
    'Vehicle Inspection',
    'Vehicle Mortgage Close',
    'Vehicle Disposition Request',
    'Asset Approval',
];

/** Tools / equipment Asset Management inbox — excludes fleet-only vehicle service workflow. */
export const ASSET_TOOLS_INBOX_TYPES = ASSET_DASHBOARD_INBOX_TYPES.filter((t) => t !== 'Vehicle Service Request');

/**
 * Remove dashboard / bell notifications tied to a deleted asset:
 * - Rows with requestId = asset
 * - Bulk rows in extra3 that listed this asset
 * - This id on other assets' pendingActionDetails.bulkAssetIds
 * - Orphan bulk primaries with an empty bulk list after pull
 */
export async function cleanupDashboardActionsForDeletedAsset(deletedId) {
    if (deletedId == null) return;
    const oidStr = String(deletedId).trim();
    if (!mongoose.Types.ObjectId.isValid(oidStr)) return;
    const oid = new mongoose.Types.ObjectId(oidStr);

    await DashboardAction.deleteMany({ requestId: oid });

    await AssetItem.updateMany(
        { 'pendingActionDetails.bulkAssetIds': oid },
        { $pull: { 'pendingActionDetails.bulkAssetIds': oid } }
    );

    const extraCandidates = await DashboardAction.find({
        status: 'Pending',
        requestType: { $in: ASSET_DASHBOARD_INBOX_TYPES },
        extra3: { $exists: true, $nin: [null, ''] },
        requestId: { $ne: oid }
    }).lean();

    for (const da of extraCandidates) {
        if (typeof da.extra3 !== 'string' || !da.extra3.includes(oidStr)) continue;
        let parsed;
        try {
            parsed = JSON.parse(da.extra3);
        } catch {
            continue;
        }
        let changed = false;
        const pullFrom = (arr) => {
            if (!Array.isArray(arr)) return arr;
            const next = arr.filter((x) => String(x) !== oidStr);
            if (next.length !== arr.length) changed = true;
            return next;
        };
        if (Array.isArray(parsed.assetIds)) {
            parsed.assetIds = pullFrom(parsed.assetIds);
        }
        if (Array.isArray(parsed.bulkAssetIds)) {
            parsed.bulkAssetIds = pullFrom(parsed.bulkAssetIds);
        }
        if (!changed) continue;

        const lengths = [parsed.assetIds, parsed.bulkAssetIds].filter(Array.isArray).map((a) => a.length);
        const maxLen = lengths.length ? Math.max(...lengths) : 0;
        const isBulk =
            parsed.isBulk === true ||
            parsed.isBulkCreation === true ||
            parsed.isBulkAssignment === true ||
            da.requestType === 'Asset Bulk Action';

        if (isBulk && maxLen <= 1) {
            await DashboardAction.findByIdAndDelete(da._id);
        } else {
            await DashboardAction.findByIdAndUpdate(da._id, { extra3: JSON.stringify(parsed) });
        }
    }

    const emptyBulkPrimaries = await AssetItem.find({
        'pendingActionDetails.isBulk': true,
        $expr: {
            $eq: [{ $size: { $ifNull: ['$pendingActionDetails.bulkAssetIds', []] } }, 0]
        }
    })
        .select('_id')
        .lean();

    for (const row of emptyBulkPrimaries) {
        await DashboardAction.deleteMany({
            requestId: row._id,
            status: 'Pending',
            requestType: { $in: ASSET_DASHBOARD_INBOX_TYPES }
        });
    }
}
