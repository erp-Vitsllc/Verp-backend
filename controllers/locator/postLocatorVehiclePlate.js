import { saveLocatorVehiclePlate } from '../../services/locatorVehicleListService.js';

export const postLocatorVehiclePlate = async (req, res) => {
    try {
        const { deviceId, deviceName, plateEmirate, plateCode, plateDigits, erpVehicleId } = req.body || {};

        const asset = await saveLocatorVehiclePlate({
            deviceId,
            deviceName,
            plateEmirate,
            plateCode,
            plateDigits,
            erpVehicleId,
            createdBy: req.user?._id || req.user?.id,
        });

        return res.status(200).json({
            success: true,
            data: {
                _id: asset._id,
                assetId: asset.assetId,
                plateEmirate: asset.plateEmirate,
                plateNumber: asset.plateNumber,
                locatorDeviceId: asset.locatorDeviceId,
            },
        });
    } catch (error) {
        console.error('[LocatorVehiclePlate] Failed:', error?.message || error);

        return res.status(error?.statusCode || 502).json({
            success: false,
            message: error?.message || 'Failed to save locator vehicle plate',
        });
    }
};
