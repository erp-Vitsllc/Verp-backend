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

    const pending = await DashboardAction.find({
        requestId: assetMongoId,
        requestType: VEHICLE_EXPIRY_REQUEST_TYPE,
        status: 'Pending',
        $or: normalizedLabels.map((label) => ({ extra1: { $regex: buildExtra1Regex(label) } })),
    })
        .select('_id')
        .lean();
    if (!pending.length) return;
    const actionIds = pending.map((row) => row._id);
    await DashboardAction.deleteMany({ _id: { $in: actionIds } });
    try {
        const { finishTasksForRemovedExpiryActions } = await import('./finishVehicleExpiryTasks.js');
        await finishTasksForRemovedExpiryActions(actionIds);
    } catch (err) {
        console.warn('[vehicle expiry] finish linked tasks:', err?.message || err);
    }
};

export { VEHICLE_EXPIRY_REQUEST_TYPE };
