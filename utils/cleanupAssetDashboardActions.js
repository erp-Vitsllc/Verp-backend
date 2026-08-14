import mongoose from 'mongoose';
import DashboardAction from '../models/DashboardAction.js';
import AssetItem from '../models/AssetItem.js';
import AssetHistory from '../models/AssetHistory.js';

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
    'Vehicle Assignment Photo Review',
    'Vehicle Mortgage Close',
    'Vehicle Disposition Request',
    'Vehicle Delete Request',
    'Utility Bill Payment',
    'Utility Bill Payment Reminder',
    'Utility Contract Expiry',
    'Utility Entry Status Change',
];

/** Fleet vehicle dashboard bell / vehicle-scope pending inbox. */
export const VEHICLE_DASHBOARD_INBOX_TYPES = [
    'Vehicle Service Request',
    'Vehicle Profile Activation',
    'Vehicle Profile Edit',
    'Vehicle Inspection',
    'Vehicle Assignment Photo Review',
    'Vehicle Mortgage Close',
    'Vehicle Disposition Request',
    'Vehicle Delete Request',
    'Vehicle Document Expiry Reminder',
    'Vehicle Profile Incomplete',
    'Asset Approval',
    'Asset Assignment',
    'Asset Return',
];

/** Pure vehicle workflow types (never Tools). Shared Asset Approval/Assignment/Return stay in both type lists and are partitioned by fleet flag. */
export const VEHICLE_ONLY_DASHBOARD_INBOX_TYPES = VEHICLE_DASHBOARD_INBOX_TYPES.filter(
    (t) => !['Asset Approval', 'Asset Assignment', 'Asset Return'].includes(t),
);

/** Tools / equipment inbox — excludes every pure Vehicle* type (fleet shared types partitioned at query time). */
export const ASSET_TOOLS_INBOX_TYPES = ASSET_DASHBOARD_INBOX_TYPES.filter(
    (t) => !VEHICLE_ONLY_DASHBOARD_INBOX_TYPES.includes(t),
);
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

function parseDashboardExtra3(extra3) {
    if (!extra3) return {};
    if (typeof extra3 === 'object') return extra3;
    try {
        return JSON.parse(String(extra3));
    } catch {
        return {};
    }
}

const HANDOVER_HISTORY_LINKED_INBOX_TYPES = new Set([
    'Vehicle Inspection',
    'Vehicle Assignment Photo Review',
    'Asset Assignment',
]);

/**
 * Drop (and permanently dismiss) pending inbox rows whose extra3.historyId
 * points at a handover that no longer exists (e.g. Super User deleted the row).
 * Always returns a new array — callers often clear the input with `.length = 0`.
 */
export async function dismissOrphanedHandoverHistoryInboxRows(rows, parseExtra3) {
    if (!Array.isArray(rows) || !rows.length) return [];
    const parse =
        typeof parseExtra3 === 'function'
            ? parseExtra3
            : (raw) => parseDashboardExtra3(raw);

    const historyIds = [];
    for (const row of rows) {
        if (!HANDOVER_HISTORY_LINKED_INBOX_TYPES.has(row?.requestType)) continue;
        const meta = parse(row.extra3);
        const hid = meta?.historyId != null ? String(meta.historyId).trim() : '';
        if (hid && mongoose.Types.ObjectId.isValid(hid)) historyIds.push(hid);
    }
    // CRITICAL: copy the array. Returning `rows` then doing `rows.length = 0` in the
    // caller would wipe Tools / Utility / bulk-assignment bells (same reference).
    if (!historyIds.length) return rows.slice();

    const existing = await AssetHistory.find({
        _id: { $in: [...new Set(historyIds)].map((id) => new mongoose.Types.ObjectId(id)) },
    })
        .select('_id')
        .lean();
    const existingSet = new Set(existing.map((h) => String(h._id)));

    const orphanIds = [];
    const kept = [];
    for (const row of rows) {
        if (!HANDOVER_HISTORY_LINKED_INBOX_TYPES.has(row?.requestType)) {
            kept.push(row);
            continue;
        }
        const meta = parse(row.extra3);
        const hid = meta?.historyId != null ? String(meta.historyId).trim() : '';
        if (hid && mongoose.Types.ObjectId.isValid(hid) && !existingSet.has(hid)) {
            orphanIds.push(row._id);
            continue;
        }
        kept.push(row);
    }

    if (orphanIds.length) {
        await DashboardAction.updateMany(
            { _id: { $in: orphanIds }, status: 'Pending' },
            {
                $set: {
                    status: 'Rejected',
                    actionedDate: new Date(),
                    comment: 'Handover record no longer exists.',
                },
            },
        ).catch(() => null);
    }

    return kept;
}

/** Permanently remove inbox rows for a deleted vehicle service request. */
export async function deleteDashboardActionsForVehicleService(assetId, serviceRecordId) {
    if (assetId == null) return;
    const oidStr = String(assetId).trim();
    if (!mongoose.Types.ObjectId.isValid(oidStr)) return;
    const oid = new mongoose.Types.ObjectId(oidStr);
    const targetServiceId = serviceRecordId ? String(serviceRecordId) : '';

    const rows = await DashboardAction.find({
        requestId: oid,
        requestType: 'Vehicle Service Request',
    })
        .select('_id extra3')
        .lean();

    const idsToDelete = rows
        .filter((row) => {
            if (!targetServiceId) return true;
            const meta = parseDashboardExtra3(row.extra3);
            if (!meta?.serviceRecordId) return false;
            return String(meta.serviceRecordId) === targetServiceId;
        })
        .map((row) => row._id);

    if (!idsToDelete.length) return;
    await DashboardAction.deleteMany({ _id: { $in: idsToDelete } });
}
