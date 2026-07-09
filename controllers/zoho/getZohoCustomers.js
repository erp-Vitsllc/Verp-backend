import {
    listZohoCustomersFromDb,
    shouldSyncContactsOnRead,
    syncZohoCustomersFromApi,
} from '../../services/zohoContactSyncService.js';

function mapZohoErrorStatus(message) {
    return /not connected|not configured|re-authorize/i.test(message) ? 503 : 502;
}

export const getZohoCustomers = async (req, res) => {
    try {
        let syncStats = null;
        let { data, meta } = await listZohoCustomersFromDb();

        if (shouldSyncContactsOnRead(req, data.length)) {
            syncStats = await syncZohoCustomersFromApi();
            ({ data, meta } = await listZohoCustomersFromDb());
        }

        return res.status(200).json({
            success: true,
            data,
            meta: {
                ...meta,
                sync: syncStats,
            },
        });
    } catch (error) {
        console.error('[ZohoCustomers] Failed:', error?.message || error);

        const message = error?.message || 'Failed to fetch customers from Zoho Books';

        return res.status(mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
