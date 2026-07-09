import {
    listZohoVendorsFromDb,
    shouldSyncContactsOnRead,
    syncZohoVendorsFromApi,
} from '../../services/zohoContactSyncService.js';

function mapZohoErrorStatus(message) {
    return /not connected|not configured|re-authorize/i.test(message) ? 503 : 502;
}

export const getZohoVendors = async (req, res) => {
    try {
        let syncStats = null;
        let { data, meta } = await listZohoVendorsFromDb();

        if (shouldSyncContactsOnRead(req, data.length)) {
            syncStats = await syncZohoVendorsFromApi();
            ({ data, meta } = await listZohoVendorsFromDb());
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
        console.error('[ZohoVendors] Failed:', error?.message || error);

        const message = error?.message || 'Failed to fetch vendors from Zoho Books';

        return res.status(mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
