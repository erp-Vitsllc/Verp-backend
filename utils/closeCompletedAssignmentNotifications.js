import mongoose from 'mongoose';
import DashboardAction from '../models/DashboardAction.js';
import AssetItem from '../models/AssetItem.js';
import { isAcceptedAssignmentOutcomeNotification } from './isAcceptedAssignmentOutcomeNotification.js';

function parseExtra3(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(String(raw));
    } catch {
        return null;
    }
}

function validOid(raw) {
    const s = String(raw || '').trim();
    return s && mongoose.Types.ObjectId.isValid(s) ? s : '';
}

function rowActionId(row) {
    return row?._id || row?.actionId || row?.dashboardActionId || null;
}

/** True while the assignee still needs to Accept / Reject this asset. */
export function isAssignmentAcknowledgmentStillPending(asset) {
    if (!asset) return false;
    if (asset.pendingAction) return false;
    if (asset.pendingActionDetails?.vehicleHandoverFlow?.historyId) return true;
    return (
        String(asset.acceptanceStatus || '').trim() === 'Pending' &&
        ['Pending', 'Assigned'].includes(String(asset.status || '').trim())
    );
}

async function closePendingDashboardAction(id, comment) {
    if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return;
    await DashboardAction.findOneAndUpdate(
        { _id: id, status: 'Pending' },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment,
            },
        },
    ).catch(() => null);
}

async function countPendingBulkAssignmentBatch(meta, bulkAssetIds = []) {
    const gid = meta?.bulkAssignmentGroupId ? String(meta.bulkAssignmentGroupId) : '';
    if (gid) {
        const n = await AssetItem.countDocuments({
            'pendingActionDetails.bulkAssignment.groupId': gid,
            status: 'Pending',
            acceptanceStatus: 'Pending',
        });
        if (n > 0) return n;
    }
    const ids = (Array.isArray(bulkAssetIds) ? bulkAssetIds : [])
        .map((id) => validOid(id))
        .filter(Boolean);
    if (!ids.length) return 0;
    return AssetItem.countDocuments({
        _id: { $in: ids },
        status: 'Pending',
        acceptanceStatus: 'Pending',
    });
}

async function closeFinishedBulkAssignmentGroup(groupId, comment) {
    const gid = String(groupId || '').trim();
    if (!gid) return;
    const escaped = gid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rows = await DashboardAction.find({
        status: 'Pending',
        requestType: { $in: ['Asset', 'Asset Assignment'] },
        extra3: { $regex: escaped },
    })
        .select('_id extra3')
        .lean();
    for (const da of rows) {
        const meta = parseExtra3(da.extra3);
        if (meta?.isBulkAssignment === true && String(meta.bulkAssignmentGroupId || '') === gid) {
            await closePendingDashboardAction(
                da._id,
                comment || 'Auto-closed: assignment acknowledgment completed.',
            );
        }
    }
}

/**
 * Drop (and persist-close) assignment / return inbox rows whose duty is already done.
 * Used by Command Center / user-stats so completed tasks do not stay in the notification list.
 */
