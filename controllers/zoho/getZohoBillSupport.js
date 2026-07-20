import {
    fetchBillExpenseAccounts,
    fetchLocations,
} from '../../services/zohoService.js';
import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
let supportCache = null;

export const getZohoBillSupport = async (req, res) => {
    try {
        const now = Date.now();
        if (supportCache && now - supportCache.at < CACHE_TTL_MS) {
            return res.status(200).json({
                success: true,
                data: supportCache.data,
                meta: {
                    ...supportCache.meta,
                    cached: true,
                },
            });
        }

        const [accounts, locations] = await Promise.all([
            fetchBillExpenseAccounts(),
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
        };

        supportCache = { at: now, data, meta };

        return res.status(200).json({
            success: true,
            data,
            meta,
        });
    } catch (error) {
        console.error('[ZohoBillSupport] Failed:', error?.message || error);

        if (supportCache?.data) {
            return res.status(200).json({
                success: true,
                data: supportCache.data,
                meta: {
                    ...supportCache.meta,
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
