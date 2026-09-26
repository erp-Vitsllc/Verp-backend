import DashboardAction from '../models/DashboardAction.js';
import {
    buildVehicleExpiryDocumentLabel,
    collectVehicleExpiryDocuments,
    isFleetVehicleAsset,
    vehicleExpiryLabelForDocType,
    vehicleExpiryLabelsForSection,
    VEHICLE_EXPIRY_DOC_LABELS,
} from './vehicleExpiryScanUtils.js';
import { cleanupVehicleExpiryNotificationsByLabels, VEHICLE_EXPIRY_REQUEST_TYPE } from './cleanupVehicleExpiryNotifications.js';

function formatExpiryDateLabel(expiryDate) {
    if (!expiryDate) return '';
    const d = new Date(expiryDate);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-GB');
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

    const liveExtra1 = new Set(
        collectVehicleExpiryDocuments(asset)
            .filter((doc) => doc.docType === 'warranty')
            .map((doc) => {
                const expLabel = formatExpiryDateLabel(doc.expiryDate);
                const label = doc.label || VEHICLE_EXPIRY_DOC_LABELS.warranty;
                return `Expiry follow-up required: ${label}${expLabel ? ` (Exp: ${expLabel})` : ''}`;
            }),
    );

    const pending = await DashboardAction.find({
        requestId: asset._id,
        requestType: VEHICLE_EXPIRY_REQUEST_TYPE,
        status: 'Pending',
        extra1: { $regex: /^Expiry follow-up required:\s*Warranty\b/i },
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
