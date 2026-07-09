import { fetchLatestPositions } from '../../services/locatorService.js';

export const getLocatorLatestPositions = async (_req, res) => {
    try {
        const data = await fetchLatestPositions();

        return res.status(200).json({
            success: true,
            data,
        });
    } catch (error) {
        console.error('[LocatorLatestPositions] Failed:', error?.message || error);

        const message = error?.message || 'Failed to fetch latest positions from Locator';
        const status = error?.statusCode || (/not configured/i.test(message) ? 503 : 502);

        return res.status(status).json({
            success: false,
            message,
            retryAfterSec: error?.retryAfterSec,
        });
    }
};
