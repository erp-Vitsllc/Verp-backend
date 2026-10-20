import {
    fetchPaymentAccounts,
    fetchLocations,
    fetchZohoCurrencies,
    fetchLatestJournalEntryNumber,
    getZohoOrganizationId,
} from '../../services/zohoService.js';
import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';

/**
 * Support data for Zoho Books → Accountant → New Journal.
 */
export const getZohoJournalSupport = async (req, res) => {
    try {
        const [accounts, locations, currencies, numbering] = await Promise.all([
            fetchPaymentAccounts({ includeInactive: false }),
            fetchLocations(),
            fetchZohoCurrencies(),
            fetchLatestJournalEntryNumber().catch(() => ({ last: '', next: '' })),
        ]);

        return res.status(200).json({
            success: true,
            data: {
                accounts,
                locations,
                currencies,
                nextJournalNumber: numbering.next || '',
                lastJournalNumber: numbering.last || '',
            },
            meta: { organizationId: String(getZohoOrganizationId() || '').trim() },
        });
    } catch (error) {
        const status = mapZohoErrorStatus(error?.message || '') || error?.statusCode || 502;
        return res.status(status).json({
            success: false,
            message: error?.message || 'Failed to load Zoho journal form data.',
        });
    }
};
