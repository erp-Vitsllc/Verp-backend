import mongoose from 'mongoose';

/**
 * Removes Vehicle Profile Activation dashboard rows in "On Hold" for an asset (e.g. resubmit after hold).
 */
export async function clearVehicleProfileActivationHoldDashboardRows(assetMongoId) {
    if (!assetMongoId) return;
    const DashboardAction = (await import('../models/DashboardAction.js')).default;
    const requestId = mongoose.Types.ObjectId.isValid(String(assetMongoId))
        ? new mongoose.Types.ObjectId(String(assetMongoId))
        : assetMongoId;
    await DashboardAction.deleteMany({
        requestId,
        requestType: 'Vehicle Profile Activation',
        status: 'On Hold',
    });
}
