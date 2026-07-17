import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';
import {
    listZohoBillsFromDb,
    shouldSyncPurchasesOnRead,
    syncZohoBillsChunk,
} from '../../services/zohoPurchaseSyncService.js';

export const getZohoBills = async (req, res) => {
    try {
        if (!shouldSyncPurchasesOnRead(req)) {
            const { data, meta } = await listZohoBillsFromDb();
            return res.status(200).json({ success: true, data, meta });
        }

        const { sync: _sync, force: _force, ...query } = req.query || {};
        const chunk = await syncZohoBillsChunk(query);

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
        console.error('[ZohoBills] Failed:', error?.message || error);

        try {
            const cached = await listZohoBillsFromDb();
            if (cached.data.length) {
                return res.status(200).json({
                    success: true,
                    data: cached.data,
                    meta: {
                        ...cached.meta,
                        syncError: error?.message || 'Zoho bill sync failed',
                    },
                });
            }
        } catch {
            // fall through
        }

        const message = error?.message || 'Failed to fetch bills from Zoho Books';

        return res.status(mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
