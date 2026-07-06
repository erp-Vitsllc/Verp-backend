import DashboardAction from '../models/DashboardAction.js';

const escapeRegExp = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildExtra1Regex = (label) => {
    const escaped = escapeRegExp(label || '');
    return new RegExp(
        `^Expiry follow-up required:\\s*${escaped}(?:\\s*\\(Exp:\\s*[^)]+\\))?\\s*$`,
        'i',
    );
};

const VEHICLE_EXPIRY_REQUEST_TYPE = 'Vehicle Document Expiry Reminder';

/**
 * Remove pending vehicle-document expiry tasks for specific card labels.
 * Clears all expiry-date variants for the same label (same as employee profile).
 */
export const cleanupVehicleExpiryNotificationsByLabels = async ({
    assetMongoId,
    labels = [],
}) => {
    if (!assetMongoId) return;
    const normalizedLabels = [...new Set((labels || []).map((x) => String(x || '').trim()).filter(Boolean))];
    if (!normalizedLabels.length) return;

    await DashboardAction.deleteMany({
        requestId: assetMongoId,
        requestType: VEHICLE_EXPIRY_REQUEST_TYPE,
        status: 'Pending',
        $or: normalizedLabels.map((label) => ({ extra1: { $regex: buildExtra1Regex(label) } })),
    });
};

export { VEHICLE_EXPIRY_REQUEST_TYPE };
