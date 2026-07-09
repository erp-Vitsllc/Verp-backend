import { buildLocatorFleetDashboard } from '../../services/locatorSnapshotService.js';

export const getLocatorFleetDashboard = async (_req, res) => {
    try {
        const data = await buildLocatorFleetDashboard();

        return res.status(200).json({
            success: true,
            data,
        });
    } catch (error) {
        console.error('[LocatorFleetDashboard] Failed:', error?.message || error);

        return res.status(502).json({
            success: false,
            message: error?.message || 'Failed to build Locator fleet dashboard',
        });
    }
};
