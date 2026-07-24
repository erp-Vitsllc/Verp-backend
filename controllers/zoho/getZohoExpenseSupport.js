import {
    fetchBillExpenseAccounts,
    fetchPaymentAccounts,
    fetchLocations,
    fetchZohoTaxes,
    fetchZohoReportingTags,
    getZohoOrganizationId,
} from '../../services/zohoService.js';
import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
/** @type {Map<string, { at: number, data: object, meta: object }>} */
const supportCacheByOrg = new Map();

/**
 * Support data for Zoho Books → Expenses → Add Expense:
 * - accounts → Expense Account dropdown (bill/expense CoA)
 * - paidThroughAccounts → Paid Through dropdown
 */
export const getZohoExpenseSupport = async (req, res) => {
    try {
        const organizationId = String(getZohoOrganizationId() || '').trim() || 'default';
        const now = Date.now();
        const cached = supportCacheByOrg.get(organizationId);
        if (cached && now - cached.at < CACHE_TTL_MS) {
            return res.status(200).json({
                success: true,
                data: cached.data,
                meta: { ...cached.meta, cached: true, organizationId },
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
            organizationId,
        };

        supportCacheByOrg.set(organizationId, { at: now, data, meta });

        return res.status(200).json({
            success: true,
            data,
            meta,
        });
    } catch (error) {
        console.error('[ZohoExpenseSupport] Failed:', error?.message || error);

        const organizationId = String(getZohoOrganizationId() || '').trim() || 'default';
        const cached = supportCacheByOrg.get(organizationId);
        if (cached?.data) {
            return res.status(200).json({
                success: true,
                data: cached.data,
                meta: {
                    ...cached.meta,
                    cached: true,
                    organizationId,
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
