import { buildLocatorVehicleList } from '../../services/locatorVehicleListService.js';

export const getLocatorVehicleList = async (_req, res) => {
    try {
        const data = await buildLocatorVehicleList();

        return res.status(200).json({
            success: true,
            data,
        });
    } catch (error) {
        console.error('[LocatorVehicleList] Failed:', error?.message || error);

        return res.status(502).json({
            success: false,
            message: error?.message || 'Failed to load Locator vehicle list',
        });
    }
};
