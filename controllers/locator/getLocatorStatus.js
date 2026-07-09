import { getLocatorStatus as readLocatorStatus } from '../../services/locatorService.js';
import {
    getCachedLocatorPositions,
    getLocatorWebSocketStatus,
} from '../../services/locatorWebSocketService.js';

export const getLocatorStatus = async (_req, res) => {
    try {
        const status = await readLocatorStatus();
        const websocket = getLocatorWebSocketStatus();

        return res.status(200).json({
            success: true,
            data: {
                ...status,
                websocket,
                cachedPositionCount: getCachedLocatorPositions().length,
            },
        });
    } catch (error) {
        console.error('[LocatorStatus] Failed:', error?.message || error);

        return res.status(500).json({
            success: false,
            message: error?.message || 'Failed to read Locator status',
        });
    }
};
