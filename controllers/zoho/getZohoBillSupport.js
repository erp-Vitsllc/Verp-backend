import {
    fetchBillExpenseAccounts,
    fetchPaymentAccounts,
    fetchLocations,
    getZohoOrganizationId,
} from '../../services/zohoService.js';
import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
/** v2 = complete CoA merge (same source as Fine / Payments Made); keyed per Zoho org */
const supportCacheByKey = new Map();

export const getZohoBillSupport = async (req, res) => {
    try {
        const wantsFullAccounts =
            String(req.query?.fullAccounts || '').trim() === 'true' ||
            String(req.query?.fullAccounts || '').trim() === '1';
        const orgId =
            String(req.query?.organizationId || '').trim() ||
            String(getZohoOrganizationId() || '').trim() ||
            'default';
        // full = every CoA row; default = bill-line safe (excludes cash/bank/AP/AR) from same source
        const cacheKey = `${orgId}:${wantsFullAccounts ? 'full-v2' : 'bill-v2'}`;

        const now = Date.now();
        const cached = supportCacheByKey.get(cacheKey);
        if (cached && now - cached.at < CACHE_TTL_MS) {
            return res.status(200).json({
                success: true,
                data: cached.data,
                meta: {
                    ...cached.meta,
                    cached: true,
                    organizationId: orgId,
                },
            });
        }

        const [accounts, locations] = await Promise.all([
            wantsFullAccounts
                ? fetchPaymentAccounts({ includeInactive: true })
                : fetchBillExpenseAccounts(),
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
            organizationId: orgId,
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
        const orgId =
            String(req.query?.organizationId || '').trim() ||
            String(getZohoOrganizationId() || '').trim() ||
            'default';
        const cacheKey = `${orgId}:${wantsFullAccounts ? 'full-v2' : 'bill-v2'}`;
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
