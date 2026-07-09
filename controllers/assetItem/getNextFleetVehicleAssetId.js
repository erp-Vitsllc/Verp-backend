import { generateNextFleetVehicleAssetId } from '../../utils/fleetVehicleAssetId.js';

export const getNextFleetVehicleAssetId = async (_req, res) => {
    try {
        const assetId = await generateNextFleetVehicleAssetId();

        return res.status(200).json({ assetId });
    } catch (error) {
        return res.status(500).json({
            message: error?.message || 'Failed to generate next fleet vehicle id',
        });
    }
};