export async function filterAndCloseCompletedAssetDutyDashboardRows(pendingItems = []) {
    if (!Array.isArray(pendingItems) || !pendingItems.length) return pendingItems;

    const assignmentRows = [];
    const returnRows = [];
    const keptOther = [];

    for (const item of pendingItems) {
        const type = String(item.requestType || item.type || '').trim();
        if (type === 'Asset Assignment' || type === 'Asset') {
            assignmentRows.push(item);
        } else if (type === 'Asset Return') {
            returnRows.push(item);
        } else {
            keptOther.push(item);
        }
    }

    if (!assignmentRows.length && !returnRows.length) return pendingItems;

    const idSet = new Set();
    const collectId = (raw) => {
        const s = validOid(raw);
        if (s) idSet.add(s);
    };
    for (const row of [...assignmentRows, ...returnRows]) {
        collectId(row.requestId);
        const meta = parseExtra3(row.extra3);
        (Array.isArray(meta?.bulkAssetIds) ? meta.bulkAssetIds : []).forEach(collectId);
        (Array.isArray(meta?.assetIds) ? meta.assetIds : []).forEach(collectId);
    }

    const assets = idSet.size
        ? await AssetItem.find({ _id: { $in: [...idSet] } })
              .select('status acceptanceStatus pendingAction pendingActionDetails')
              .lean()
        : [];
    const assetById = new Map(assets.map((a) => [String(a._id), a]));
    const kept = [...keptOther];
    const bulkCountCache = new Map();

    for (const row of assignmentRows) {
        const meta = parseExtra3(row.extra3);
        const actionId = rowActionId(row);

        if (isAcceptedAssignmentOutcomeNotification(row)) {
            await closePendingDashboardAction(
                actionId,
                'Auto-closed: assignment-accepted notifications are not shown.',
            );
            continue;
        }
        if (meta?.assignmentOutcome === true) {
            kept.push(row);
            continue;
        }

        if (meta?.isBulkAssignment === true) {
            const cacheKey = String(
                meta.bulkAssignmentGroupId || actionId || JSON.stringify(meta.bulkAssetIds || []),
            );
            let pendingCount = bulkCountCache.get(cacheKey);
            if (pendingCount == null) {
                pendingCount = await countPendingBulkAssignmentBatch(meta, meta.bulkAssetIds);
                bulkCountCache.set(cacheKey, pendingCount);
            }
            if (pendingCount === 0) {
                await closePendingDashboardAction(
                    actionId,
                    'Auto-closed: assignment acknowledgment completed.',
                );
                continue;
            }
            kept.push(row);
            continue;
        }

        const asset = assetById.get(String(row.requestId || ''));
        if (!isAssignmentAcknowledgmentStillPending(asset)) {
            await closePendingDashboardAction(
                actionId,
                'Auto-closed: assignment acknowledgment completed.',
            );
            continue;
        }
        kept.push(row);
    }

    for (const row of returnRows) {
        const meta = parseExtra3(row.extra3);
        const actionId = rowActionId(row);
        const bulkIds = [
            ...new Set(
                []
                    .concat(Array.isArray(meta?.bulkAssetIds) ? meta.bulkAssetIds : [])
                    .concat(Array.isArray(meta?.assetIds) ? meta.assetIds : [])
                    .map((x) => validOid(x))
                    .filter(Boolean),
            ),
        ];
        let pendingReturn = 0;
        if (bulkIds.length > 1) {
            pendingReturn = await AssetItem.countDocuments({
                _id: { $in: bulkIds },
                pendingAction: 'Return Asset',
            });
        } else {
            const asset = assetById.get(String(row.requestId || ''));
            pendingReturn = String(asset?.pendingAction || '').trim() === 'Return Asset' ? 1 : 0;
        }
        if (pendingReturn === 0) {
            await closePendingDashboardAction(actionId, 'Auto-closed: return request completed.');
            continue;
        }
        kept.push(row);
    }

    return kept;
}

/**
 * After Accept / Reject, close leftover assignment bells for these assets.
 * Bulk-batch bells close only when every member has been actioned.
 */
export async function closeCompletedAssignmentNotificationsForAssets(assetIds = [], actionedBy = null) {
    const ids = [
        ...new Set(
            (Array.isArray(assetIds) ? assetIds : [assetIds])
                .map((id) => validOid(id))
                .filter(Boolean),
        ),
    ];
    if (!ids.length) return;

    const assets = await AssetItem.find({ _id: { $in: ids } })
        .select('status acceptanceStatus pendingAction pendingActionDetails')
        .lean();

    const groupIds = new Set();
    const closeSet = {
        actionedDate: new Date(),
        comment: 'Auto-closed: assignment acknowledgment completed.',
        ...(actionedBy ? { actionedBy } : {}),
    };

    for (const asset of assets) {
        const gid = asset.pendingActionDetails?.bulkAssignment?.groupId;
        if (gid) groupIds.add(String(gid));
        if (isAssignmentAcknowledgmentStillPending(asset)) continue;

        closeSet.status = String(asset.acceptanceStatus || '').trim() === 'Rejected' ? 'Rejected' : 'Approved';
        await DashboardAction.updateMany(
            {
                requestId: asset._id,
                requestType: { $in: ['Asset Assignment', 'Asset'] },
                status: 'Pending',
                $nor: [{ extra3: { $regex: '"assignmentOutcome"\\s*:\\s*true', $options: 'i' } }],
            },
            { $set: closeSet },
        ).catch(() => null);
    }

    for (const gid of groupIds) {
        const pendingLeft = await AssetItem.countDocuments({
            'pendingActionDetails.bulkAssignment.groupId': gid,
            status: 'Pending',
            acceptanceStatus: 'Pending',
        });
        if (pendingLeft === 0) {
            await closeFinishedBulkAssignmentGroup(
                gid,
                'Auto-closed: assignment acknowledgment completed.',
            );
        }
    }
}
