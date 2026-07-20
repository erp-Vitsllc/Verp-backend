import {
    listZohoVendorsFromDb,
    syncZohoVendorsChunk,
} from '../../services/zohoContactSyncService.js';

function mapZohoErrorStatus(message) {
    return /not connected|not configured|re-authorize/i.test(message) ? 503 : 502;
}

export const getZohoVendors = async (req, res) => {
    try {
        const wantsChunkSync =
            String(req.query?.sync || '').trim() === 'true' ||
            String(req.query?.sync || '').trim() === '1' ||
            Boolean(req.query?.zohoPage) ||
            Boolean(req.query?.syncToken);

        if (!wantsChunkSync) {
            const { data, meta } = await listZohoVendorsFromDb({ query: req.query || {} });
            return res.status(200).json({
                success: true,
                data,
                meta,
            });
        }

        const { sync: _sync, ...query } = req.query || {};
        const chunk = await syncZohoVendorsChunk(query);

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
        console.error('[ZohoVendors] Failed:', error?.message || error);

        try {
            const cached = await listZohoVendorsFromDb({ query: req.query || {} });
            if (cached.data.length) {
                return res.status(200).json({
                    success: true,
                    data: cached.data,
                    meta: {
                        ...cached.meta,
                        syncError: error?.message || 'Zoho vendor sync failed',
                    },
                });
            }
        } catch {
            // fall through
        }

        const message = error?.message || 'Failed to fetch vendors from Zoho Books';

        return res.status(mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
