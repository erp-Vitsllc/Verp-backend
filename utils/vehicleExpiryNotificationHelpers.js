import DashboardAction from '../models/DashboardAction.js';
import AssetItem from '../models/AssetItem.js';
import {
    buildVehicleExpiryDocumentLabel,
    collectVehicleExpiryDocuments,
    isFleetVehicleAsset,
    vehicleExpiryLabelForDocType,
    vehicleExpiryLabelsForSection,
    VEHICLE_EXPIRY_DOC_LABELS,
} from './vehicleExpiryScanUtils.js';
import { cleanupVehicleExpiryNotificationsByLabels, VEHICLE_EXPIRY_REQUEST_TYPE } from './cleanupVehicleExpiryNotifications.js';
import { formatExpiryDateLabel } from './processDocumentExpiryReminders.js';

const WARRANTY_EXTRA1 = /^Expiry follow-up required:\s*Warranty\b/i;

function liveWarrantyExtra1Set(asset) {
    return new Set(
        collectVehicleExpiryDocuments(asset)
            .filter((doc) => doc.docType === 'warranty')
            .map((doc) => {
                const expLabel = formatExpiryDateLabel(doc.expiryDate);
                const label = doc.label || VEHICLE_EXPIRY_DOC_LABELS.warranty;
                return `Expiry follow-up required: ${label}${expLabel ? ` (Exp: ${expLabel})` : ''}`;
            }),
    );
}

export async function clearVehicleExpiryNotificationsForSection(asset, sectionId) {
    if (!asset?._id || !isFleetVehicleAsset(asset)) return;
    const labels = vehicleExpiryLabelsForSection(sectionId);
    if (!labels.length) return;
    await cleanupVehicleExpiryNotificationsByLabels({
        assetMongoId: asset._id,
        labels,
    });
}

export async function clearVehicleExpiryNotificationsForDocument(asset, docOrType) {
    if (!asset?._id || !isFleetVehicleAsset(asset)) return;
    let label = null;
    if (typeof docOrType === 'string') {
        label = vehicleExpiryLabelForDocType(docOrType);
    } else if (docOrType && typeof docOrType === 'object') {
        label = buildVehicleExpiryDocumentLabel(docOrType);
    }
    if (!label) return;
    await cleanupVehicleExpiryNotificationsByLabels({
        assetMongoId: asset._id,
        labels: [label],
    });
}

/** Drop warranty expiry tasks that no longer match a live warranty card. */
export async function clearStaleVehicleWarrantyExpiryNotifications(asset) {
    if (!asset?._id || !isFleetVehicleAsset(asset)) return;

    const liveExtra1 = liveWarrantyExtra1Set(asset);

    const pending = await DashboardAction.find({
        requestId: asset._id,
        requestType: VEHICLE_EXPIRY_REQUEST_TYPE,
        status: 'Pending',
        extra1: { $regex: WARRANTY_EXTRA1 },
    })
        .select('_id extra1')
        .lean();

    const staleIds = pending
        .filter((row) => !liveExtra1.has(String(row?.extra1 || '').trim()))
        .map((row) => row._id);

    if (staleIds.length) {
        await DashboardAction.deleteMany({ _id: { $in: staleIds } });
    }
}

/**
 * Remove warranty expiry bells that no longer match a live warranty card
 * (not renew, renew, or the card is gone). Other pending rows are left as-is.
 */
export async function dropStaleVehicleWarrantyExpiryInboxRows(rows = []) {
    const warrantyRows = (rows || []).filter(
        (row) =>
            row?.requestType === VEHICLE_EXPIRY_REQUEST_TYPE &&
            WARRANTY_EXTRA1.test(String(row?.extra1 || '').trim()),
    );
    if (!warrantyRows.length) return rows;

    const assetIds = [...new Set(warrantyRows.map((row) => String(row.requestId || '')).filter(Boolean))];
    const assets = assetIds.length
        ? await AssetItem.find({ _id: { $in: assetIds } })
              .select(
                  'plateNumber vehicleBrand vehicleProfileActivationStatus vehicleDispositionStatus documents typeId',
              )
              .populate('typeId', 'name')
              .lean()
        : [];
    const byId = new Map(assets.map((asset) => [String(asset._id), asset]));

    const staleIds = [];
    for (const row of warrantyRows) {
        const asset = byId.get(String(row.requestId || ''));
        const live = asset ? liveWarrantyExtra1Set(asset) : new Set();
        if (!live.has(String(row.extra1 || '').trim())) staleIds.push(row._id);
    }
    if (!staleIds.length) return rows;

    await DashboardAction.deleteMany({ _id: { $in: staleIds } });
    const stale = new Set(staleIds.map((id) => String(id)));
    return rows.filter((row) => !stale.has(String(row?._id)));
}
