import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';
import {
    listZohoExpensesFromDb,
    shouldSyncPurchasesOnRead,
    syncZohoExpensesChunk,
} from '../../services/zohoPurchaseSyncService.js';

export const getZohoExpenses = async (req, res) => {
    try {
        if (!shouldSyncPurchasesOnRead(req)) {
            const { data, meta } = await listZohoExpensesFromDb({ query: req.query || {} });
            return res.status(200).json({ success: true, data, meta });
        }

        const { sync: _sync, force: _force, ...query } = req.query || {};
        const chunk = await syncZohoExpensesChunk(query);

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
        console.error('[ZohoExpenses] Failed:', error?.message || error);

        try {
            const cached = await listZohoExpensesFromDb({ query: req.query || {} });
            if (cached.data.length) {
                return res.status(200).json({
                    success: true,
                    data: cached.data,
                    meta: {
                        ...cached.meta,
                        syncError: error?.message || 'Zoho expense sync failed',
                    },
                });
            }
        } catch {
            // fall through
        }

        const raw = error?.message || 'Failed to fetch expenses from Zoho Books';
        const needsReconnect = /not authorized|invalid oauth scope/i.test(raw);
        const message = needsReconnect
            ? 'Zoho expenses access is missing. Reconnect Zoho Books with ZohoBooks.expenses.READ scope.'
            : raw;

        return res.status(mapZohoErrorStatus(raw)).json({
            success: false,
            message,
            needsReconnect,
        });
    }
};
