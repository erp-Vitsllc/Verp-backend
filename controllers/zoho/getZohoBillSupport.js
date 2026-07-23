import {
    fetchBillExpenseAccounts,
    fetchPaymentAccounts,
    fetchLocations,
} from '../../services/zohoService.js';
import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
/** Separate caches: bill-line filtered vs full Chart of Accounts */
const supportCacheByKey = new Map();

export const getZohoBillSupport = async (req, res) => {
    try {
        const wantsFullAccounts =
            String(req.query?.fullAccounts || '').trim() === 'true' ||
            String(req.query?.fullAccounts || '').trim() === '1';
        const cacheKey = wantsFullAccounts ? 'full' : 'bill';

        const now = Date.now();
        const cached = supportCacheByKey.get(cacheKey);
        if (cached && now - cached.at < CACHE_TTL_MS) {
            return res.status(200).json({
                success: true,
                data: cached.data,
                meta: {
                    ...cached.meta,
                    cached: true,
                },
            });
        }

        const [accounts, locations] = await Promise.all([
            wantsFullAccounts ? fetchPaymentAccounts() : fetchBillExpenseAccounts(),
            fetchLocations(),
        ]);

        const data = {
            accounts,
            locations,
        };
        const meta = {
            accountCount: accounts.length,
            locationCount: locations.length,
            source: 'zoho',
            cached: false,
            fullAccounts: wantsFullAccounts,
        };

        supportCacheByKey.set(cacheKey, { at: now, data, meta });

        return res.status(200).json({
            success: true,
            data,
            meta,
        });
    } catch (error) {
        console.error('[ZohoBillSupport] Failed:', error?.message || error);

        const wantsFullAccounts =
            String(req.query?.fullAccounts || '').trim() === 'true' ||
            String(req.query?.fullAccounts || '').trim() === '1';
        const cacheKey = wantsFullAccounts ? 'full' : 'bill';
        const cached = supportCacheByKey.get(cacheKey);

        if (cached?.data) {
            return res.status(200).json({
                success: true,
                data: cached.data,
                meta: {
                    ...cached.meta,
                    cached: true,
                    syncError: error?.message || 'Zoho bill support failed',
                },
            });
        }

        const message = error?.message || 'Failed to fetch Zoho bill support data';

        return res.status(mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
