import { fetchBankAccounts, getZohoOrganizationId } from '../../services/zohoService.js';
import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';

/**
 * GET /zoho/bankaccounts
 * Full Zoho Banking list (bank / cash / credit card / payment clearing).
 * Requires OAuth scope ZohoBooks.banking.READ (not Chart of Accounts).
 */
export const getZohoBankAccounts = async (req, res) => {
    try {
        const includeInactive =
            String(req.query?.includeInactive || '').toLowerCase() === 'true';
        const organizationId = String(getZohoOrganizationId() || '').trim() || 'default';
        const accounts = await fetchBankAccounts({ includeInactive });

        return res.status(200).json({
            success: true,
            data: { accounts },
            meta: {
                accountCount: accounts.length,
                source: 'zoho',
                organizationId,
            },
        });
    } catch (error) {
        console.error('[ZohoBankAccounts] Failed:', error?.message || error);
        const raw = error?.message || 'Failed to fetch Zoho bank accounts';
        const needsBankingScope = /not authorized|unauthorized|code.?57/i.test(raw);
        const message = needsBankingScope
            ? 'Zoho Banking access is missing. Reconnect Zoho Books with ZohoBooks.banking.READ scope, then refresh.'
            : raw;
        return res.status(mapZohoErrorStatus(message)).json({
            success: false,
            message,
            data: { accounts: [] },
        });
    }
};
