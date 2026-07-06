import {
    buildVehicleExpiryDocumentLabel,
    isFleetVehicleAsset,
    vehicleExpiryLabelForDocType,
    vehicleExpiryLabelsForSection,
} from './vehicleExpiryScanUtils.js';
import { cleanupVehicleExpiryNotificationsByLabels } from './cleanupVehicleExpiryNotifications.js';

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
