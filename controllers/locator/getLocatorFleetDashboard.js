import { buildLocatorFleetDashboard } from '../../services/locatorSnapshotService.js';

export const getLocatorFleetDashboard = async (req, res) => {
    try {
        const year = Number(req.query?.year) || new Date().getFullYear();
        const data = await buildLocatorFleetDashboard({ year });

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
