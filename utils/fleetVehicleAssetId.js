import AssetItem from '../models/AssetItem.js';

export const FLEET_VEHICLE_ASSET_ID_PREFIX = 'VEGA-VHCL-';

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
