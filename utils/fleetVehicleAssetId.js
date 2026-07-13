import AssetItem from '../models/AssetItem.js';

export const FLEET_VEHICLE_ASSET_ID_PREFIX = 'VEGA-VHCL-';
export const TOOLS_ASSET_ID_PREFIX = 'VEGA-ASSET-';

/**
 * Mongo filter for fleet vehicles only.
 * Do NOT match schema defaults that apply to every AssetItem (including tools):
 * - vehicleProfileActivationStatus default: 'inactive'
 * - vehicleDispositionStatus default: 'active'
 */
export function buildFleetVehicleMongoScope({ vehicleTypeIds = [] } = {}) {
    return {
        $or: [
            { plateNumber: { $exists: true, $nin: [null, ''] } },
            { vehicleBrand: { $exists: true, $nin: [null, ''] } },
            { vehicleCode: { $exists: true, $nin: [null, ''] } },
            { plateEmirate: { $exists: true, $nin: [null, ''] } },
            { locatorDeviceId: { $ne: null } },
            { assetId: { $regex: new RegExp(`^${FLEET_VEHICLE_ASSET_ID_PREFIX}`, 'i') } },
            { vehicleProfileActivationStatus: { $in: ['submitted', 'active', 'rejected'] } },
            { vehicleDispositionStatus: { $in: ['sold', 'total loss'] } },
            { vehicleInspectionStatus: { $exists: true, $nin: [null, '', 'none'] } },
            ...(vehicleTypeIds.length ? [{ typeId: { $in: vehicleTypeIds } }] : []),
        ],
    };
}

export async function generateNextFleetVehicleAssetId() {
    const prefix = FLEET_VEHICLE_ASSET_ID_PREFIX;
    const regex = new RegExp(`^${prefix}\\d+$`);
    const lastItem = await AssetItem.findOne({ assetId: { $regex: regex } }).sort({ assetId: -1 });

    let startingNum = 1;
    if (lastItem?.assetId) {
        const numericPart = parseInt(lastItem.assetId.substring(prefix.length), 10);
        if (Number.isFinite(numericPart)) startingNum = numericPart + 1;
    }

    return `${prefix}${String(startingNum).padStart(3, '0')}`;
}
