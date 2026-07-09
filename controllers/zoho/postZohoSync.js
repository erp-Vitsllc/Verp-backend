import { syncZohoContactsFromApi } from '../../services/zohoContactSyncService.js';

function mapZohoErrorStatus(message) {
    return /not connected|not configured|re-authorize/i.test(message) ? 503 : 502;
}

export const postZohoSync = async (req, res) => {
    try {
        const type = req.body?.type || req.query?.type || 'all';
        const result = await syncZohoContactsFromApi({ type });

        return res.status(200).json({
            success: true,
            data: result,
        });
    } catch (error) {
        console.error('[ZohoSync] Failed:', error?.message || error);

        const message = error?.message || 'Failed to sync Zoho contacts';
        const status = /invalid sync type/i.test(message) ? 400 : mapZohoErrorStatus(message);

        return res.status(status).json({
            success: false,
            message,
        });
    }
};
