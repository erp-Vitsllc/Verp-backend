/**
 * Clears stuck vehicleInspectionStatus when the linked handover history is gone.
 * Keeps vehicleProfileActivationStatus unchanged (Active profile stays Active).
 */

import AssetHistory from '../models/AssetHistory.js';
import AssetItem from '../models/AssetItem.js';

/** Matches vehicleInspectionController.VEHICLE_INSPECTION_DOC_TYPE */
const VEHICLE_INSPECTION_DOC_TYPE = 'Vehicle Inspection';
const INSPECTION_STATUSES = new Set(['active', 'draft', 'pending_hr']);

function normDocType(t) {
    return String(t || '').toLowerCase().trim();
}

/**
 * @param {import('mongoose').Types.ObjectId|string} assetId
 * @returns {Promise<{ healed: boolean, asset?: object|null }>}
 */
export async function healOrphanedVehicleInspectionStatus(assetId) {
    if (!assetId) return { healed: false };

    const asset = await AssetItem.findById(assetId)
        .select(
            'vehicleInspectionStatus vehicleInspectionHandoverHistoryId documents vehicleProfileActivationStatus',
        )
        .lean();
    if (!asset) return { healed: false };

    const status = String(asset.vehicleInspectionStatus || '').toLowerCase().trim();
    if (!INSPECTION_STATUSES.has(status)) {
        return { healed: false, asset };
    }

    const linkedId = asset.vehicleInspectionHandoverHistoryId;
    if (linkedId) {
        const linkedExists = await AssetHistory.exists({ _id: linkedId });
        if (linkedExists) {
            return { healed: false, asset };
        }
    } else if (status === 'draft' || status === 'pending_hr') {
        // In-progress without a link is already incomplete for the bar; leave as-is.
        return { healed: false, asset };
    } else {
        // status === 'active' but no link — only clear when no inspection handover rows remain.
        const remainingInspection = await AssetHistory.findOne({
            assetId,
            $or: [
                { 'details.handoverKind': 'vehicle_inspection' },
                { 'details.firstInspection': true },
                { 'details.reinspection': true },
            ],
        })
            .select('_id')
            .lean();
        if (remainingInspection) {
            // Relink to surviving inspection history so status stays coherent.
            await AssetItem.updateOne(
                { _id: assetId },
                { $set: { vehicleInspectionHandoverHistoryId: remainingInspection._id } },
            );
            return {
                healed: true,
                asset: {
                    ...asset,
                    vehicleInspectionStatus: asset.vehicleInspectionStatus,
                    vehicleInspectionHandoverHistoryId: remainingInspection._id,
                },
            };
        }
    }

    const inspectionDocType = normDocType(VEHICLE_INSPECTION_DOC_TYPE);
    const nextDocs = Array.isArray(asset.documents)
        ? asset.documents.filter((d) => normDocType(d?.type) !== inspectionDocType)
        : [];

    await AssetItem.updateOne(
        { _id: assetId },
        {
            $set: {
                vehicleInspectionStatus: null,
                vehicleInspectionHandoverHistoryId: null,
                ...(Array.isArray(asset.documents) ? { documents: nextDocs } : {}),
            },
            $unset: {
                vehicleInspectionApprovedAt: 1,
                vehicleInspectionApprovedBy: 1,
                vehicleInspectionSubmittedAt: 1,
                vehicleInspectionSubmittedBy: 1,
                vehicleInspectionRequestedBy: 1,
            },
        },
    );

    return {
        healed: true,
        asset: {
            ...asset,
            vehicleInspectionStatus: null,
            vehicleInspectionHandoverHistoryId: null,
            documents: nextDocs,
        },
    };
}
