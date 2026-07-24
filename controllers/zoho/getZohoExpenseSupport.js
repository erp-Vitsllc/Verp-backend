import {
    fetchBillExpenseAccounts,
    fetchPaymentAccounts,
    fetchLocations,
    fetchZohoTaxes,
    fetchZohoReportingTags,
} from '../../services/zohoService.js';
import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
let supportCache = null;

export const getZohoExpenseSupport = async (req, res) => {
    try {
        const now = Date.now();
        if (supportCache && now - supportCache.at < CACHE_TTL_MS) {
            return res.status(200).json({
                success: true,
                data: supportCache.data,
                meta: { ...supportCache.meta, cached: true },
            });
        }

        const [accounts, paidThroughAccounts, locations, taxes, reportingTags] =
            await Promise.all([
                fetchBillExpenseAccounts(),
                fetchPaymentAccounts({ includeInactive: true }),
                fetchLocations(),
                fetchZohoTaxes(),
                fetchZohoReportingTags(),
            ]);

        const data = {
            accounts,
            paidThroughAccounts,
            locations,
            taxes,
            reportingTags,
        };
        const meta = {
            accountCount: accounts.length,
            paidThroughAccountCount: paidThroughAccounts.length,
            locationCount: locations.length,
            taxCount: taxes.length,
            reportingTagCount: reportingTags.length,
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
        console.error('[ZohoExpenseSupport] Failed:', error?.message || error);

        if (supportCache?.data) {
            return res.status(200).json({
                success: true,
                data: supportCache.data,
                meta: {
                    ...supportCache.meta,
                    cached: true,
                    syncError: error?.message || 'Zoho expense support failed',
                },
            });
        }

        const message = error?.message || 'Failed to fetch Zoho expense support data';
        return res.status(mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
