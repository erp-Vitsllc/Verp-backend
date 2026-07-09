import { buildLocatorDeviceOverlay } from '../../services/locatorVehicleListService.js';

export const getLocatorDeviceOverlay = async (req, res) => {
    try {
        const { deviceId } = req.params;
        const overlay = await buildLocatorDeviceOverlay(deviceId);

        return res.status(200).json({
            success: true,
            data: overlay,
        });
    } catch (error) {
        console.error('[LocatorDeviceOverlay] Failed:', error?.message || error);

        return res.status(error?.statusCode || 502).json({
            success: false,
            message: error?.message || 'Failed to load Locator overlay',
        });
    }
};
