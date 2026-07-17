import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';
import {
    listZohoVendorPaymentsFromDb,
    shouldSyncPurchasesOnRead,
    syncZohoVendorPaymentsChunk,
} from '../../services/zohoPurchaseSyncService.js';

export const getZohoVendorPayments = async (req, res) => {
    try {
        if (!shouldSyncPurchasesOnRead(req)) {
            const { data, meta } = await listZohoVendorPaymentsFromDb();
            return res.status(200).json({ success: true, data, meta });
        }

        const { sync: _sync, force: _force, ...query } = req.query || {};
        const chunk = await syncZohoVendorPaymentsChunk(query);

        return res.status(200).json({
            success: true,
            data: chunk.data,
            meta: {
                count: chunk.data.length,
                upserted: chunk.upserted,
                deactivated: chunk.deactivated,
                hasMore: chunk.hasMore,
                nextZohoPage: chunk.nextZohoPage,
                zohoPage: chunk.zohoPage,
                chunkLimit: chunk.chunkLimit,
                syncedAt: chunk.syncedAt,
                source: 'zoho-chunk',
            },
        });
    } catch (error) {
        console.error('[ZohoVendorPayments] Failed:', error?.message || error);

        try {
            const cached = await listZohoVendorPaymentsFromDb();
            if (cached.data.length) {
                return res.status(200).json({
                    success: true,
                    data: cached.data,
                    meta: {
                        ...cached.meta,
                        syncError: error?.message || 'Zoho vendor payment sync failed',
                    },
                });
            }
        } catch {
            // fall through
        }

        const message = error?.message || 'Failed to fetch payments made from Zoho Books';

        return res.status(mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
