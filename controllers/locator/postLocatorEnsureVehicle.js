import { ensureLocatorErpVehicle } from '../../services/locatorVehicleListService.js';

export const postLocatorEnsureVehicle = async (req, res) => {
    try {
        const { deviceId, deviceName, plateEmirate, plateNumber } = req.body || {};

        if (deviceId == null) {
            return res.status(400).json({
                success: false,
                message: 'Locator device id is required',
            });
        }

        const asset = await ensureLocatorErpVehicle({
            deviceId,
            deviceName,
            plateEmirate,
            plateNumber,
            createdBy: req.user?._id || req.user?.id,
        });

        return res.status(200).json({
            success: true,
            data: {
                _id: asset._id,
                assetId: asset.assetId,
                name: asset.name,
                plateEmirate: asset.plateEmirate,
                plateNumber: asset.plateNumber,
                status: asset.status,
                vehicleProfileActivationStatus: asset.vehicleProfileActivationStatus,
                locatorDeviceId: asset.locatorDeviceId,
            },
        });
    } catch (error) {
        console.error('[LocatorEnsureVehicle] Failed:', error?.message || error);

        return res.status(error?.statusCode || 502).json({
            success: false,
            message: error?.message || 'Failed to ensure locator vehicle in ERP',
        });
    }
};
