import { fetchLiveByImei } from '../../services/locatorService.js';

export const getLocatorLiveByImei = async (req, res) => {
    try {
        const imei = req.body?.imei || req.query?.imei;
        const data = await fetchLiveByImei(imei);

        return res.status(200).json({
            success: true,
            data,
        });
    } catch (error) {
        console.error('[LocatorLiveByImei] Failed:', error?.message || error);

        const message = error?.message || 'Failed to fetch live Locator data';
        const status =
            error?.statusCode || (/not configured/i.test(message) ? 503 : /IMEI is required/i.test(message) ? 400 : 502);

        return res.status(status).json({
            success: false,
            message,
            retryAfterSec: error?.retryAfterSec,
        });
    }
};
