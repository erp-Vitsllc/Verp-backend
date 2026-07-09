import { getCachedLocatorPositions } from '../../services/locatorWebSocketService.js';

export const getLocatorCachedPositions = async (_req, res) => {
    try {
        const positions = getCachedLocatorPositions();

        return res.status(200).json({
            success: true,
            data: {
                positions,
                total: positions.length,
            },
        });
    } catch (error) {
        console.error('[LocatorCachedPositions] Failed:', error?.message || error);

        return res.status(500).json({
            success: false,
            message: error?.message || 'Failed to read cached Locator positions',
        });
    }
};
